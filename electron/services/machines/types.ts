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

/**
 * An agent of another machine, as this one shows it (bridge `GET
 * /machines/v1/fleet`). Picked field by field on the machine it runs on:
 * never a token, an env, a CLI path, a path other than its project's, nor its
 * terminal history, which only `screen` and `stream` carry, for one agent.
 */
export interface RemoteAgent {
  /** `m:<machineId>:<agentId>`: never an id of this machine's own fleet. */
  id: string;
  /** Its id on its own machine. */
  agentId: string;
  /**
   * Its machine. drive: that machine lets this one start, stop and message
   * its agents (its own Settings > Machines decides, and checks each action).
   */
  machine: { id: string; name: string; status: PeerStatus; offlineSince?: string; drive?: boolean };
  name: string;
  character?: string;
  provider?: string;
  model?: string;
  status: string;
  currentTask?: string;
  branch?: string;
  projectName: string;
  /** The project's path on its own machine, shown, never opened here. */
  projectPath: string;
  cliRunning: boolean;
  lastActivity?: string;
  stoppedBy?: string;
  stopReason?: string;
  /**
   * The size its terminal draws for: a full-screen CLI places every line by
   * it, so a pane showing it takes this size, never its own.
   */
  cols?: number;
  rows?: number;
}

/** What driving a remote agent answers: done, or the other machine's sentence why not. */
export type DriveResult = { success: true } | { success: false; error: string };

/** A remote agent's terminal as it is now (bridge `GET /machines/v1/agents/:id/screen`), and the size it was drawn for. */
export interface RemoteScreen { screen: string; cliRunning: boolean; cols?: number; rows?: number }
