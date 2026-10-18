import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Codex's turns, as Tars sees them (2.0.4).
 *
 * codex has no hook Tars installs, so a codex agent read `running` from its launch to its end: a turn that ended,
 * or failed in a second, changed nothing, and delegate_task waited on a turn it would never see end. codex writes
 * every session to $CODEX_HOME/sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl, one JSON object a line:
 * `session_meta` (its id, its folder, who started it), `task_started`, the user's message (`item_completed`,
 * `UserMessage`), `turn_context` (the model, the effort), and `task_complete` with `last_agent_message`, or with
 * `error` when the turn failed (measured on codex-cli 0.163.0: "The 'gpt-5-codex-mini' model is not supported when
 * using Codex with a ChatGPT account"). Tars reads it and posts, as the agent's terminal, what Claude Code's hooks
 * post: the same routes decide (hooks-routes.ts), so a codex agent goes through one state machine with the others.
 *
 * The ways it fails:
 * 1. A turn's end never seen: the status stays running, delegate_task never gets the answer.
 * 2. A session given to the wrong agent: another codex agent's in the same folder, the user's own codex session, one
 *    begun before the agent's launch, or one in another folder. Tars's identity line in the first message ("(id
 *    <agent id>)") settles it when it is there; otherwise the first launch in that folder takes the first session.
 * 3. The guardian's session (codex's automatic review, a subagent with a rollout of its own) taken for the agent's:
 *    its task_complete would end the agent's turn in the middle.
 * 4. A turn's end posted before its start, or its start without the task's text: the text carries the sender line
 *    whose request id routes the result back to its asker (task-requests.ts).
 * 5. A failed turn taken for a success: the error is posted as the turn's failure, in codex's own words.
 * 6. A line read while codex was still writing it, taken for garbage or lost: a last line with no end waits for it.
 * 7. An approval waited on, unseen: in normal mode codex asks before each command, in a dialog only the terminal
 *    shows. While it is on screen the agent is waiting on a permission, and running again once it is gone.
 * 8. Every rollout of the machine read at every tick: only the files changed since the oldest launch it waits on,
 *    and of a file already read, only what was added since.
 * 9. A turn interrupted (Esc in its terminal) never seen to end: measured on 0.163, codex then writes `turn_aborted`
 *    (reason `interrupted`) and no task_complete. The agent read running for good and, since codex holds its line
 *    while a turn runs, every later task waited behind a turn that was over; or the interrupt was taken for an end,
 *    and the task said completed, with the turn before's answer.
 */

import { CodexSessionWatch, codexEventOf, type HookPost } from '../../../electron/services/codex-sessions';

let root: string;
let posts: Array<{ agentId: string } & HookPost>;
let screen: Map<string, string | undefined>;
let interrupted: Array<{ agentId: string; sessionId: string }>;
let now: number;
let watch: CodexSessionWatch;

const AGENT = 'aaaa1111-0000-4000-8000-00000000c0de';
const OTHER = 'bbbb2222-0000-4000-8000-00000000c0de';
const SESSION = '01a14ed5-56c5-78e0-9779-9be42587f6e6';

