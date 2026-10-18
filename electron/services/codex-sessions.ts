import * as fs from 'fs';
import * as path from 'path';
import { codexHome } from '../providers/codex-cli';

/**
 * Codex's turns, read from its own session log and told to Tars the way Claude Code's hooks tell it (2.0.4).
 *
 * codex runs no hook Tars installs, so a codex agent read `running` from its launch to its end, and delegate_task
 * waited on a turn it would never see end. codex writes each session to
 * $CODEX_HOME/sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl, one JSON object a line (measured on
 * codex-cli 0.163.0): `session_meta` (its id, its folder, `source`: `cli`, or a subagent such as the guardian of the
 * automatic review), `task_started`, the user's message (`item_completed`, a `UserMessage`), and `task_complete`,
 * with `last_agent_message`, or with `error` when the turn failed, or `turn_aborted` when it was interrupted (no
 * task_complete then: Tars is told, task-watch.ts, turnInterrupted). This reads it and posts, as the agent's terminal
 * and with that terminal's token, what Claude Code's hooks post (session-start.sh, user-prompt-submit.sh,
 * on-stop.sh, stop-failure.sh, permission-request.sh): the hook routes decide what happens, so a codex agent goes
 * through the one state machine every agent goes through (hooks-routes.ts). codex-sessions.test.ts says each way
 * this goes wrong.
 *
 * Whose session is whose: a launch is noted when Tars spawns a codex terminal (spawnAgentPty). A new session in
 * that folder, begun after it, is that launch's. When several launches wait in one folder, Tars's identity line in
 * the session's first message ("(id <agent id>)", every task Tars hands a session) says which; without it, the
 * first launch takes the first session.
 *
 * An approval codex waits on (normal mode asks before a command outside its sandbox, and before each call of an MCP
 * server's tool) is in no line of the log: it is read from the terminal's screen (terminal-mirror.ts,
 * codexDialogOnScreen) while a turn is open.
 */

export interface HookPost {
  path: '/api/hooks/status' | '/api/hooks/output' | '/api/hooks/agent-stopped';
  body: Record<string, unknown>;
}

export type CodexEvent =
  | { kind: 'session'; id: string; cwd: string; subagent: boolean; at: number }
  | { kind: 'turn_started'; turnId: string }
  | { kind: 'user'; text: string }
  | { kind: 'turn_complete'; turnId: string; message: string | null; error: string | null }
  | { kind: 'turn_aborted'; turnId: string };

/** What a turn's `error` says, in codex's own words: the API's message when codex kept the API's answer whole. */
function errorText(error: unknown): string | null {
  const raw = typeof error === 'string' ? error
    : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message
      : null;
  if (raw === null) return error ? 'the turn failed' : null;
  try {
    const inner = (JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown });
    const said = inner?.error?.message ?? inner?.message;
    if (typeof said === 'string' && said.trim()) return said.trim();
  } catch { /* not JSON: codex's own sentence */ }
  return raw.trim() || 'the turn failed';
}

/** One line of a rollout, as Tars reads it; null for a line that is not one of these. */
export function codexEventOf(line: string): CodexEvent | null {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return null; }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const { type, payload, timestamp } = entry as { type?: unknown; payload?: unknown; timestamp?: unknown };
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (type === 'session_meta') {
    const id = typeof p.id === 'string' ? p.id : typeof p.session_id === 'string' ? p.session_id : '';
    if (!id || typeof p.cwd !== 'string') return null;
    const at = Date.parse(typeof p.timestamp === 'string' ? p.timestamp : typeof timestamp === 'string' ? timestamp : '');
    const subagent = !!p.source && typeof p.source === 'object' && 'subagent' in (p.source as object);
    return { kind: 'session', id, cwd: p.cwd, subagent, at: Number.isFinite(at) ? at : 0 };
  }
  if (type !== 'event_msg') return null;
  if (p.type === 'task_started') return { kind: 'turn_started', turnId: typeof p.turn_id === 'string' ? p.turn_id : '' };
  // Interrupted (Esc): measured on 0.163, `turn_aborted` with reason `interrupted`, and no task_complete after it.
  if (p.type === 'turn_aborted') return { kind: 'turn_aborted', turnId: typeof p.turn_id === 'string' ? p.turn_id : '' };
  if (p.type === 'task_complete') {
    return {
      kind: 'turn_complete',
      turnId: typeof p.turn_id === 'string' ? p.turn_id : '',
      message: typeof p.last_agent_message === 'string' ? p.last_agent_message : null,
      error: p.error === undefined || p.error === null ? null : errorText(p.error),
    };
  }
  if (p.type === 'item_completed') {
    const item = p.item as { type?: unknown; content?: unknown } | undefined;
    if (item?.type !== 'UserMessage' || !Array.isArray(item.content)) return null;
    const text = item.content
      .map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('');
    return { kind: 'user', text };
  }
  return null;
}

