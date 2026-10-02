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

export const peerStatus = (id: string): { status: PeerStatus; lastSeen?: string; agentsRunning?: number } =>
  known.get(id) ?? { status: 'unknown' };

async function pollOnce(onChanged: () => void): Promise<void> {
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

export function startStatusPolling(onChanged: () => void, everyMs = 10_000): void {
  if (timer) return;
  void pollOnce(onChanged);
  timer = setInterval(() => { void pollOnce(onChanged); }, everyMs);
}

export function stopStatusPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
