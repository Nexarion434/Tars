import type { AgentTaskBanner } from '@/types/electron';

/**
 * What the banner above an agent's terminal says (design PR #451, on #453's
 * contract): who gave the task in hand, since when and for how long, its first
 * line, and who gave the tasks that wait. Pure, so the banner draws it and the
 * tests read it.
 */

/**
 * What may not reach a banner line: what a reader takes for a line break, and
 * what shows as nothing or turns the line around. The same class the message
 * notice flattens (MessageWaitingNotice), for the same reason: a name or a
 * task's first line is free text, and U+202E reverses the whole line.
 */
const HIDDEN_OR_LINE_BREAKING = /[\p{Zl}\p{Zp}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]+/gu;

/** One line of free text, flattened and cut at `max` characters (code points, so an emoji is never split). */
export function cleanLine(text: string, max: number): string {
  const flat = text.replace(HIDDEN_OR_LINE_BREAKING, ' ').replace(/ {2,}/g, ' ').trim();
  const points = [...flat];
  return points.length > max ? points.slice(0, max - 1).join('') + '…' : flat;
}

/** How long since a task began: now, minutes, then hours and minutes. Empty for a date that does not parse. */
export function elapsedSince(iso: string, now: number): string {
  const start = Date.parse(iso);
  if (Number.isNaN(start)) return '';
  const minutes = Math.floor(Math.max(0, now - start) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${String(rest).padStart(2, '0')}` : ''}`;
}

/** The local hour and minute of a moment, as the banner says "since 14:02". */
export function clockOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Who gave the waiting tasks, each once, in the order they run: two names, then how many more. */
export function sendersOf(waiting: AgentTaskBanner['waiting']): string {
  const names: string[] = [];
  for (const w of waiting) {
    const name = cleanLine(w.from, 40);
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length <= 2) return names.join(', ');
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
