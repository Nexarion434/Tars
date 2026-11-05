import * as fs from 'fs';
import * as os from 'os';

/**
 * The memory a Tars server has left, read before it starts an agent
 * (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md, Task 3). The VPS of
 * the real test had about 2 GB free beside Hermes (about 1.1 GB), and a
 * Claude Code agent takes about 300 MB: a start that would leave the box
 * under the floor (1 GB unless the server's settings say otherwise) is
 * refused, with a sentence.
 *
 * linux: MemAvailable from /proc/meminfo (MemFree leaves out the cache the
 * kernel gives back), and, in a container, the cgroup's room (memory.max
 * minus memory.current, cgroup v2), the smaller of the two: a container's
 * /proc/meminfo is the host's. darwin and win32: os.freemem. Nothing
 * readable: null, which blocks nothing.
 */

export interface Headroom { availableMb: number; source: 'host' | 'cgroup' }

const MB = 1024 * 1024;

export function memoryHeadroom(deps: {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  freemem?: () => number;
} = {}): Headroom | null {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') return { availableMb: Math.floor((deps.freemem ?? os.freemem)() / MB), source: 'host' };
  const read = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  let meminfo: string;
  try { meminfo = read('/proc/meminfo'); } catch { return null; }
  const kb = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  if (!kb) return null;
  const hostMb = Math.floor(Number(kb[1]) / 1024);
  let cgroupMb: number | null = null;
  try {
    const max = read('/sys/fs/cgroup/memory.max').trim();
    const current = read('/sys/fs/cgroup/memory.current').trim();
    if (/^\d+$/.test(max) && /^\d+$/.test(current)) cgroupMb = Math.floor(Math.max(0, Number(max) - Number(current)) / MB);
  } catch { /* not in a cgroup v2 with a limit */ }
  return cgroupMb !== null && cgroupMb < hostMb ? { availableMb: cgroupMb, source: 'cgroup' } : { availableMb: hostMb, source: 'host' };
}

/** What an agent takes, about: a Claude Code CLI measured on the VPS. */
export const AGENT_MB = 300;
export const DEFAULT_FLOOR_MB = 1024;

/** Null when a start leaves the floor free, counting the starts still coming up (`inFlight`), else the sentence a client shows. */
export function startAllowed(headroom: Headroom | null, floorMb: number = DEFAULT_FLOOR_MB, agentMb: number = AGENT_MB, inFlight = 0): string | null {
  if (!headroom || headroom.availableMb - agentMb * (1 + inFlight) >= floorMb) return null;
  const kept = floorMb % 1024 === 0 ? `${floorMb / 1024} GB` : `${floorMb} MB`;
  return `Not started: this server has ${headroom.availableMb} MB of memory free, and Tars keeps ${kept} for the rest of it.`;
}

/**
 * The starts still coming up (security review 1, N2): each holds an agent's
 * memory for `holdMs`, which MemAvailable does not show yet, so starts made
 * together cannot all pass the floor on the same reading.
 */
export function startsInFlight(holdMs = 30_000, now: () => number = Date.now): { count(): number; add(): void } {
  const at: number[] = [];
  const count = () => { while (at.length > 0 && now() - at[0] >= holdMs) at.shift(); return at.length; };
  return { count, add: () => { count(); at.push(now()); } };
}
