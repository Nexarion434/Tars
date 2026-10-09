'use client';

import { useState } from 'react';
import { Button, Input } from '@/components/ui';
import { MachineStopReason } from '@/components/MachineStopReason';
import { checkMessage, MESSAGE_MAX, remoteActions, seeOnlyLine, type PaneAgent } from '@/lib/machines';
import { rendererPlatform } from '@/lib/display-path';
import type { useRemoteDrive } from '@/hooks/useRemoteDrive';

/**
 * Under a remote pane's terminal: where a machine that lets this one drive is
 * messaged and stopped, or the sentence of one that lets it see only. Nothing
 * for a machine that does not answer. Frames: `Panel · machine you may drive`,
 * `Panel · machine you may only see`.
 */
export default function RemoteDriveBar({ agent, drive, askStop, onCloseStop }: {
  agent: PaneAgent;
  drive: ReturnType<typeof useRemoteDrive>;
  askStop: boolean;
  onCloseStop: () => void;
}) {
  const [text, setText] = useState('');
  const remote = agent.remote;
  if (!remote) return null;
  const actions = remoteActions(remote, agent.cliRunning === true);
  if (!actions.message && !actions.seeOnly) return null;

  const name = agent.name || 'agent';
  const send = async () => {
    if (!checkMessage(text) || drive.busy) return;
    if (await drive.message(text)) setText('');
  };

  return (
    <div className="shrink-0 flex flex-col gap-2 px-[11px] py-2 bg-card border-t border-border" onClick={e => e.stopPropagation()}>
      {actions.seeOnly ? (
        <p data-machine-see-only className="font-mono text-[11px] text-muted-foreground">
          {seeOnlyLine(remote.machineName, rendererPlatform())}
        </p>
      ) : (
        <>
          {drive.error && (
            <p data-machine-drive-error className="text-[11px] text-status-error">{drive.error}</p>
          )}
          {askStop && actions.stop && (
            <MachineStopReason
              agentName={name}
              busy={drive.busy}
              onStop={async reason => { if (await drive.stop(reason)) onCloseStop(); }}
              onCancel={onCloseStop}
            />
          )}
          <div className="flex items-center gap-2">
            <Input
              data-machine-message
              value={text}
              maxLength={MESSAGE_MAX}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void send(); }}
              placeholder={`Message ${name} on ${remote.machineName}`}
              aria-label={`Message ${name} on ${remote.machineName}`}
              mono
              className="flex-1 min-w-0 text-[11.5px]"
            />
            <Button variant="primary" data-machine-send disabled={!checkMessage(text) || drive.busy} onClick={() => void send()}>
              Send
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
