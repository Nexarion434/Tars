import { agents, onAgentOutput } from '../../core/agent-manager';
import { ptyProcesses } from '../../core/pty-manager';
import { cliRunningIn } from '../../core/agent-pty';
import { terminalSnapshot } from '../../core/terminal-mirror';
import { withSessionTruth } from '../agent-truth';
import { shareFleet, terminalSize } from './fleet-share';
import type { BridgeDeps } from './bridge-server';
import type { AgentStatus } from '../../types';

/**
 * This machine's agents, as the bridge serves them to a paired machine: the
 * fleet (what fleet-share lets travel), one agent's screen, and one agent's
 * live output until its terminal ends.
 */
const terminalOf = (agent: AgentStatus | undefined) => (agent?.ptyId ? ptyProcesses.get(agent.ptyId) : undefined);

export function fleetSource(): Required<Pick<BridgeDeps, 'fleet' | 'screenOf' | 'onOutput'>> {
  return {
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
