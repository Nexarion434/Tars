'use client';

import { AgentMark, Button, MachineBadge } from '@/components/ui';
import { useState } from 'react';
import { readOnlyTitle, remoteActions, type PaneAgent } from '@/lib/machines';
import { useRemoteDrive } from '@/hooks/useRemoteDrive';
import { MachineStopReason } from '@/components/MachineStopReason';
import { errorReason } from '@/app/agents/constants';
import { stopLine } from '@/lib/stop-line';
import { permissionAskLine } from '@/lib/permission-ask';
import { asleepLine, wakingLine } from '@/lib/asleep-line';
import AgentStatusWord from '@/components/AgentStatusWord';
import { AgentAccountControl } from '@/components/ClaudeAccounts/AgentAccountControl';

// Row actions are words, not glyphs (R7): one 26px bordered lowercase-mono
// button each, sitting inside the card padding - the card has no footer band.
const ROW_ACTION = 'font-mono lowercase';

interface AgentManagementCardProps {
  agent: PaneAgent;
  onClick: () => void;
  onEdit: () => void;
  onStart: () => void;
  onStop: () => void;
  /** An asleep agent's CLI started again on its own conversation (PR 322). */
  onWake: () => void;
  /**
   * The fourth word-button the frame draws (`a delete`). This is the only place
   * an agent can be destroyed for good, which is what the Dashboard's panel menu
   * has been telling people since removal there became a reversible hide.
   */
  onDelete: () => void;
  /** @deprecated No longer reachable from the card - the design keeps four actions. */
  onSaveAsTemplate?: () => void;
}

