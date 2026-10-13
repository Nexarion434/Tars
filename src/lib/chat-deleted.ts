/**
 * What the chat list says once a chat is deleted, from chat:delete's answer,
 * and the Agents page once an agent is, from agent:remove's (2.0.1): the wip/
 * branch the uncommitted work was saved on (savedTo), and why the worktree
 * stays on disk, and where (worktreeKept, the main process's own sentence).
 * Null when nothing stays, and for a refusal or a failure, said elsewhere.
 * Frames: `Shell · chats · a chat's actions · states`, DELETED: WHAT STAYS, AND
 * WHERE, and `Agents · an agent deleted, what stays and where`, in
 * tars-redesign.pen. Tests: __tests__/lib/chat-deleted.test.ts.
 */

export interface DeletedNotice {
  /** What was deleted, and its worktree when it stays: why, and where. */
  text: string;
  /** The branch its uncommitted work is on; null when nothing was saved. */
  saved: string | null;
}

/** A sentence's words without the full stop it may end with; null when there are none. */
function wordsOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().replace(/[.\s]+$/, '') || null;
}

const stop = (sentence: string) => (/[.!?…]$/.test(sentence) ? sentence : `${sentence}.`);

/** What a deletion leaves, said of `name`, as the reader knows what was deleted. */
function noticeOf(answer: unknown, name: string): DeletedNotice | null {
  const a = answer as Record<string, unknown> | null;
  if (!a || typeof a !== 'object' || a.success !== true) return null;
  const kept = wordsOf(a.worktreeKept);
  const branch = wordsOf(a.savedTo);
  if (!kept && !branch) return null;
  return {
    text: kept ? `Deleted ${name}, but not its worktree: ${kept}.` : stop(`Deleted ${name}`),
    saved: branch ? `Its uncommitted work is on the branch ${branch}.` : null,
  };
}

export function deletedNotice(answer: unknown, chat: { project: string; number: number; title: string }): DeletedNotice | null {
  return noticeOf(answer, `${chat.project} #${chat.number}, ${chat.title}`);
}

/** An agent deleted from the Agents page, by its name: agent:remove answers the same two fields. */
export function agentDeletedNotice(answer: unknown, name: string): DeletedNotice | null {
  return noticeOf(answer, name);
}
