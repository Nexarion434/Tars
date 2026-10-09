import { agents, onAgentOutput, saveAgents } from '../../core/agent-manager';
import { ptyProcesses, writeHumanInput, writeProgrammaticInput } from '../../core/pty-manager';
import { launchAgent, sessionStarting } from '../../core/agent-launch';
import { wakeAgent } from '../../core/agent-asleep';
import { noteRestartAfterStop, stopAgent } from '../../core/agent-stop';
import { broadcastToAllWindows } from '../../utils/broadcast';
import { scheduleTick } from '../../utils/agents-tick';
import { readMachines } from './store';
import { cliRunningIn } from '../../core/agent-pty';
import { terminalSnapshot } from '../../core/terminal-mirror';
import { withSessionTruth } from '../agent-truth';
import { shareFleet, terminalSize } from './fleet-share';
import type { BridgeDeps, DriveOutcome } from './bridge-server';
import type { AgentStatus } from '../../types';

/**
 * This machine's agents, as the bridge serves them to a paired machine: the
 * fleet (what fleet-share lets travel), one agent's screen, and one agent's
 * live output until its terminal ends.
 */
const terminalOf = (agent: AgentStatus | undefined) => (agent?.ptyId ? ptyProcesses.get(agent.ptyId) : undefined);

const done: DriveOutcome = { ok: true };
const here = () => readMachines().self.name;
const notHere = (): DriveOutcome => ({ ok: false, status: 404, error: `There is no such agent on ${here()}.` });
const nameOf = (agent: AgentStatus) => agent.name || agent.id;

/**
 * Who a machine's action is filed under: its paired name, said to be a
 * machine, so one named "you" or "Tars" reads as neither.
 */
const asMachine = (name: string) => `${name} (machine)`;

/**
 * Driving this machine's agents from a paired machine this one lets drive
 * (bridge-server checks that first): what the window's own start and stop do,
 * filed under that machine's name, and a message typed after its sender line.
 */
/** The agents a paired machine's start is on its way for. */
const startsUnderWay = new Set<string>();

/** One start, as the window's own start or wake runs it. */
async function startOne(agent: AgentStatus, by: string): Promise<DriveOutcome> {
  // Woken by that machine, as the window's wake does it, its waker undone should the launch fail.
  if (agent.status === 'asleep') {
    const woken = await wakeAgent(agent, asMachine(by), 'start');
    return woken.success ? done : { ok: false, status: 409, error: woken.error };
  }
  noteRestartAfterStop(agent, asMachine(by));
  try {
    const result = await launchAgent(agent.id, '');
    return result.success ? done : { ok: false, status: 409, error: result.error };
  } catch (err) {
    // A missing project folder, a CLI Windows cannot start: the sentence, not a bare 500.
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
}

const drive: NonNullable<BridgeDeps['drive']> = {
  start: async (agentId, by) => {
    const agent = agents.get(agentId);
    if (!agent) return notHere();
    // One launch at a time: a second would type its line into the first CLI.
    // A remote start on its way counts, a stopped agent's included, which stays
    // stopped until its launch clears the stop; the record of a launch a stop
    // ended does not.
    if (startsUnderWay.has(agentId) || (agent.status !== 'stopped' && sessionStarting(agent))) {
      return { ok: false, status: 409, error: `${nameOf(agent)} is starting already.` };
    }
    startsUnderWay.add(agentId);
    try {
      return await startOne(agent, by);
    } finally {
      startsUnderWay.delete(agentId);
    }
  },
  stop: async (agentId, by, reason) => {
    const agent = agents.get(agentId);
    if (!agent) return notHere();
    const stopped = await stopAgent(agent, { by: asMachine(by), reason }, {
      save: saveAgents,
      announce: a => {
        broadcastToAllWindows('agent:status', { type: 'status', agentId: a.id, status: a.status, timestamp: a.lastActivity });
        scheduleTick();
      },
    });
    return stopped ? done : { ok: false, status: 409, error: `${nameOf(agent)} is stopped already.` };
  },
  message: async (agentId, by, text) => {
    const agent = agents.get(agentId);
    if (!agent) return notHere();
    const terminal = terminalOf(agent);
    if (!terminal || !cliRunningIn(terminal)) return { ok: false, status: 409, error: `${nameOf(agent)} is not running on ${here()}: start it first.` };
    const outcome = writeProgrammaticInput(terminal, text, true, { agentId, from: by, sender: { kind: 'machine', name: by } });
    return outcome === 'refused' ? { ok: false, status: 409, error: `${nameOf(agent)} did not take the message.` } : done;
  },
  // As this window's own keys reach an agent (agent:input), and only while its
  // CLI runs: never into the bare shell of a terminal whose CLI has ended.
  keys: async (agentId, _by, data) => {
    const agent = agents.get(agentId);
    if (!agent) return notHere();
    const terminal = terminalOf(agent);
    if (!terminal || !cliRunningIn(terminal)) return { ok: false, status: 409, error: `${nameOf(agent)} is not running on ${here()}: start it first.` };
    writeHumanInput(terminal, data);
    return done;
  },
};

export function fleetSource(): Required<Pick<BridgeDeps, 'fleet' | 'screenOf' | 'onOutput' | 'drive'>> {
  return {
    drive,
    // As agent:list reads them: the branch and the model from the session when they disagree with the record.
    fleet: () => shareFleet([...agents.values()].map(agent => {
      const terminal = terminalOf(agent);
      return withSessionTruth({ ...agent, output: [], cliRunning: cliRunningIn(terminal), cols: terminal?.cols, rows: terminal?.rows });
    })),
    // As agent:get shows a panel: the terminal's screen, or the kept tail where it has no mirror.
    screenOf: (agentId) => {
      const agent = agents.get(agentId);
      const terminal = terminalOf(agent);
      if (!agent || !terminal) return null;
      return { screen: terminalSnapshot(terminal) ?? agent.output.join(''), cliRunning: cliRunningIn(terminal), ...terminalSize(terminal.cols, terminal.rows) };
    },
    // Until the terminal the stream opened on ends: a restart opens another, which the caller reads again.
    onOutput: (agentId, listener, onEnd) => {
      const terminal = terminalOf(agents.get(agentId));
      if (!terminal) return null;
      const stopListening = onAgentOutput((id, chunk) => { if (id === agentId) listener(chunk); });
      const exit = terminal.onExit(() => onEnd());
      return () => { stopListening(); exit.dispose(); };
    },
  };
}