export function AgentManagementCard({ agent, onClick, onEdit, onStart, onStop, onWake, onDelete }: AgentManagementCardProps) {
  const isRunning = agent.status === 'running' || agent.status === 'waiting';

  // Show the user's last prompt, not terminal output
  const lastPrompt = agent.currentTask || null;
  const reason = errorReason(agent);
  // Who stopped it, when and why. Frame: `Agent stopped · who and why`.
  const stop = stopLine(agent);
  // A permission question Tars holds for it: what the call would do, which
  // its window answers. Frame: `Permission asked of Tars`.
  const ask = permissionAskLine(agent);
  // Asleep since when, or who is waking it. Frame: `Agent asleep · and how it wakes`.
  const waking = wakingLine(agent);
  const sleep = waking ?? asleepLine(agent);
  const provider = agent.provider || 'claude';
  const model = provider === 'local' ? agent.localModel : agent.model;
  // Provider, model and branch as plain words, the way the frame writes them.
  const facts = [provider, model, agent.branchName].filter(Boolean).join(' · ');
  // Another machine's agent is shown, never driven from here: its actions are
  // off, and say where it runs. Frame: `Agents · two machines`.
  const remote = agent.remote;
  const readOnly = remote ? readOnlyTitle(remote.machineName) : undefined;
  const machineOffline = !!remote && remote.status !== 'connected';
  // Where its machine lets this one drive it, start and stop work, over the
  // bridge; stop asks why first. Edit and delete never do.
  const drive = useRemoteDrive(agent.id);
  const [askStop, setAskStop] = useState(false);
  const allowed = remote ? remoteActions(remote, isRunning) : null;

  return (
    <div
      onClick={remote ? undefined : onClick}
      data-agent-card={agent.id}
      className={`transition-colors border border-border bg-card ${remote ? 'cursor-default' : 'cursor-pointer hover:bg-secondary'}`}
    >
      <div className="p-3 flex flex-col gap-2">
        {/* Row 1: the agent's mark + name, raw status word right-aligned (R6).
            The word carries the status; the mark says who it is. */}
        <div className="flex items-center gap-2">
          <AgentMark name={agent.name || agent.id} orchestrator={agent.role === 'orchestrator'} />
          <span className="flex-1 min-w-0 truncate text-xs font-semibold text-foreground">
            {agent.name || 'Unnamed Agent'}
          </span>
          {remote && <MachineBadge name={remote.machineName} />}
          {machineOffline ? (
            <span className="text-[11px] font-mono shrink-0 text-status-idle">offline</span>
          ) : (
            <AgentStatusWord agent={agent} className="text-[11px] font-mono shrink-0" title={stop ?? sleep ?? undefined} />
          )}
        </div>

        {/* Row 2: one description line - the last prompt, or why there is none.
            An agent in error shows why instead: the task is still set on an
            agent whose turn failed, and the card said what it had been asked
            and never what stopped it. A stopped agent shows who stopped it,
            when and why, in the secondary ink, and an asleep one since when,
            or who is waking it. One waiting on a permission question Tars
            holds says what it asks, in the waiting ink. One line, cut at the
            card's edge, the whole sentence in the title. */}
        {agent.pathMissing ? (
          <p className="text-[11px] text-status-error truncate">Path not found</p>
        ) : reason ? (
          <p className="text-[11px] text-status-error truncate" title={reason}>
            {reason}
          </p>
        ) : stop ? (
          <p className="text-[11px] text-text-secondary truncate" title={stop}>
            {stop}
          </p>
        ) : ask ? (
          <p className="text-[11px] text-status-waiting truncate" title={ask.title}>
            {ask.title}
          </p>
        ) : sleep ? (
          <p className="text-[11px] text-text-secondary truncate" title={sleep}>
            {sleep}
          </p>
        ) : lastPrompt ? (
          <p className="text-[11px] text-text-secondary truncate" title={lastPrompt}>
            {lastPrompt}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">No task assigned</p>
        )}

        {/* Row 3: provider, model, branch */}
        <p className="font-mono text-[10.5px] text-muted-foreground truncate" title={facts}>
          {facts}
        </p>

        <div className="flex items-center gap-2 pt-0.5" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" className={ROW_ACTION} onClick={onClick} disabled={!!remote} title={readOnly}>
            open
          </Button>
          {agent.status === 'asleep' || waking ? (
            // Woken on its own conversation; off while it comes back.
            // Frame: `Agent asleep · and how it wakes`.
            <Button size="sm" className={ROW_ACTION} onClick={onWake} disabled={!!waking || !!remote} title={readOnly}>
              wake
            </Button>
          ) : isRunning ? (
            <Button size="sm" className={ROW_ACTION} onClick={remote ? () => setAskStop(true) : onStop} disabled={!!allowed && !allowed.stop} title={allowed?.stop ? undefined : readOnly}>
              stop
            </Button>
          ) : (
            <Button size="sm" className={ROW_ACTION} onClick={remote ? () => { void drive.start(); } : onStart} disabled={agent.pathMissing || (!!allowed && !allowed.start) || (!!remote && drive.busy)} title={allowed?.start ? undefined : readOnly}>
              start
            </Button>
          )}
          <Button size="sm" className={ROW_ACTION} onClick={onEdit} disabled={!!remote} title={readOnly}>
            edit
          </Button>
          <Button size="sm" className={ROW_ACTION} onClick={onDelete} disabled={!!remote} title={readOnly}>
            delete
          </Button>
          {/* The Claude account it runs on, at the right of the buttons, when
              several subscriptions are on. Frame: `Agent · Claude account`. */}
          {!remote && <AgentAccountControl agent={agent} className="ml-auto" />}
        </div>
        {drive.error && (
          <p data-machine-drive-error className="text-[11px] text-status-error">{drive.error}</p>
        )}
        {askStop && allowed?.stop && (
          <MachineStopReason
            agentName={agent.name || 'this agent'}
            busy={drive.busy}
            onStop={async reason => { if (await drive.stop(reason)) setAskStop(false); }}
            onCancel={() => setAskStop(false)}
          />
        )}
      </div>
    </div>
  );
}
