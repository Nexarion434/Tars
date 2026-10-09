'use client';

import { useState } from 'react';
import { Button, Input } from '@/components/ui';
import { checkReason } from '@/lib/machines';

/**
 * What stopping another machine's agent asks first: why. The reason is kept by
 * that machine beside who stopped it, and is never sent blank.
 */
export function MachineStopReason({ agentName, busy, onStop, onCancel }: {
  agentName: string;
  busy: boolean;
  onStop: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const ready = checkReason(reason) !== null && !busy;
  const submit = () => { if (ready) onStop(reason); };

  return (
    <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
      <Input
        autoFocus
        data-machine-stop-reason
        value={reason}
        maxLength={200}
        onChange={e => setReason(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onCancel();
        }}
        placeholder={`Why stop ${agentName}?`}
        aria-label={`Why stop ${agentName}`}
        mono
        className="flex-1 min-w-0 text-[11.5px]"
      />
      <Button variant="primary" disabled={!ready} onClick={submit}>Stop</Button>
      <Button onClick={onCancel}>Cancel</Button>
    </div>
  );
}
