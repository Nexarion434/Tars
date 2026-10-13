import type { Skill } from './skills-database';

const UNITS = ['K', 'M', 'B'];

/**
 * How many times a skill was installed, as the Extensions page writes it, the
 * way the frame `Extensions · Skills` does: one decimal always, in K, M or B
 * ("3.0M", "27.9K", "2.0K"), and a count under a thousand as it is.
 *
 * Written here from the count main sends (`installsNum`), not from the text it
 * formats beside it: that text drops a ".0" and knows no unit above K, so a
 * count on a round thousand read "1113K" beside "1300.1K", and the listing main
 * keeps on disk serves such texts for an hour after each fetch. A count the
 * page cannot vouch for, and the built-in list, which has none, show the text.
 */
export function installsLabel(skill: Pick<Skill, 'installs' | 'installsNum'>): string {
  const n: unknown = skill.installsNum;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return skill.installs;
  const whole = Math.round(n);
  if (whole < 1000) return String(whole);
  let value = whole / 1000;
  let unit = 0;
  // 999,950 rounds to "1000.0" in thousands: it is written "1.0M".
  while (unit < UNITS.length - 1 && Number(value.toFixed(1)) >= 1000) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1)}${UNITS[unit]}`;
}
