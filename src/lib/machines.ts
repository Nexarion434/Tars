import type { MachineView, MachinesView } from '@/types/electron';

/**
 * The words Settings > Machines writes under each paired machine. Frame:
 * `Settings · Machines` in design/tars-redesign.pen.
 */

/** "now", "2 min ago", "3 h ago", "3 days ago"; a time ahead of this clock reads now. */
export function seenAgo(iso: string | undefined, now: Date): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} days ago`;
}

export function statusLine(m: MachineView, now: Date): string {
  if (m.status === 'unpaired') return `${m.name} no longer knows this machine. Forget it here, and pair again if you want.`;
  if (m.status === 'connected') {
    const n = m.agentsRunning ?? 0;
    return `${n} ${n === 1 ? 'agent' : 'agents'} running · seen ${seenAgo(m.lastSeen, now)}`;
  }
  return m.lastSeen ? `offline · last seen ${seenAgo(m.lastSeen, now)}` : 'offline · not seen since Tars started';
}

/**
 * What the address row says in place of the address, or null to show it:
 * that Tailscale is off, or why the bridge cannot listen while machines are
 * paired. A bridge with nothing paired and no code shown is not started, and
 * that is no fault.
 */
export function addressNote(view: Pick<MachinesView, 'tailscale' | 'bridge' | 'peers'>): string | null {
  if (!view.tailscale.running) return 'Tailscale is not running';
  if (!view.bridge.listening && view.bridge.reason && view.peers.length > 0) return view.bridge.reason;
  return null;
}
