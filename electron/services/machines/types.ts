/** What a paired machine may do on this one: see its agents, or also drive them. */
export type PeerPermission = 'see' | 'drive';

export interface MachineSelf { id: string; name: string }

export interface PairedMachine {
  id: string;
  name: string;
  /** Where its bridge answers: its tailnet IPv4 (or 127.0.0.1 in a development run). */
  address: string;
  port: number;
  /** sha256 of the secret this Tars issued to it: what it presents here. */
  inboundSecretHash: string;
  /** The secret it issued to this Tars: what this Tars presents there. */
  outboundSecret: string;
  /** What it may do on this machine. */
  mayOnMe: PeerPermission;
  pairedAt: string;
}

/** ~/.tars-private/machines.json */
export interface MachinesFile { version: 1; self: MachineSelf; peers: PairedMachine[] }

export type PeerStatus = 'connected' | 'offline' | 'unpaired' | 'unknown';

/** A paired machine as the window sees it: never a secret, never a hash. */
export interface MachineView {
  id: string;
  name: string;
  address: string;
  mayOnMe: PeerPermission;
  status: PeerStatus;
  lastSeen?: string;
  agentsRunning?: number;
}

/** Everything Settings > Machines shows. */
export interface MachinesView {
  self: MachineSelf & { address?: string };
  tailscale: { installed: boolean; running: boolean };
  bridge: { listening: boolean; reason?: string };
  offer: { code: string; expiresAt: string } | null;
  /** A machine that knocked, with no proof yet, and waits for the person here to accept it. */
  request: { name: string; device?: string; address: string; expiresAt: string } | null;
  peers: MachineView[];
}
