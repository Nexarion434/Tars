import { agents, onAgentOutput, saveAgents } from '../../core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../../core/pty-manager';
import { launchAgent } from '../../core/agent-launch';
import { noteWaker } from '../../core/agent-asleep';
import { stopAgent } from '../../core/agent-stop';
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
 * Driving this machine's agents from a paired machine this one lets drive
 * (bridge-server checks that first): what the window's own start and stop do,
 * filed under that machine's name, and a message typed after its sender line.
 */
const drive: NonNullable<BridgeDeps['drive']> = {
  start: async (agentId, by, prompt) => {
    const agent = agents.get(agentId);
    if (!agent) return notHere();
    // Started while asleep: woken by that machine (core/agent-asleep.ts).
    if (agent.status === 'asleep') noteWaker(agentId, by, 'start');
    const result = await launchAgent(agentId, prompt ?? '');
    return result.success ? done : { ok: false, status: 409, error: result.error };
  },
  stop: async (agentId, by, reason) => {
    const agent = agents.get(agentId);
    if (!agent) return notHere();
    const stopped = await stopAgent(agent, { by, reason }, {
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
