/**
 * The line Settings shows beside "Send error reports" (2.0.4): when the last report left, which kind it was,
 * and what Sentry answered, from main's errorReports:last (frames `Settings · Preferences · error reports, the
 * last report`). Nothing else of what the report carried. Its tests: __tests__/lib/error-report-line.test.ts.
 */

export interface LastReportAnswer {
  /** When Sentry answered, ISO. */
  at: string;
  kind: string;
  /** Sentry's HTTP status; 0 when none came. */
  status: number;
}

const KIND_WORDS: Record<string, string> = {
  error: 'uncaught',
  handled: 'handled',
  'agent-tool': 'agent tool',
  'abrupt-end': 'abrupt end',
  diagnostic: 'diagnostic',
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const twoDigits = (n: number) => String(n).padStart(2, '0');

/** Local calendar days between two times: 0 the same day, 1 the day before. */
function daysBetween(then: Date, now: Date): number {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(now) - start(then)) / DAY);
}

/** "3 min ago", "today at 09:05", "yesterday at 18:02", "2 days ago"; null for a time that is not one. */
function whenSaid(at: string, nowMs: number): string | null {
  const then = new Date(at);
  if (Number.isNaN(then.getTime())) return null;
  const elapsed = nowMs - then.getTime();
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < 60 * MINUTE) return `${Math.floor(elapsed / MINUTE)} min ago`;
  const days = daysBetween(then, new Date(nowMs));
  const clock = `${twoDigits(then.getHours())}:${twoDigits(then.getMinutes())}`;
  if (days <= 0) return `today at ${clock}`;
  if (days === 1) return `yesterday at ${clock}`;
  return `${days} days ago`;
}

export function lastReportLine(last: LastReportAnswer | null | undefined, nowMs: number = Date.now()): string {
  if (!last) return 'No report sent yet';
  const when = whenSaid(last.at, nowMs);
  const kind = KIND_WORDS[last.kind] ?? last.kind.replace(/-/g, ' ');
  const answer = last.status === 0 ? 'no answer from Sentry' : `Sentry answered ${last.status}`;
  return `Last report${when ? `: ${when}` : ''} (${kind}), ${answer}`;
}
