import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { finalAnswerOf, readFinalAnswer } from '../../../electron/services/terminal-answer';
import { encodeProjectDirName, transcriptPath } from '../../../electron/utils/resume-session';

/**
 * The answer delegate_task returns for a task typed into an agent's permanent
 * terminal (2.0.4): the agent's final message for that task, read from the
 * transcript Claude Code keeps, in full (services/terminal-answer.ts). The
 * hooks' copy of it is cut at 4000 bytes; this is not.
 *
 * How this can fail, written before the code:
 * 1. an earlier message is returned (the first of the turn, one between two
 *    tools), not the last the agent wrote for the task;
 * 2. Claude Code writes one record per content block, under one message id:
 *    only the last block of the final message is returned, its first text cut;
 * 3. a record written after the final text (a tool call, a thinking block, a
 *    usage line) blanks the answer, or takes its place;
 * 4. the permanent session's earlier conversation (before the task started,
 *    or copied by a resume with its old dates) is returned as this task's;
 * 5. the next task's turn, typed in once this one ended, is read as this one's;
 * 6. a subagent's message (isSidechain) or Tars's injected context (isMeta) is
 *    returned as the agent's answer;
 * 7. a long answer (past the hooks' 4000 bytes) comes back cut, or cut inside
 *    a character;
 * 8. a damaged line stops the reading, and the answer before or after it is lost;
 * 9. no text since the task started gives "" or an older answer, never null;
 * 10. the task's session changed during it (its CLI started again): the first
 *     session's answer is returned, not the last;
 * 11. a transcript that is not there (another CLI, a session never written)
 *     throws instead of giving null.
 * 12. an agent on a Claude account other than the first runs with that
 *     account's folder as CLAUDE_CONFIG_DIR, which keeps its transcripts:
 *     looked for under ~/.claude alone, its answer is never found, and the
 *     hooks' 4000 byte copy is returned instead (added before its code).
 */

const T0 = Date.parse('2026-10-18T03:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const assistant = (s: number, id: string, content: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant', timestamp: at(s), ...extra, message: { id, role: 'assistant', model: 'claude-opus-5', content },
});
const user = (s: number, text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'user', timestamp: at(s), ...extra, message: { role: 'user', content: text },
});
const text = (t: string) => ({ type: 'text', text: t });
const window = { since: T0, until: T0 + 60_000 };

describe('the final answer of a task, from its transcript lines', () => {
  it('is the last message the agent wrote for the task (1, 3)', () => {
    const lines = [
      user(1, 'review the notes'),
      assistant(2, 'm1', [text('Let me read them.')]),
      assistant(3, 'm2', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a' } }]),
      user(4, 'ok', { toolUseResult: {} }),
      assistant(5, 'm3', [text('The notes are fine.')]),
      assistant(6, 'm3', [{ type: 'thinking', thinking: 'done' }]),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: at(7) }),
    ];
    expect(finalAnswerOf(lines, window)).toBe('The notes are fine.');
  });

  it('joins every text block of the final message, in order (2)', () => {
    const lines = [
      assistant(5, 'm9', [text('First part.')]),
      assistant(5.1, 'm9', [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }]),
      assistant(5.2, 'm9', [text('Second part.')]),
    ];
    expect(finalAnswerOf(lines, window)).toBe('First part.\n\nSecond part.');
  });

  it('reads nothing from before the task or after it (4, 5)', () => {
    const lines = [
      assistant(-30, 'old', [text('an answer to an earlier task')]),
      user(1, 'this task'),
      assistant(2, 'mine', [text('this task done')]),
      user(70, 'the next task'),
      assistant(71, 'next', [text('the next task done')]),
    ];
    expect(finalAnswerOf(lines, window)).toBe('this task done');
  });

  it('never takes a subagent\'s message or Tars\'s injected context (6)', () => {
    const lines = [
      assistant(2, 'mine', [text('the real answer')]),
      assistant(3, 'sub', [text('a subagent speaking')], { isSidechain: true }),
      assistant(4, 'meta', [text('context Tars injected')], { isMeta: true }),
    ];
    expect(finalAnswerOf(lines, window)).toBe('the real answer');
  });

  it('keeps a long answer whole, past the hooks\' 4000 bytes (7)', () => {
    const long = `${'é'.repeat(3000)} ${'answer '.repeat(1500)}END`;
    expect(Buffer.byteLength(long)).toBeGreaterThan(4000);
    expect(finalAnswerOf([assistant(2, 'm', [text(long)])], window)).toBe(long);
  });

  it('skips a damaged line and reads on (8)', () => {
    const lines = [assistant(2, 'a', [text('before')]), '{"type":"assistant", broken', assistant(3, 'b', [text('after')])];
    expect(finalAnswerOf(lines, window)).toBe('after');
    expect(finalAnswerOf([assistant(2, 'a', [text('before')]), '{oops'], window)).toBe('before');
  });

  it('is null when the agent wrote no text for the task (9)', () => {
    expect(finalAnswerOf([], window)).toBeNull();
    expect(finalAnswerOf([assistant(-5, 'old', [text('older')]), assistant(2, 'm', [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }])], window)).toBeNull();
    expect(finalAnswerOf([assistant(2, 'm', [text('   ')])], window)).toBeNull();
  });
});

