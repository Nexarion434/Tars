import { describe, it, expect } from 'vitest';
import { memoryHeadroom, startAllowed } from '../../../electron/platform/memory-headroom';

/**
 * The memory a Tars server has left before it starts an agent
 * (platform/memory-headroom.ts, docs/superpowers/plans/2026-11-03-tars-cloud-m3.md,
 * Task 3). On the VPS of 2026-11-03: about 2 GB free, Hermes about 1.1 GB, a
 * Claude Code agent about 300 MB, a build that bottomed at 1.16 GB.
 *
 * How it fails, written before the code:
 * 1. linux: the free memory read from anything but MemAvailable (MemFree
 *    leaves the page cache out), or in another unit than MB
 * 2. in a container: the cgroup's room (memory.max minus memory.current)
 *    ignored when it is lower than the host's, or used when memory.max is
 *    `max` (no limit), or a malformed value read as a number
 * 3. an unreadable /proc/meminfo blocks a start (it says nothing: null)
 * 4. darwin and win32: anything but os.freemem
 * 5. a start allowed that leaves the server under the floor once the agent
 *    runs (free minus 300 MB under 1024 MB), or refused above it; the
 *    sentence not saying how much is free and how much Tars keeps
 */

const MB = 1024 * 1024;
const files = (map: Record<string, string>) => (p: string) => {
  if (p in map) return map[p];
  throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
};
const MEMINFO = 'MemTotal:        8130560 kB\nMemFree:          262144 kB\nMemAvailable:    2097152 kB\nBuffers:           1000 kB\n';

describe('memoryHeadroom', () => {
  it('1. linux: MemAvailable, in MB', () => {
    expect(memoryHeadroom({ platform: 'linux', readFile: files({ '/proc/meminfo': MEMINFO }) })).toEqual({ availableMb: 2048, source: 'host' });
  });

  it('2. in a container, the cgroup\'s room when it is lower', () => {
    const cgroup = { '/proc/meminfo': MEMINFO, '/sys/fs/cgroup/memory.max': `${3072 * MB}\n`, '/sys/fs/cgroup/memory.current': `${2560 * MB}\n` };
    expect(memoryHeadroom({ platform: 'linux', readFile: files(cgroup) })).toEqual({ availableMb: 512, source: 'cgroup' });
    const roomy = { ...cgroup, '/sys/fs/cgroup/memory.current': `${100 * MB}\n` };
    expect(memoryHeadroom({ platform: 'linux', readFile: files(roomy) })).toEqual({ availableMb: 2048, source: 'host' });
  });

  it('2. memory.max at max, or malformed, is no limit', () => {
    expect(memoryHeadroom({ platform: 'linux', readFile: files({ '/proc/meminfo': MEMINFO, '/sys/fs/cgroup/memory.max': 'max\n', '/sys/fs/cgroup/memory.current': '1\n' }) }))
      .toEqual({ availableMb: 2048, source: 'host' });
    expect(memoryHeadroom({ platform: 'linux', readFile: files({ '/proc/meminfo': MEMINFO, '/sys/fs/cgroup/memory.max': 'lots\n', '/sys/fs/cgroup/memory.current': 'x\n' }) }))
      .toEqual({ availableMb: 2048, source: 'host' });
  });

  it('3. an unreadable or odd /proc/meminfo says nothing', () => {
    expect(memoryHeadroom({ platform: 'linux', readFile: files({}) })).toBeNull();
    expect(memoryHeadroom({ platform: 'linux', readFile: files({ '/proc/meminfo': 'MemTotal: 1 kB\n' }) })).toBeNull();
  });

  it.each(['darwin', 'win32'] as const)('4. %s: os.freemem', (platform) => {
    expect(memoryHeadroom({ platform, freemem: () => 1536 * MB, readFile: files({}) })).toEqual({ availableMb: 1536, source: 'host' });
  });
});

describe('startAllowed', () => {
  it('5. refuses a start that would leave the server under the floor, and says how much is free', () => {
    expect(startAllowed({ availableMb: 900, source: 'host' })).toBe('Not started: this server has 900 MB of memory free, and Tars keeps 1 GB for the rest of it.');
    expect(startAllowed({ availableMb: 1300, source: 'cgroup' })).toMatch(/^Not started: this server has 1300 MB/);
    expect(startAllowed({ availableMb: 1324, source: 'host' })).toBeNull();
    expect(startAllowed({ availableMb: 4000, source: 'host' }, 2048)).toBeNull();
    expect(startAllowed({ availableMb: 2000, source: 'host' }, 2048)).toBe('Not started: this server has 2000 MB of memory free, and Tars keeps 2 GB for the rest of it.');
    expect(startAllowed({ availableMb: 1700, source: 'host' }, 1500)).toBe('Not started: this server has 1700 MB of memory free, and Tars keeps 1500 MB for the rest of it.');
    expect(startAllowed(null)).toBeNull();
    // Security review 1, N2: each start still coming up holds an agent's memory too.
    expect(startAllowed({ availableMb: 1700, source: 'host' }, 1024, 300, 1)).toBeNull();
    expect(startAllowed({ availableMb: 1700, source: 'host' }, 1024, 300, 2)).toMatch(/^Not started: this server has 1700 MB/);
  });
});
