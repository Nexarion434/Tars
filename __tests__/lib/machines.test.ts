import { describe, it, expect } from 'vitest';
import { statusLine, seenAgo, addressNote } from '../../src/lib/machines';

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
