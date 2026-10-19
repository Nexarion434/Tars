import * as os from 'os';
import * as path from 'path';
import { app, ipcMain } from 'electron';
import { DATA_DIR } from '../../constants';
import { ReportBudget } from './budget';
import { errorReportOptions } from './options';
import { randomUUID } from 'crypto';
import { agentToolEvent, healthEvent, reportFingerprint, toReport, UNKNOWN_TOOL, type AgentToolError, type HealthKind, type ReportFacts } from './report';
import { setReportSinks, watchLoggedErrors, withoutWords } from './handled';
import { errorReportsAvailable } from '../../platform/error-reports';

/**
 * Error reports to Sentry, off unless the user turns them on in Settings
 * (`errorReportsEnabled`, default false). Step 1 of PLAN-RELAIS-SENTRY.md.
 *
 * Off, the SDK is not even loaded: no handler, no IPC listener, nothing on
 * the network. Turned on, at start or while Tars runs, it is loaded and
 * started once for the run. Turned off again, it stays loaded and sends
 * nothing: options.ts reads the setting at each event and again as each
 * envelope is about to leave. Only what report.ts lists can leave, at most
 * once a day for the same error and 20 a day (budget.ts).
 *
 * Started with none of the SDK's defaults: no native crash dumps (they hold
 * process memory), no screenshots, no breadcrumbs of network requests or
 * console lines, no sessions, no preload injected into windows, no
 * OpenTelemetry, and no offline queue on disk that would send later. The
 * renderer's errors come through Tars's own preload (IPCMode.Classic): the
 * window is sandboxed and cannot load the SDK's preload.
 *
 * Since 2.0.4 (F1 to F4 of the maintainer's go of 2026-10-18): the errors Tars
 * handles leave through the same gates (handled.ts: what main logs at error
 * level, an API route's 500, a CLI that exits at its launch), and the agents'
 * tool errors as a kind of their own (report.ts); a line says the reports are
 * on, and one per report what Sentry answered, the last answer kept for the
 * window; and the SDK is handed main's onFatalError, so it never shows
 * Electron's error box (core/uncaught-guard.ts).
 */

/** Tars's Sentry project (the maintainer's organisation, EU). A DSN is public by design: it only lets a client send. */
export const ERROR_REPORTS_DSN = 'https://d3d853ef128291b07daad0c136b0c82d@o4511321063620608.ingest.de.sentry.io/4512140890996816';

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

function facts(budget: ReportBudget, agentTools?: ReportFacts['agentTools']): ReportFacts {
  return {
    agentTools,
    installId: budget.installId,
    release: `tars@${app.getVersion()}`,
    home: os.homedir(),
    host: os.hostname(),
    os: {
      name: OS_NAMES[process.platform] ?? process.platform,
      version: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release(),
    },
    electron: process.versions.electron ?? '',
  };
}

/**
 * Where reports go. A development run may point them at a stand-in
 * (DOROTHY_ERROR_REPORTS_DSN), for the proof against a fake Sentry; a packaged
 * Tars never reads it.
 */
function dsn(): string {
  const override = app.isPackaged ? undefined : process.env.DOROTHY_ERROR_REPORTS_DSN;
  return override || ERROR_REPORTS_DSN;
}

/** The SDK's IPCMode.Classic channels, which the preload's `__SENTRY_IPC__` sends on. */
const RENDERER_CHANNELS = 'sentry-ipc.';
const ENVELOPE_CHANNEL = 'sentry-ipc.envelope';
/** Far above any error report (report.ts caps one at a few tens of kilobytes). */
const MAX_ENVELOPE = 1_000_000;

type Listener = (...args: unknown[]) => unknown;

function dropped(channel: string, why: unknown): void {
  // The name only: the payload, and a parser's message quoting it, may hold anything.
  const reason = why instanceof Error ? why.name : String(why);
  console.warn(`[error-reports] dropped what the renderer sent on ${channel}: ${reason}`);
}

/**
 * The SDK's listeners for what the renderer sends, behind a guard. Their
 * input is the renderer's, and the SDK parses it with no try: a malformed
 * envelope threw out of an ipcMain listener, which is an uncaught exception
 * in main, a fatal report of its own, then Electron's error box holding the
 * process until it was killed (QA's gate of #221). An envelope that is not
 * text or bytes, or is larger than any report, never reaches the SDK; what
 * throws in its listener is logged and dropped. Other channels are not
 * touched.
 */