export interface CodexSessionWatchDeps {
  codexHome: () => string;
  now: () => number;
  /** Posts as the agent's terminal (production: the agent's own token, on the loopback). */
  post: (agentId: string, post: HookPost) => Promise<void>;
  /** codex's approval dialog on the agent's screen, as one line, or undefined. */
  dialogTitle: (agentId: string) => string | undefined;
  /** Told a turn was interrupted, before the agent's rest is posted (production: task-watch.ts, turnInterrupted). */
  interrupted?: (agentId: string, sessionId: string) => void;
}

interface Launch { agentId: string; cwd: string; at: number }
interface Bound {
  agentId: string;
  sessionId: string;
  offset: number;
  partial: string;
  registered: boolean;
  turnOpen: boolean;
  startPosted: boolean;
  asking: boolean;
}

/** A session's time may read a little before the launch Tars noted: the two clocks are read apart. */
const LAUNCH_SLACK_MS = 2_000;
/** A launch no session has matched in this long is given up on (a CLI that never started). */
const LAUNCH_TTL_MS = 10 * 60_000;
/** How long a session waits for its first message to say whose it is, when several launches wait in its folder. */
const IDENTITY_WAIT_MS = 10_000;
const IDENTITY = /\(id ([0-9a-fA-F-]{8,})\)/;

function realOf(dir: string): string {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

function readFrom(file: string, offset: number): { text: string; end: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { text: '', end: offset };
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    return { text: buffer.toString('utf8'), end: size };
  } finally {
    fs.closeSync(fd);
  }
}

export class CodexSessionWatch {
  private launches: Launch[] = [];
  private bound = new Map<string, Bound>();
  /** Files read and found nobody's (another folder, before any launch, a subagent): never read again. */
  private nobodys = new Set<string>();

  constructor(private deps: CodexSessionWatchDeps) {}

  setDeps(deps: Partial<CodexSessionWatchDeps>): void {
    this.deps = { ...this.deps, ...deps };
  }

  /** A codex terminal was spawned for this agent: its session, from now on, is this one's. */
  noteLaunch(agentId: string, cwd: string): void {
    this.launches = this.launches.filter(l => l.agentId !== agentId);
    for (const [file, b] of this.bound) if (b.agentId === agentId) this.bound.delete(file);
    this.launches.push({ agentId, cwd: realOf(cwd), at: this.deps.now() });
  }

  /** Whether anything is waited on or followed: no codex agent, no reading. */
  get busy(): boolean {
    return this.launches.length > 0 || this.bound.size > 0;
  }

