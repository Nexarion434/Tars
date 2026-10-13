/**
 * What the chat list says once a chat is deleted, from chat:delete's answer:
 * the wip/ branch its runner's uncommitted work was saved on (savedTo), and
 * why its runner's worktree stays on disk, and where (worktreeKept, the main
 * process's own sentence). Null when nothing stays, and for a refusal, which
 * its row says. Frame: `Shell · chats · a chat's actions · states`, DELETED:
 * WHAT STAYS, AND WHERE, in tars-redesign.pen. Tests:
 * __tests__/lib/chat-deleted.test.ts.
 */

export interface DeletedNotice {
  /** The chat deleted, and its worktree when it stays: why, and where. */
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

export function deletedNotice(answer: unknown, chat: { project: string; number: number; title: string }): DeletedNotice | null {
  const a = answer as Record<string, unknown> | null;
  if (!a || typeof a !== 'object' || a.success !== true) return null;
  const kept = wordsOf(a.worktreeKept);
  const branch = wordsOf(a.savedTo);
  if (!kept && !branch) return null;
  const name = `${chat.project} #${chat.number}, ${chat.title}`;
  return {
    text: kept ? `Deleted ${name}, but not its worktree: ${kept}.` : stop(`Deleted ${name}`),
    saved: branch ? `Its uncommitted work is on the branch ${branch}.` : null,
  };
}
