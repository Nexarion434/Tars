/**
 * When a snooze of the chat list ends, and how a snoozed row says it, in the
 * person's own time. Frame: `Shell · chats · a chat's actions · states`.
 */

export type SnoozeChoice = 'hour' | 'tomorrow' | 'monday';

export function snoozeUntil(choice: SnoozeChoice, now: Date): Date {
  if (choice === 'hour') return new Date(now.getTime() + 60 * 60_000);
  const at = new Date(now);
  at.setHours(9, 0, 0, 0);
  if (choice === 'tomorrow') {
    at.setDate(at.getDate() + 1);
    return at;
  }
  // The next Monday, never today: Sunday is 0, Monday 1.
  at.setDate(at.getDate() + (((8 - at.getDay()) % 7) || 7));
  return at;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "until 9:05" for a snooze ending today, "until Tue 9:00" for another day; null without a date that parses. */
export function snoozeLabel(until: string | null, now: Date): string | null {
  if (!until) return null;
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) return null;
  const time = `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`;
  return at.toDateString() === now.toDateString() ? `until ${time}` : `until ${DAYS[at.getDay()]} ${time}`;
}
