import { describe, it, expect } from 'vitest';
import { statusLine, seenAgo, addressNote, requestLine } from '../../src/lib/machines';

/**
 * The words under each paired machine. How they can fail, written before the code:
 * 1. A connected machine reads "offline", or its agents are not counted, or
 *    one agent reads "1 agents".
 * 2. "last seen" is missing for an offline machine that was seen, or shows
 *    a negative time or a raw date.
 * 3. A machine that forgot this one reads offline instead of saying so.
 * 4. The bridge cannot listen while machines are paired (the port is held,
 *    the firewall refused) and the address row still shows the address,
 *    so nothing says why no machine reaches this one (final review,
 *    Important 4); or a bridge merely not started yet reads as a fault.
 * 5. A machine asking to pair is not named as Tailscale knows it, or a
 *    caller Tailscale does not list reads as if it did; the time left to
 *    answer is missing, negative or a raw date.
 */
const now = new Date('2026-10-02T15:00:00Z');
const base = { id: 'm-bbbbbbbbbbbbbbbb', name: 'PC', address: '100.64.0.2', mayOnMe: 'see' as const };

describe('statusLine', () => {
  it('counts the agents of a connected machine (1)', () => {
    expect(statusLine({ ...base, status: 'connected', agentsRunning: 4, lastSeen: now.toISOString() }, now)).toBe('4 agents running · seen now');
    expect(statusLine({ ...base, status: 'connected', agentsRunning: 1, lastSeen: now.toISOString() }, now)).toBe('1 agent running · seen now');
  });

  it('says when an offline machine was last seen (2)', () => {
    expect(statusLine({ ...base, status: 'offline', lastSeen: '2026-10-02T14:58:00Z' }, now)).toBe('offline · last seen 2 min ago');
    expect(statusLine({ ...base, status: 'offline' }, now)).toBe('offline · not seen since Tars started');
  });

  it('says a machine forgot this one (3)', () => {
    expect(statusLine({ ...base, status: 'unpaired' }, now)).toBe('PC no longer knows this machine. Forget it here, and pair again if you want.');
  });
});

describe('seenAgo', () => {
  it.each([
    ['2026-10-02T15:00:00Z', 'now'],
    ['2026-10-02T14:59:30Z', 'now'],
    ['2026-10-02T14:58:00Z', '2 min ago'],
    ['2026-10-02T12:00:00Z', '3 h ago'],
    ['2026-09-29T15:00:00Z', '3 days ago'],
    ['2026-10-02T15:05:00Z', 'now'],
  ])('%s reads %s (2)', (iso, words) => {
    expect(seenAgo(iso, now)).toBe(words);
  });
});

describe('addressNote', () => {
  const view = (o: { running?: boolean; listening?: boolean; reason?: string; peers?: number }) => ({
    tailscale: { installed: true, running: o.running ?? true },
    bridge: { listening: o.listening ?? false, reason: o.reason },
    peers: Array.from({ length: o.peers ?? 0 }, () => ({ ...base, status: 'unknown' as const })),
  });

  it('says Tailscale is off, whatever else (4)', () => {
    expect(addressNote(view({ running: false, reason: 'x', peers: 1 }))).toBe('Tailscale is not running');
  });

  it('gives why the bridge cannot listen while machines are paired (4)', () => {
    const why = 'The bridge could not listen on 100.64.0.1:31418 (EADDRINUSE).';
    expect(addressNote(view({ reason: why, peers: 1 }))).toBe(why);
  });

  it('shows the address when the bridge listens, or has nothing to listen for (4)', () => {
    expect(addressNote(view({ listening: true, peers: 1 }))).toBeNull();
    expect(addressNote(view({ peers: 0 }))).toBeNull();
    expect(addressNote(view({ peers: 1 }))).toBeNull();
  });
});

describe('requestLine', () => {
  const ask = { name: 'MacBook-Pro-de-Nicolas-2.local', address: '100.76.84.44', expiresAt: '2026-10-02T15:00:52Z' };

  it('names the machine as Tailscale knows it, and the time left to answer (5)', () => {
    expect(requestLine({ ...ask, device: 'macbook-pro-de-nicolas-2' }, now)).toBe("MacBook-Pro-de-Nicolas-2.local wants to pair with this machine. Tailscale knows it as macbook-pro-de-nicolas-2, 100.76.84.44. Accept only if you just typed this machine's code there: it will be able to type into your agents here, unless you set it to See. It waits 0:52 for your answer.");
  });

  it('gives only the address of a caller Tailscale does not list, and never a negative time (5)', () => {
    expect(requestLine({ ...ask, expiresAt: '2026-10-02T14:59:00Z' }, now)).toBe("MacBook-Pro-de-Nicolas-2.local wants to pair with this machine, from 100.76.84.44. Accept only if you just typed this machine's code there: it will be able to type into your agents here, unless you set it to See. It waits 0:00 for your answer.");
  });
});