function guardRendererBridge(): void {
  for (const channel of ipcMain.eventNames()) {
    if (typeof channel !== 'string' || !channel.startsWith(RENDERER_CHANNELS)) continue;
    const listeners = ipcMain.listeners(channel) as Listener[];
    ipcMain.removeAllListeners(channel);
    ipcMain.on(channel, (event, ...args) => {
      if (channel === ENVELOPE_CHANNEL) {
        const env = args[0];
        const fits = (typeof env === 'string' && env.length <= MAX_ENVELOPE)
          || (env instanceof Uint8Array && env.byteLength <= MAX_ENVELOPE);
        if (!fits) return dropped(channel, 'not an envelope, or too large');
      }
      for (const listener of listeners) {
        try {
          const result = listener(event, ...args);
          if (result instanceof Promise) result.catch(err => dropped(channel, err));
        } catch (err) {
          dropped(channel, err);
        }
      }
    });
  }
}

/** What a health report's send answers: sent, or why not, in a sentence the window shows as is. */
export type HealthSendResult = { sent: true } | { sent: false; reason: string };

export const HEALTH_REFUSALS = {
  windows: 'Error reports are not available on Windows yet.',
  off: 'Turn on Send error reports in Settings to send a diagnostic.',
  budget: 'A diagnostic was already sent in the last 24 hours.',
  unreachable: 'Sentry could not be reached. Nothing was sent.',
} as const;

/** How long a health report waits for Sentry's answer before it says it could not be reached. */
const HEALTH_SEND_MS = 10_000;

/** The last report's answer, for the window's Settings line (errorReports:last). */
export interface LastReportView {
  /** When Sentry answered, ISO. */
  at: string;
  /** error, handled, agent-tool, abrupt-end or diagnostic. */
  kind: string;
  /** Sentry's HTTP status; 0 when none came. */
  status: number;
}

/** What main hands the reports at their start (main.ts). */
export interface ErrorReportWiring {
  /** core/uncaught-guard.ts's: called by the SDK after its flush, in place of showing Electron's error box. */
  onFatalError?: (error: Error) => void;
  /** What an agent tool error may name: Tars's tools and the CLIs it runs. */
  vocabulary?: ReportFacts['agentTools'];
  /** The IPC channels Tars registered, which a handler's error is reported under. */
  channels?: ReadonlySet<string>;
}

export interface ErrorReports {
  sync(): Promise<void>;
  /** The last report's answer, kept in error-reports.json; null when none was. Never makes the file. */
  lastReport(): LastReportView | null;
  /** Why nothing may be sent now (Windows, the switch off), or null. */
  refusal(): string | null;
  /**
   * A report of Tars's health (2.0.3): the abrupt end at the next launch, or
   * the diagnostic the user sends. Through the same switch and budget as an
   * error, counted before it leaves and given back when Sentry was not reached.
   */
  sendHealth(kind: HealthKind, payload: Record<string, unknown>): Promise<HealthSendResult>;
}

