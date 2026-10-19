import { UNKNOWN_TOOL, type AgentToolError } from './report';

/**
 * Where the errors Tars handles are met, and which of them become reports (2.0.4, F1 and F3 of the maintainer's go
 * of 2026-10-18, from the QA's diagnosis sentry-pipeline-1810). Until then the reports held only what nobody caught.
 *
 * What main logs at error level is the one hook: Tars's catch sites log what they caught (`console.error('<what>
 * failed:', err)`, then an answer `{ success: false }`), Electron logs every IPC handler that throws ("Error occurred
 * in handler for '<channel>':" with the error), and the API's own catch logs "API error:" with it. Only an Error among
 * the line's arguments is reported, never the line's words: a log line names agents, tasks and folders, and was never
 * written for a report. A handler's own refusal is no fault and is not reported.
 *
 * Two sites the log does not reach report here: an API route that answers 500 without throwing, and an agent's CLI
 * that exits with a failure code at its launch. And the agents' tool errors, a report kind of their own (report.ts).
 *
 * Kept free of electron and of the SDK: the sinks are set by index.ts once the reports start, and until then (or
 * while they are off) a report goes nowhere. Nothing here throws into the code that met the error.
 */

export interface ReportSinks {
  handled(error: Error): void;
  agentTool(error: AgentToolError): void;
}

let sinks: ReportSinks | null = null;

/** Set by the reports at their start (index.ts); null in a test that wants none. */
export function setReportSinks(next: ReportSinks | null): void {
  sinks = next;
}

/** An error Tars met and handled, at a site the log does not reach. */
export function reportHandledError(error: Error): void {
  try {
    sinks?.handled(error);
  } catch { /* a report never breaks the code that met the error */ }
}

/** An agent's tool call Tars answered with an error, or a task it delivered that never started. */
export function reportAgentToolError(error: AgentToolError): void {
  try {
    sinks?.agentTool(error);
  } catch { /* a report never breaks the code that met the error */ }
}

/** A frame in electron/handlers/, compiled or not, on any system. */
const HANDLER_FRAME = /[\\/]handlers[\\/][^\\/]+\.[jt]s:\d+:\d+\)?$/;

/**
 * A handler's own refusal: a plain Error thrown from electron/handlers/, the way a handler answers the window ("There
 * is no such account.", "Invalid model name: <what was typed>"). A subclass (TypeError, a database's error), a system
 * error (it has a code), or an Error thrown from deeper code is a fault met in a handler, and is reported.
 */
export function isHandlerRefusal(error: unknown): boolean {
  if (!(error instanceof Error) || Object.getPrototypeOf(error) !== Error.prototype) return false;
  if ((error as { code?: unknown }).code !== undefined) return false;
  const frame = (error.stack ?? '').split('\n').find(line => /^\s+at /.test(line));
  return !!frame && HANDLER_FRAME.test(frame.trim());
}

/** Electron's own line for an IPC handler that threw (lib/browser/ipc-main-impl.ts). */
const IPC_LINE = /^Error occurred in handler for '([^']{1,100})':$/;

function ipcHandlerError(channel: string, cause: Error): Error {
  const error = new Error(channel, { cause });
  error.name = 'IpcHandlerError';
  return error;
}

/**
 * Reports each Error that `target` logs at error level, once per Error, but a handler's own refusal; one Electron
 * logged for an IPC handler goes under its channel's name when Tars registered that channel (`channels`), with the
 * error as its cause. The line prints as before, first; a report that throws or logs breaks nothing. Gives back the
 * way to take the hook off.
 */
export function watchLoggedErrors(
  target: { error: (...args: unknown[]) => void },
  report: (error: Error) => void,
  channels: ReadonlySet<string>,
): () => void {
  const original = target.error;
  const reported = new WeakSet<Error>();
  let reporting = false;
  const hooked = function (this: unknown, ...args: unknown[]): void {
    original.apply(this, args);
    if (reporting) return;
    reporting = true;
    try {
      const error = args.find((arg): arg is Error => arg instanceof Error);
      if (!error || reported.has(error) || isHandlerRefusal(error)) return;
      reported.add(error);
      const channel = typeof args[0] === 'string' ? IPC_LINE.exec(args[0])?.[1] : undefined;
      report(channel && channels.has(channel) ? ipcHandlerError(channel, error) : error);
    } catch {
      // A report never breaks a log line.
    } finally {
      reporting = false;
    }
  };
  target.error = hooked;
  return () => {
    if (target.error === hooked) target.error = original;
  };
}

