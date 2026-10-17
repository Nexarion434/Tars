import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import { transcriptPath, transcriptRoots } from '../utils/resume-session';

/**
 * The answer delegate_task returns for a task typed into an agent's permanent
 * terminal (2.0.4): the agent's final message for that task, read from the
 * transcript Claude Code keeps (~/.claude/projects/<project>/<session>.jsonl),
 * in full. The hooks' copy of it (lastCleanOutput) is cut at 4000 bytes.
 *
 * Claude Code writes one record per content block, every block of one message
 * under the same message id: the final message is the last assistant message
 * with text in the task's time, and its text is all of its text blocks, in
 * order. A subagent's records (isSidechain) and Tars's injected context
 * (isMeta) are not the agent's answer.
 */

/** Slack after the end the ledger heard of: the Stop's post is made after the CLI wrote the record. */
const END_SLACK_MS = 2_000;
/** What an answer keeps: a million characters, far past any final message, under the API's 4 MB body. */
export const ANSWER_MAX = 1_000_000;

type Window = { since: number; until: number };

/** Reads lines one by one, keeping only the final message seen so far. */
function answerReader(window: Window) {
  let id: string | null = null;
  let parts: string[] = [];
  return {
    line(line: string): void {
      if (!line.includes('"assistant"')) return;
      let rec: { type?: unknown; timestamp?: unknown; isSidechain?: unknown; isMeta?: unknown; message?: { id?: unknown; content?: unknown } };
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }
      if (rec.type !== 'assistant' || rec.isSidechain === true || rec.isMeta === true) return;
      const at = Date.parse(String(rec.timestamp ?? ''));
      if (!Number.isFinite(at) || at < window.since || at > window.until) return;
      const content = Array.isArray(rec.message?.content) ? rec.message.content as Array<{ type?: unknown; text?: unknown }> : [];
      const texts = content.filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim()).map((b) => b.text as string);
      if (!texts.length) return;
      const messageId = typeof rec.message?.id === 'string' ? rec.message.id : null;
      if (messageId === null || messageId !== id) {
        id = messageId;
        parts = [];
      }
      parts.push(...texts);
    },
    answer(): string | null {
      if (!parts.length) return null;
      return Array.from(parts.join('\n\n')).slice(0, ANSWER_MAX).join('');
    },
  };
}

/** The final answer in these transcript lines, between `since` and `until` (epoch ms), or null. */
export function finalAnswerOf(lines: Iterable<string>, window: Window): string | null {
  const reader = answerReader(window);
  for (const line of lines) reader.line(line);
  return reader.answer();
}

/** One transcript, streamed: only the answer is kept, never a line of it. */
async function answerInFile(file: string, window: Window): Promise<string | null> {
  if (!fs.existsSync(file)) return null;
  const reader = answerReader(window);
  const input = fs.createReadStream(file, { encoding: 'utf-8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) reader.line(line);
  } catch {
    return reader.answer();
  } finally {
    lines.close();
    input.destroy();
  }
  return reader.answer();
}

/**
 * The final answer of a terminal task, from its sessions' transcripts, the
 * latest session that answered first; null when none is there to read (a CLI
 * that writes no such transcript, a session never written).
 */
export async function readFinalAnswer(
  task: { sessionIds: string[]; projectPath: string | null; worktreePath: string | null; startedAt: number; endedAt: number | null },
  homeDir = os.homedir(),
): Promise<string | null> {
  const window = { since: task.startedAt, until: (task.endedAt ?? Date.now()) + END_SLACK_MS };
  const roots = transcriptRoots(task.worktreePath ?? undefined, task.projectPath ?? undefined);
  for (const sessionId of [...task.sessionIds].reverse()) {
    for (const root of roots) {
      const answer = await answerInFile(transcriptPath(root, sessionId, homeDir), window);
      if (answer !== null) return answer;
    }
  }
  return null;
}