const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: new Date(now).toISOString(), type, payload });
const meta = (id: string, cwd: string, source: unknown = 'cli') => line('session_meta', { id, session_id: id, cwd, source, originator: 'codex-tui', cli_version: '0.163.0', timestamp: new Date(now).toISOString() });
const started = (turn: string) => line('event_msg', { type: 'task_started', turn_id: turn });
const user = (text: string) => line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } });
const aborted = (turn: string) => line('event_msg', { type: 'turn_aborted', turn_id: turn, reason: 'interrupted' });
const done = (turn: string, message: string | null, error?: string) => line('event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: message, ...(error ? { error: { message: error } } : {}) });

function rollout(id: string, lines: string[], partial = ''): string {
  const d = new Date(now);
  const dir = path.join(root, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-18T15-46-06-${id}.jsonl`);
  fs.writeFileSync(file, lines.map(l => `${l}\n`).join('') + partial);
  // Written at the test's own time, which the watch reads: not the machine's.
  fs.utimesSync(file, new Date(now), new Date(now));
  return file;
}
const append = (file: string, text: string) => { fs.appendFileSync(file, text); fs.utimesSync(file, new Date(now), new Date(now)); };
const postsFor = (agentId: string) => posts.filter(p => p.agentId === agentId).map(p => ({ path: p.path, ...p.body }));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-sessions-'));
  posts = [];
  screen = new Map();
  interrupted = [];
  now = Date.parse('2026-10-18T13:46:06Z');
  watch = new CodexSessionWatch({
    codexHome: () => root,
    now: () => now,
    post: async (agentId, post) => { posts.push({ agentId, ...post }); },
    dialogTitle: (agentId) => screen.get(agentId),
    interrupted: (agentId, sessionId) => { interrupted.push({ agentId, sessionId }); posts.push({ agentId, path: '/api/hooks/status', body: { interruptedHere: true } }); },
  });
});

describe("a codex agent's turn", () => {
  it('registered, begun with its task, ended with its answer, in that order', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 1500;
    rollout(SESSION, [meta(SESSION, project), started('t1'), user('Message from agent "Lead": fix it [task t-1a2b3c4d]'), done('t1', 'Fixed: 2 files.')]);
    await watch.tick();

    expect(postsFor(AGENT)).toEqual([
      { path: '/api/hooks/status', agent_id: AGENT, session_id: SESSION, status: 'running', source: 'startup' },
      { path: '/api/hooks/status', agent_id: AGENT, session_id: SESSION, status: 'running', event: 'UserPromptSubmit', current_task: 'Message from agent "Lead": fix it [task t-1a2b3c4d]' },
      { path: '/api/hooks/output', agent_id: AGENT, session_id: SESSION, hook: 'Stop', output: 'Fixed: 2 files.' },
      { path: '/api/hooks/status', agent_id: AGENT, session_id: SESSION, hook: 'Stop', status: 'idle' },
      { path: '/api/hooks/agent-stopped', agent_id: AGENT, session_id: SESSION, hook: 'Stop' },
    ]);
  });

  it("failed in codex's own words, not taken for an answer", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 1000;
    const refusal = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-5-codex-mini' model is not supported when using Codex with a ChatGPT account." } });
    rollout(SESSION, [meta(SESSION, project), started('t1'), user('hello'), done('t1', null, refusal)]);
    await watch.tick();

    const last = postsFor(AGENT).at(-1);
    expect(last).toEqual({ path: '/api/hooks/status', agent_id: AGENT, session_id: SESSION, status: 'error', error_kind: 'codex_turn_failed', error_message: "The 'gpt-5-codex-mini' model is not supported when using Codex with a ChatGPT account." });
    expect(postsFor(AGENT).some(p => p.path === '/api/hooks/output')).toBe(false);
  });

  it('a line codex is still writing waits for its end; the next turns of the session are read as they come', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 500;
    const whole = done('t1', 'one');
    const file = rollout(SESSION, [meta(SESSION, project), started('t1'), user('first')], whole.slice(0, 40));
    await watch.tick();
    expect(postsFor(AGENT).map(p => p.status ?? p.path)).toEqual(['running', 'running']);

    append(file, `${whole.slice(40)}\n`);
    await watch.tick();
    append(file, [started('t2'), user('second'), done('t2', 'two')].map(l => `${l}\n`).join(''));
    await watch.tick();
    const outputs = postsFor(AGENT).filter(p => p.path === '/api/hooks/output').map(p => p.output);
    expect(outputs).toEqual(['one', 'two']);
    expect(postsFor(AGENT).filter(p => p.event === 'UserPromptSubmit').map(p => p.current_task)).toEqual(['first', 'second']);
  });
});

describe('a turn interrupted', () => {
  it('9. is said interrupted before the agent rests, with no answer, and the next turn is read as before', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 1000;
    const file = rollout(SESSION, [meta(SESSION, project), started('t1'), user('Message from agent "Lead": a long job [task t-1a2b3c4d]'), aborted('t1')]);
    await watch.tick();

    expect(interrupted).toEqual([{ agentId: AGENT, sessionId: SESSION }]);
    const after = postsFor(AGENT).slice(2);
    expect(after).toEqual([
      { path: '/api/hooks/status', interruptedHere: true },
      { path: '/api/hooks/status', agent_id: AGENT, session_id: SESSION, hook: 'Stop', status: 'idle' },
    ]);
    append(file, [started('t2'), user('again'), done('t2', 'done now')].map(l => `${l}\n`).join(''));
    await watch.tick();
    expect(postsFor(AGENT).filter(p => p.path === '/api/hooks/output').map(p => p.output)).toEqual(['done now']);
    expect(interrupted).toHaveLength(1);
  });
});

describe('whose session it is', () => {
  it("the agent its first message names, whichever launched first in that folder", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(OTHER, project);
    now += 100;
    watch.noteLaunch(AGENT, project);
    now += 900;
    rollout(SESSION, [meta(SESSION, project), started('t1'), user(`[Tars: you are agent "Codex" (id ${AGENT}), worker of project ${project}. Work autonomously]\n\nfix it`), done('t1', 'ok')]);
    await watch.tick();
    expect(postsFor(AGENT).length).toBeGreaterThan(0);
    expect(postsFor(OTHER)).toEqual([]);
  });

  it('nobody: a session in another folder, one begun before the launch, the guardian of the automatic review', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-elsewhere-'));
    rollout('01a14ed5-0000-7000-8000-00000000before', [meta('01a14ed5-0000-7000-8000-00000000before', project), started('t0'), done('t0', 'old')]);
    now += 5000;
    watch.noteLaunch(AGENT, project);
    now += 500;
    rollout('01a14ed5-0000-7000-8000-0000000000else', [meta('01a14ed5-0000-7000-8000-0000000000else', elsewhere), started('t1'), done('t1', 'x')]);
    rollout('01a14ed5-0000-7000-8000-00000guardian', [meta('01a14ed5-0000-7000-8000-00000guardian', project, { subagent: { other: 'guardian' } }), started('g1'), done('g1', '{"outcome":"allow"}')]);
    await watch.tick();
    expect(postsFor(AGENT), JSON.stringify(posts)).toEqual([]);

    rollout(SESSION, [meta(SESSION, project), started('t1'), user('hello'), done('t1', 'mine')]);
    await watch.tick();
    expect(postsFor(AGENT).filter(p => p.path === '/api/hooks/output').map(p => p.output)).toEqual(['mine']);
  });

  it("two codex agents launched in one folder each get one session, in their launches' order", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 200;
    watch.noteLaunch(OTHER, project);
    now += 800;
    const first = '01a14ed5-1111-7000-8000-000000000001';
    const second = '01a14ed5-2222-7000-8000-000000000002';
    rollout(first, [meta(first, project), started('a'), user('a'), done('a', 'A')]);
    now += 300;
    rollout(second, [meta(second, project), started('b'), user('b'), done('b', 'B')]);
    await watch.tick();
    expect(postsFor(AGENT).filter(p => p.path === '/api/hooks/output').map(p => p.output)).toEqual(['A']);
    expect(postsFor(OTHER).filter(p => p.path === '/api/hooks/output').map(p => p.output)).toEqual(['B']);
  });
});

describe('an approval codex waits on', () => {
  it('reads as waiting on a permission while its dialog is on screen, and running once it is gone', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 500;
    const file = rollout(SESSION, [meta(SESSION, project), started('t1'), user('run the tests')]);
    await watch.tick();
    screen.set(AGENT, 'Would you like to run the following command? $ npm test');
    await watch.tick();
    await watch.tick();
    screen.set(AGENT, undefined);
    await watch.tick();
    append(file, `${done('t1', 'tests pass')}\n`);
    await watch.tick();

    const statuses = postsFor(AGENT).filter(p => p.path === '/api/hooks/status').map(p => [p.status, p.waiting_reason, p.event, p.hook].filter(Boolean).join(' '));
    expect(statuses).toEqual(['running', 'running UserPromptSubmit', 'waiting permission', 'running', 'idle Stop']);
    const asked = postsFor(AGENT).find(p => p.waiting_reason === 'permission');
    expect(asked).toMatchObject({ tool_name: 'codex', tool_input: { command: 'Would you like to run the following command? $ npm test' } });
  });

  it('is not looked for outside a turn', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    watch.noteLaunch(AGENT, project);
    now += 500;
    rollout(SESSION, [meta(SESSION, project), started('t1'), user('x'), done('t1', 'y')]);
    await watch.tick();
    screen.set(AGENT, 'Would you like to run the following command?');
    await watch.tick();
    expect(postsFor(AGENT).some(p => p.waiting_reason === 'permission')).toBe(false);
  });
});

describe('what is read', () => {
  it('not a file older than the oldest launch Tars waits on, and of a file read, only what was added', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-project-'));
    const old = rollout('01a14ed5-0000-7000-8000-000000000old', [meta('01a14ed5-0000-7000-8000-000000000old', project)]);
    fs.utimesSync(old, new Date(now - 3_600_000), new Date(now - 3_600_000));
    expect(watch.filesToRead()).toEqual([]);
    now += 1000;
    watch.noteLaunch(AGENT, project);
    now += 1000;
    const file = rollout(SESSION, [meta(SESSION, project), started('t1')]);
    expect(watch.filesToRead()).toEqual([file]);
  });

  it('a line that is not JSON, or not an event, is no event', () => {
    for (const odd of ['', 'not json', '{"type":"event_msg"}', '{"type":"event_msg","payload":{"type":"task_complete"}}', '[1,2]']) {
      expect(() => codexEventOf(odd)).not.toThrow();
    }
    expect(codexEventOf('not json')).toBeNull();
  });
});
