'use client';

import { MachineStopReason } from '@/components/MachineStopReason';
import { remoteActions, seeOnlyLine, type PaneAgent } from '@/lib/machines';
import { rendererPlatform } from '@/lib/display-path';
import type { useRemoteDrive } from '@/hooks/useRemoteDrive';

/**
 * Under a remote pane's terminal: the sentence of a machine that lets this one
 * see only, or, where it lets this one drive, the stop reason it asks and the
 * sentence the machine last refused with. Keys are typed in the terminal
 * itself. Nothing for a machine that does not answer. Frame: `Panel · machine
 * you may only see`.
 */
export default function RemoteDriveBar({ agent, drive, askStop, onCloseStop }: {
  agent: PaneAgent;
  drive: ReturnType<typeof useRemoteDrive>;
  askStop: boolean;
  onCloseStop: () => void;
}) {
  const remote = agent.remote;
  if (!remote || remote.status !== 'connected') return null;
  const actions = remoteActions(remote, agent.cliRunning === true);
  const showStop = askStop && actions.stop;
  if (!actions.seeOnly && !drive.error && !showStop) return null;

  return (
    <div className="shrink-0 flex flex-col gap-2 px-[11px] py-2 bg-card border-t border-border" onClick={e => e.stopPropagation()}>
      {actions.seeOnly && (
        <p data-machine-see-only className="font-mono text-[11px] text-muted-foreground">
          {seeOnlyLine(remote.machineName, rendererPlatform())}
        </p>
      )}
      {drive.error && (
        <p data-machine-drive-error className="text-[11px] text-status-error">{drive.error}</p>
      )}
      {showStop && (
        <MachineStopReason
          agentName={agent.name || 'agent'}
          busy={drive.busy}
          onStop={async reason => { if (await drive.stop(reason)) onCloseStop(); }}
          onCancel={onCloseStop}
        />
      )}
    </div>
  );
}