/** Never on a platform whose build may not send (errorReportsAvailable: not on win32). */
export function startErrorReports(isEnabled: () => boolean, platform: NodeJS.Platform = process.platform, wiring: ErrorReportWiring = {}): ErrorReports {
  const file = path.join(DATA_DIR, 'error-reports.json');
  let starting: Promise<void> | undefined;
  let sentryOf: typeof import('@sentry/electron/main') | undefined;
  let budgetOf: ReportBudget | undefined;
  const preAdmitted = new Set<string>();
  const healthPayloads = new Map<string, Record<string, unknown>>();
  const answers = new Map<string, number>();
  const sync = (): Promise<void> => {
    if (starting) return starting;
    if (!errorReportsAvailable(platform) || !isEnabled()) return Promise.resolve();
    starting = (async () => {
      try {
        const sentry = await import('@sentry/electron/main');
        const budget = new ReportBudget(file);
        budgetOf = budget;
        sentry.init({
          ...errorReportOptions({
            dsn: dsn(),
            isEnabled,
            facts: () => facts(budget, wiring.vocabulary),
            budget,
            makeTransport: sentry.makeElectronTransport as never,
            preAdmitted,
            healthPayloads,
            onSent: (eventId, status, kind) => {
              answers.set(eventId, status);
              // Kept before it is said, so that whoever reads the line finds the answer kept.
              budget.noteAnswer(kind, status);
              console.log(`[error-reports] sent ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind} report: HTTP ${status}${status === 0 ? ' (no answer)' : ''}`);
            },
          }),
          // After its flush, the SDK shows Electron's error box unless it is handed this (core/uncaught-guard.ts).
          ...(wiring.onFatalError ? { onFatalError: wiring.onFatalError } : {}),
          defaultIntegrations: false,
          integrations: [
            sentry.onUncaughtExceptionIntegration(),
            sentry.onUnhandledRejectionIntegration(),
            sentry.linkedErrorsIntegration(),
          ],
          ipcMode: sentry.IPCMode.Classic,
          // Chromium would add the system's language to the request.
          transportOptions: { headers: { 'Accept-Language': 'en' } },
          skipOpenTelemetrySetup: true,
        } as never);
        sentryOf = sentry;
        console.log(`[error-reports] error reports on, ${facts(budget).release}`);
        // A handled error is sent as a copy without its words, nor its causes' (handled.ts withoutWords; the Audit's M1).
        const handled = (error: Error, type: string) => {
          if (!isEnabled()) return;
          sentry.captureException(withoutWords(error), { data: { mechanism: { type, handled: true } } } as never);
        };
        watchLoggedErrors(console as unknown as { error: (...args: unknown[]) => void }, error => handled(error, 'tars.logged'), wiring.channels ?? new Set());
        setReportSinks({
          handled: error => handled(error, 'tars.handled'),
          agentTool: (error: AgentToolError) => {
            if (!isEnabled()) return;
            const tool = wiring.vocabulary?.tools.has(error.tool) ? error.tool : UNKNOWN_TOOL;
            sentry.captureEvent(agentToolEvent({ ...error, tool }) as never);
          },
        });
      } catch (err) {
        console.warn('[error-reports] could not start:', err instanceof Error ? err.message : err);
      }
      guardRendererBridge();
    })();
    return starting;
  };
  const refusal = (): string | null => {
    if (!errorReportsAvailable(platform)) return HEALTH_REFUSALS.windows;
    if (!isEnabled()) return HEALTH_REFUSALS.off;
    return null;
  };
  const sendHealth = async (kind: HealthKind, payload: Record<string, unknown>): Promise<HealthSendResult> => {
    const refused = refusal();
    if (refused) return { sent: false, reason: refused };
    await sync();
    const sentry = sentryOf;
    const budget = budgetOf;
    if (!sentry || !budget) return { sent: false, reason: HEALTH_REFUSALS.unreachable };
    const id = randomUUID().replace(/-/g, '');
    const event = { ...healthEvent(kind, payload), event_id: id };
    const report = toReport(event, facts(budget));
    if (!report) return { sent: false, reason: HEALTH_REFUSALS.unreachable };
    const fingerprint = reportFingerprint(report);
    const at = budget.admitAt(fingerprint);
    if (at === null) return { sent: false, reason: HEALTH_REFUSALS.budget };
    preAdmitted.add(id);
    healthPayloads.set(id, payload);
    try {
      sentry.captureEvent(event as never, { event_id: id } as never);
      const flushed = await sentry.flush(HEALTH_SEND_MS);
      const status = answers.get(id) ?? 0;
      if (flushed && status >= 200 && status < 300) return { sent: true };
      budget.refund(fingerprint, at);
      return { sent: false, reason: HEALTH_REFUSALS.unreachable };
    } finally {
      preAdmitted.delete(id);
      healthPayloads.delete(id);
      answers.delete(id);
    }
  };
  const lastReport = (): LastReportView | null => {
    const last = budgetOf?.last ?? ReportBudget.readLast(file);
    return last ? { at: new Date(last.at).toISOString(), kind: last.kind, status: last.status } : null;
  };
  void sync();
  return { sync, refusal, sendHealth, lastReport };
}
