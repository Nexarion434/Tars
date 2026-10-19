/**
 * An uncaught exception in main never freezes Tars (2.0.4, F4 of the maintainer's go of 2026-10-18).
 *
 * Electron's own handler (lib/browser/init.ts) shows its modal error box, "A JavaScript error occurred in the main
 * process", when it is the only `uncaughtException` listener; the Sentry SDK's shows the same box after its flush
 * when only it and Electron's listen and it was handed no onFatalError. The box holds the main process until someone
 * clicks it: about 5 minutes in the QA's run (sentry-pipeline-1810), and the maintainer met it on his screen. A
 * rejection nobody handled reaches the same listeners, Node turning it into an exception.
 *
 * Tars listens from the first line of main (electron/uncaught.ts), so Electron's handler shows nothing, and hands the
 * SDK this guard's onFatalError. The error is logged with its stack, reported by the SDK when the reports are on, and
 * Tars runs on: what threw was one timer's or one handler's work, and quitting would end every agent's terminal.
 *
 * The one state Tars cannot run on is a main module that did not finish loading: what threw stopped it before
 * app.whenReady was asked for, or before what it registers, and no window will ever open. Then Tars quits (code 1),
 * after a moment for the report to leave, and the next launch reports the abrupt end. It does not restart: a start
 * that fails would fail again, in a loop.
 */

export interface UncaughtDeps {
  /** Where the line goes (main's console.error). */
  log(line: string): void;
  /** How Tars quits (app.exit). */
  quit(code: number): void;
  /** How long a main that did not load waits for its report before it quits. */
  quitAfterMs?: number;
}

export interface UncaughtGuard {
  /** main.ts has loaded: from here on, Tars runs on after an uncaught exception. */
  mainLoaded(): void;
  /** For the SDK, which calls it after its flush in place of showing Electron's box: the error is already logged. */
  onFatalError(error: Error): void;
}

type Listening = { on(event: 'uncaughtException', listener: (error: unknown, origin?: string) => void): unknown };

export function guardUncaught(proc: Listening, deps: UncaughtDeps): UncaughtGuard {
  let loaded = false;
  let quitting = false;
  const say = (line: string): void => {
    try {
      deps.log(line);
    } catch { /* a closed stderr: nothing more to tell */ }
  };
  proc.on('uncaughtException', (error: unknown, origin?: string) => {
    const what = origin === 'unhandledRejection' ? 'an unhandled rejection' : 'an uncaught exception';
    const detail = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
    say(`[uncaught] ${what} in main: ${detail}`);
    if (loaded || quitting) return;
    quitting = true;
    const wait = deps.quitAfterMs ?? 2_000;
    say(`[uncaught] it came before Tars finished loading, so no window will open: Tars quits in ${wait / 1000} s`);
    setTimeout(() => deps.quit(1), wait);
  });
  return {
    mainLoaded: () => { loaded = true; },
    onFatalError: () => { /* logged by the listener above; the SDK shows nothing */ },
  };
}