  /** The rollouts to look at: changed since the oldest launch waited on, in the day folders that can hold them. */
  filesToRead(): string[] {
    if (this.launches.length === 0) return [];
    const since = Math.min(...this.launches.map(l => l.at)) - LAUNCH_SLACK_MS;
    const sessions = path.join(this.deps.codexHome(), 'sessions');
    const days = new Set<string>();
    for (let at = since - 86_400_000; at <= this.deps.now() + 86_400_000; at += 86_400_000) {
      const d = new Date(at);
      days.add(path.join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
      days.add(path.join(String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')));
    }
    const files: string[] = [];
    for (const day of days) {
      let names: string[];
      try { names = fs.readdirSync(path.join(sessions, day)); } catch { continue; }
      for (const name of names) {
        if (!/^rollout-.*\.jsonl$/.test(name)) continue;
        const file = path.join(sessions, day, name);
        if (this.bound.has(file) || this.nobodys.has(file)) continue;
        try {
          if (fs.statSync(file).mtimeMs >= since) files.push(file);
        } catch { /* gone */ }
      }
    }
    return files.sort();
  }

  async tick(): Promise<void> {
    const now = this.deps.now();
    this.launches = this.launches.filter(l => now - l.at < LAUNCH_TTL_MS);
    this.bindNew(now);
    for (const [file, b] of this.bound) await this.follow(file, b);
    for (const b of this.bound.values()) await this.lookForApproval(b);
  }

  private bindNew(now: number): void {
    const candidates: Array<{ file: string; session: Extract<CodexEvent, { kind: 'session' }>; firstUser?: string }> = [];
    for (const file of this.filesToRead()) {
      let text: string;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      if (lines.length < 2) continue; // its first line is still being written
      const session = codexEventOf(lines[0]);
      if (!session || session.kind !== 'session') { this.nobodys.add(file); continue; }
      const firstUser = lines.slice(1, -1).map(codexEventOf).find((e): e is Extract<CodexEvent, { kind: 'user' }> => e?.kind === 'user')?.text;
      candidates.push({ file, session, firstUser });
    }
    for (const { file, session, firstUser } of candidates.sort((a, b) => a.session.at - b.session.at)) {
      const cwd = realOf(session.cwd);
      const waiting = this.launches.filter(l => l.cwd === cwd && session.at >= l.at - LAUNCH_SLACK_MS);
      if (session.subagent || waiting.length === 0) {
        // Nobody's for good once no launch waits for it: a subagent, another folder, or begun before any launch.
        if (session.subagent || !this.launches.some(l => l.cwd === cwd)) this.nobodys.add(file);
        else if (this.launches.every(l => session.at < l.at - LAUNCH_SLACK_MS)) this.nobodys.add(file);
        continue;
      }
      const named = firstUser?.match(IDENTITY)?.[1];
      let launch = named ? waiting.find(l => l.agentId === named) : undefined;
      if (!launch) {
        // Several launches and nothing said yet: the first message may still name one.
        if (waiting.length > 1 && firstUser === undefined && now - session.at < IDENTITY_WAIT_MS) continue;
        launch = waiting.sort((a, b) => a.at - b.at)[0];
      }
      this.launches = this.launches.filter(l => l !== launch);
      this.bound.set(file, {
        agentId: launch.agentId, sessionId: session.id, offset: 0, partial: '',
        registered: false, turnOpen: false, startPosted: false, asking: false,
      });
    }
  }

  private post(b: Bound, route: HookPost['path'], body: Record<string, unknown>): Promise<void> {
    return this.deps.post(b.agentId, { path: route, body: { agent_id: b.agentId, session_id: b.sessionId, ...body } });
  }

  private async follow(file: string, b: Bound): Promise<void> {
    let read: { text: string; end: number };
    try { read = readFrom(file, b.offset); } catch { return; }
    if (!read.text) return;
    b.offset = read.end;
    const lines = (b.partial + read.text).split('\n');
    // A last line with no end yet is still being written: it waits for the rest.
    b.partial = lines.pop() ?? '';
    for (const line of lines) {
      const event = codexEventOf(line);
      if (!event) continue;
      if (event.kind === 'session') {
        if (!b.registered) {
          b.registered = true;
          await this.post(b, '/api/hooks/status', { status: 'running', source: 'startup' });
        }
      } else if (event.kind === 'turn_started') {
        b.turnOpen = true;
        b.startPosted = false;
      } else if (event.kind === 'user') {
        if (b.turnOpen && !b.startPosted) {
          b.startPosted = true;
          await this.post(b, '/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: event.text });
        }
      } else if (event.kind === 'turn_complete') {
        if (!b.startPosted) await this.post(b, '/api/hooks/status', { status: 'running', event: 'UserPromptSubmit' });
        b.turnOpen = false;
        b.startPosted = false;
        b.asking = false;
        if (event.error) {
          await this.post(b, '/api/hooks/status', { status: 'error', error_kind: 'codex_turn_failed', error_message: event.error });
        } else {
          if (event.message) await this.post(b, '/api/hooks/output', { hook: 'Stop', output: event.message });
          await this.post(b, '/api/hooks/status', { hook: 'Stop', status: 'idle' });
          await this.post(b, '/api/hooks/agent-stopped', { hook: 'Stop' });
        }
      } else if (event.kind === 'turn_aborted' && b.turnOpen) {
        b.turnOpen = false;
        b.startPosted = false;
        b.asking = false;
        // No answer, and no task_complete will come: said interrupted first, then the rest codex is at.
        this.deps.interrupted?.(b.agentId, b.sessionId);
        await this.post(b, '/api/hooks/status', { hook: 'Stop', status: 'idle' });
      }
    }
  }

  private async lookForApproval(b: Bound): Promise<void> {
    if (!b.turnOpen) return;
    const title = this.deps.dialogTitle(b.agentId);
    if (title && !b.asking) {
      b.asking = true;
      await this.post(b, '/api/hooks/status', {
        status: 'waiting', waiting_reason: 'permission', tool_name: 'codex', tool_input: { command: title }, opened_at: this.deps.now(),
      });
    } else if (!title && b.asking) {
      b.asking = false;
      await this.post(b, '/api/hooks/status', { status: 'running' });
    }
  }
}

/** The one watch of this run of Tars: launches are noted from spawnAgentPty, and main.ts starts it. */
export const codexSessionWatch = new CodexSessionWatch({
  codexHome: () => codexHome(),
  now: () => Date.now(),
  post: async () => {},
  dialogTitle: () => undefined,
});

/** Noted for every codex terminal Tars spawns (core/agent-pty.ts). */
export function noteCodexLaunch(agentId: string, cwd: string): void {
  codexSessionWatch.noteLaunch(agentId, cwd);
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Reads codex's sessions every second while a codex agent is launched or followed. */
export function startCodexSessionWatch(deps: Pick<CodexSessionWatchDeps, 'post' | 'dialogTitle' | 'interrupted'>): void {
  codexSessionWatch.setDeps(deps);
  if (timer) return;
  let running = false;
  timer = setInterval(() => {
    if (running || !codexSessionWatch.busy) return;
    running = true;
    codexSessionWatch.tick()
      .catch(err => console.warn('[codex-sessions] a tick failed:', err instanceof Error ? err.message : err))
      .finally(() => { running = false; });
  }, 1000);
  timer.unref?.();
}
