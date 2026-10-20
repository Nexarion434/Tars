import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { writeAtomicSync } from '../../utils/secret-file';
import { REPORT_KINDS } from './report';

/**
 * How many error reports leave one installation: the same error at most once
 * in 24 hours, and at most 20 reports in any 24 hours. Kept on disk, so a Tars
 * that crashes and is restarted in a loop does not send 20 more at each start,
 * and with it the random id the installation is known by.
 *
 * The file (`~/.dorothy/error-reports.json`, 0600) holds that id, when each
 * report of the last 24 hours left, and the fingerprint of each error sent in
 * that time with when. A file that cannot be read is started again, never a
 * reason to throw.
 *
 * Since 2.0.4 the agents' tool errors may take 10 of the 20, so that a day of
 * refused tools leaves room for a crash; and the file keeps the last report's
 * answer (when, which kind, Sentry's HTTP status), which the window reads.
 */

export const REPORTS_PER_DAY = 20;
export const AGENT_TOOL_PER_DAY = 10;
const DAY_MS = 24 * 3_600_000;

interface BudgetFile {
  installId: string;
  /** When each report of the last 24 hours left, in ms. */
  sent: number[];
  /** fingerprint -> when it last left, in ms. */
  seen: Record<string, number>;
  /** When each agent tool error of the last 24 hours left, in ms (2.0.4). */
  toolSent?: number[];
  /** The last report's answer (2.0.4): when, which kind, Sentry's HTTP status (0: none came). */
  last?: LastReport;
}

export interface LastReport {
  at: number;
  kind: string;
  status: number;
}

/** A last answer as the file holds it, or null: anything else is not taken for one. */
function lastOf(raw: unknown): LastReport | null {
  const last = raw as Partial<LastReport> | null | undefined;
  if (!last || typeof last !== 'object') return null;
  const { at, kind, status } = last;
  if (typeof at !== 'number' || !Number.isFinite(at) || typeof kind !== 'string' || !REPORT_KINDS.has(kind)) return null;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 0 || status > 599) return null;
  return { at, kind, status };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ReportBudget {
  private state: BudgetFile;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.state = this.read();
  }

  get installId(): string {
    return this.state.installId;
  }

  /** The last report's answer, or null when none was kept. */
  get last(): LastReport | null {
    return lastOf(this.state.last);
  }

  /** The last answer as `file` keeps it, read without making the file: null when there is none. */
  static readLast(file: string): LastReport | null {
    try {
      return lastOf((JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<BudgetFile>).last);
    } catch {
      return null;
    }
  }

  /** Whether a report of this error may leave now; counts it when it may. An agent tool error is held to its share too. */
  admit(fingerprint: string, kind?: string): boolean {
    return this.admitAt(fingerprint, kind) !== null;
  }

  /** As admit(), with the moment it was counted at, which refund() takes; null when it may not leave. */
  admitAt(fingerprint: string, kind?: string): number | null {
    const now = this.now();
    const since = now - DAY_MS;
    this.state.sent = this.state.sent.filter(t => t > since);
    this.state.toolSent = (this.state.toolSent ?? []).filter(t => t > since);
    for (const [fp, t] of Object.entries(this.state.seen)) if (t <= since) delete this.state.seen[fp];
    if (this.state.sent.length >= REPORTS_PER_DAY || fingerprint in this.state.seen) return null;
    const tool = kind === 'agent-tool';
    if (tool && this.state.toolSent.length >= AGENT_TOOL_PER_DAY) return null;
    this.state.sent.push(now);
    if (tool) this.state.toolSent.push(now);
    this.state.seen[fingerprint] = now;
    this.write();
    return now;
  }

  /** Keeps a report's answer as the last one: its kind, and Sentry's HTTP status (0 when none came). */
  noteAnswer(kind: string, status: number): void {
    const last = lastOf({ at: this.now(), kind, status });
    if (!last) return;
    this.state.last = last;
    this.write();
  }

  /**
   * Gives back what admit() counted, for a report that did not leave after
   * all (Sentry could not be reached): a diagnostic the user tries again
   * after a failure must not read "already sent".
   */
  refund(fingerprint: string, at: number): void {
    const index = this.state.sent.lastIndexOf(at);
    if (index !== -1) this.state.sent.splice(index, 1);
    if (this.state.seen[fingerprint] === at) delete this.state.seen[fingerprint];
    this.write();
  }

  private read(): BudgetFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<BudgetFile>;
      if (typeof parsed.installId === 'string' && UUID.test(parsed.installId)) {
        const seen: Record<string, number> = {};
        for (const [fp, t] of Object.entries(parsed.seen ?? {})) if (typeof t === 'number') seen[fp] = t;
        const times = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is number => typeof t === 'number') : []);
        const last = lastOf(parsed.last);
        return {
          installId: parsed.installId,
          sent: times(parsed.sent),
          seen,
          toolSent: times(parsed.toolSent),
          ...(last ? { last } : {}),
        };
      }
    } catch { /* none yet, or unreadable: a new one */ }
    this.state = { installId: randomUUID(), sent: [], seen: {} };
    this.write();
    return this.state;
  }

  private write(): void {
    try {
      writeAtomicSync(this.file, JSON.stringify(this.state), 0o600);
    } catch (err) {
      console.warn('[error-reports] could not record the reports sent:', err instanceof Error ? err.message : err);
    }
  }
}