/** A route as it was registered, never as the request spelled it: `/api/agents/:id/message`. */
export function routeName(pattern: string | RegExp | undefined): string {
  if (pattern === undefined) return '(no route)';
  if (typeof pattern === 'string') return pattern;
  return pattern.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\((?:[^()\\]|\\.)*\)/g, ':id')
    .replace(/\\(.)/g, '$1');
}

/** What the API answered a request, as the reports read it (services/api-server.ts). */
export interface ApiAnswer {
  method: string;
  route: string | RegExp | undefined;
  status: number;
  /** The `error` a route answered a 500 with, its own words. */
  errorText?: string;
  /** The `code` its answer carried, when it did. */
  bodyCode?: unknown;
  /** The route threw: the API's own catch logged it, which reports it. */
  threw: boolean;
  /** The agent the token named, when one did. */
  agent?: { provider: string };
  /** Sent by an MCP server Tars handed an agent (`X-Tars-Client: mcp`). */
  fromMcp: boolean;
  /** The tool the MCP server named (`X-Tars-Tool`). */
  tool?: string;
  /** Tars's own tools. */
  tools: ReadonlySet<string>;
}

/** One of Tars's own codes in an answer: `worker_may_not_order`. */
const BODY_CODE = /^[a-z][a-z_]{2,40}$/;

/**
 * Which reports an answer makes: a 500 a route answered without throwing is a handled error (a route that threw is
 * reported by its log line); an agent's MCP call answered 400 or more is that agent's tool error, with the status and
 * the code the answer carried, the tool when it is one of Tars's, and the agent's CLI.
 */
export function apiAnswerReports(answer: ApiAnswer): { handled?: Error; agentTool?: AgentToolError } {
  const reports: { handled?: Error; agentTool?: AgentToolError } = {};
  if (answer.status >= 500 && !answer.threw) {
    const said = answer.errorText ? `: ${answer.errorText}` : '';
    const error = new Error(`${answer.method} ${routeName(answer.route)} answered ${answer.status}${said}`);
    error.name = 'ApiRouteError';
    reports.handled = error;
  }
  if (answer.agent && answer.fromMcp && answer.status >= 400) {
    const code = typeof answer.bodyCode === 'string' && BODY_CODE.test(answer.bodyCode)
      ? `${answer.status} ${answer.bodyCode}`
      : String(answer.status);
    const tool = answer.tool && answer.tools.has(answer.tool) ? answer.tool : UNKNOWN_TOOL;
    reports.agentTool = { code, tool, cli: answer.agent.provider };
  }
  return reports;
}

/** How long after its launch an agent's CLI that exits has failed to start rather than ended. */
export const LAUNCH_WINDOW_MS = 30_000;
/** The user's Ctrl+C: their choice, not a failure. */
const INTERRUPTED = 130;

/**
 * An agent's CLI that exited on its own with a failure code within 30 s of its launch (codex 0.163 refused
 * --full-auto with exit 2, and every codex agent died there unseen): the error to report, named by the provider and
 * the code, without its output or its command line. Null for a clean exit, a signal (a stop, a quit), the user's
 * interrupt, or a CLI that ran longer.
 */
export function cliLaunchExit(exit: { provider: string; exitCode: number; signal?: number; livedMs: number }): Error | null {
  if (exit.exitCode === 0 || exit.exitCode === INTERRUPTED || exit.signal || exit.livedMs > LAUNCH_WINDOW_MS) return null;
  const seconds = Math.round(exit.livedMs / 100) / 10;
  const error = new Error(`${exit.provider} exited with code ${exit.exitCode}, ${seconds} s after its launch`);
  error.name = 'CliExitedAtLaunch';
  return error;
}

/** A task the window or a bot sent that the CLI never began (core/agent-manager.ts armTaskStartWatch). */
export function taskNeverStarted(provider: string, waitedMs: number): Error {
  const error = new Error(`${provider}: the task never started, ${Math.round(waitedMs / 1000)} s after it was sent`);
  error.name = 'TaskNeverStarted';
  return error;
}