describe('the final answer of a task, read from its sessions\' transcripts', () => {
  const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-answer-'));
  const write = (homeDir: string, project: string, sessionId: string, lines: string[]) => {
    const file = transcriptPath(project, sessionId, homeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n');
  };

  it('is read from the last session that answered (10)', async () => {
    const homeDir = home();
    const project = path.join(homeDir, 'p');
    fs.mkdirSync(project);
    write(homeDir, project, 's1', [assistant(2, 'a', [text('first session')])]);
    write(homeDir, project, 's2', [assistant(20, 'b', [text('second session, the end')])]);
    const task = { sessionIds: ['s1', 's2'], projectPath: project, worktreePath: null, startedAt: T0, endedAt: T0 + 60_000 };
    expect(await readFinalAnswer(task, homeDir)).toBe('second session, the end');
    // The later session wrote nothing for the task: the earlier one's answer stands.
    write(homeDir, project, 's3', [user(30, 'nothing said')]);
    expect(await readFinalAnswer({ ...task, sessionIds: ['s1', 's2', 's3'] }, homeDir)).toBe('second session, the end');
  });

  it('is read under the worktree the CLI ran in, before the project (10)', async () => {
    const homeDir = home();
    const project = path.join(homeDir, 'p');
    const tree = path.join(homeDir, 'w');
    fs.mkdirSync(project);
    fs.mkdirSync(tree);
    write(homeDir, tree, 's1', [assistant(2, 'a', [text('from the worktree')])]);
    expect(await readFinalAnswer({ sessionIds: ['s1'], projectPath: project, worktreePath: tree, startedAt: T0, endedAt: T0 + 60_000 }, homeDir)).toBe('from the worktree');
  });

  it('is read from the folder of the Claude account the agent runs on (12)', async () => {
    const homeDir = home();
    const project = path.join(homeDir, 'p');
    fs.mkdirSync(project);
    const accountHome = path.join(homeDir, 'acct');
    const file = path.join(accountHome, 'projects', encodeProjectDirName(project), 's1.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, assistant(2, 'a', [text('from account two')]) + '\n');
    const task = { sessionIds: ['s1'], projectPath: project, worktreePath: null, startedAt: T0, endedAt: T0 + 60_000 };
    expect(await readFinalAnswer(task, homeDir)).toBeNull();
    expect(await readFinalAnswer({ ...task, configDir: accountHome }, homeDir)).toBe('from account two');
  });

  it('is null, and throws nothing, when no transcript is there (11)', async () => {
    const homeDir = home();
    expect(await readFinalAnswer({ sessionIds: ['nope'], projectPath: path.join(homeDir, 'p'), worktreePath: null, startedAt: T0, endedAt: T0 + 1 }, homeDir)).toBeNull();
    expect(await readFinalAnswer({ sessionIds: [], projectPath: null, worktreePath: null, startedAt: T0, endedAt: null }, homeDir)).toBeNull();
  });
});
