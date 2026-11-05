'use client';

import { remoteActions, seeOnlyLine, type PaneAgent } from '@/lib/cloud';
import type { useRemoteDrive } from '@/hooks/useRemoteDrive';

/**
 * Under a server agent's pane: the sentence of a server that lets this
 * desktop see only, or, where it lets it drive, the sentence the server last
 * refused with. Keys are typed in the terminal itself, and a stop is one
 * click on the pane's Stop. Nothing for a server that does not answer.
 * Ported from win/machines. Frame: `Panel · machine you may only see`.
 */
export default function RemoteDriveBar({ agent, drive }: {
  agent: PaneAgent;
  drive: ReturnType<typeof useRemoteDrive>;
}) {
  const remote = agent.remote;
  if (!remote || remote.status !== 'connected') return null;
  const actions = remoteActions(remote, agent.cliRunning === true);
  if (!actions.seeOnly && !drive.error) return null;

  return (
    <div className="shrink-0 flex flex-col gap-2 px-[11px] py-2 bg-card border-t border-border" onClick={e => e.stopPropagation()}>
      {actions.seeOnly && (
        <p data-cloud-see-only className="font-mono text-[11px] text-muted-foreground">
          {seeOnlyLine(remote.machineName)}
        </p>
      )}
      {drive.error && (
        <p data-cloud-drive-error className="text-[11px] text-status-error">{drive.error}</p>
      )}
    </div>
  );
}
