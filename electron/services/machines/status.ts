import { readMachines } from './store';
import { ping } from './client';
import type { PeerStatus } from './types';

/**
 * Whether each paired machine is there, asked every ten seconds while
 * something is paired. The window is told only when a status or an agent
 * count moved.
 */
const known = new Map<string, { status: PeerStatus; lastSeen?: string; agentsRunning?: number }>();
let timer: NodeJS.Timeout | null = null;
/** A poll under way: the next tick skips rather than start a second one beside it. */
let current: Promise<void> | null = null;
/** Run before each poll (the bridge tried again, should Tailscale have come up since). */
let beforePoll: (() => Promise<void>) | undefined;

export const peerStatus = (id: string): { status: PeerStatus; lastSeen?: string; agentsRunning?: number } =>
  known.get(id) ?? { status: 'unknown' };

/** Forgets what was last seen of a machine forgotten here, which may be paired again under the same id. */
export function forgetStatus(id: string): void {
  known.delete(id);
}

function pollOnce(onChanged: () => void): Promise<void> {
  current ??= (async () => {
    await beforePoll?.();
    await pollPeers(onChanged);
  })().finally(() => { current = null; });
  return current;
}

/** A poll now, after the one under way: a machine just paired reads connected at once, not at the next tick. */
export async function pollNow(onChanged: () => void): Promise<void> {
  if (current) await current;
  await pollOnce(onChanged);
}

async function pollPeers(onChanged: () => void): Promise<void> {
  let moved = false;
  for (const peer of readMachines().peers) {
    const r = await ping(peer);
    const before = known.get(peer.id);
    const next = r.status === 'connected'
      ? { status: r.status as PeerStatus, lastSeen: new Date().toISOString(), agentsRunning: r.agentsRunning }
      : { status: r.status as PeerStatus, lastSeen: before?.lastSeen };
    if (before?.status !== next.status || before?.agentsRunning !== next.agentsRunning) moved = true;
    known.set(peer.id, next);
  }
  if (moved) onChanged();
}

export function startStatusPolling(onChanged: () => void, everyMs = 10_000, before?: () => Promise<void>): void {
  if (timer) return;
  beforePoll = before;
  void pollOnce(onChanged);
  timer = setInterval(() => { void pollOnce(onChanged); }, everyMs);
}

export function stopStatusPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
  beforePoll = undefined;
}
