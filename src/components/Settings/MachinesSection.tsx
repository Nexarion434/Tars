'use client';

import { useEffect, useState } from 'react';
import { Button, Input, SegmentedControl, StatusSquare } from '@/components/ui';
import type { MachineView, PeerPermission } from '@/types/electron';
import { useMachines } from '@/hooks/useMachines';
import { statusLine, addressNote } from '@/lib/machines';
import { rendererPlatform } from '@/lib/display-path';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

const api = () => window.electronAPI?.machines;

/** "4:52": what is left of a code's five minutes. */
const left = (iso: string, now: Date) => {
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now.getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const STATUS: Record<MachineView['status'], { tone: 'running' | 'idle' | 'error'; ink: string; word: (m: MachineView) => string }> = {
  connected: { tone: 'running', ink: 'text-status-running', word: () => 'connected' },
  offline: { tone: 'idle', ink: 'text-muted-foreground', word: () => 'offline' },
  unknown: { tone: 'idle', ink: 'text-muted-foreground', word: () => 'checking' },
  unpaired: { tone: 'error', ink: 'text-status-error', word: m => `unpaired by ${m.name}` },
};

/** "What the PC may do here", "What Mac de Nicolas may do here": the article for a bare PC or Mac only. */
const mayHeading = (name: string) => `What ${/^(PC|Mac)$/i.test(name) ? `the ${name}` : name} may do here`;

/**
 * Settings > Machines: this machine's name and tailnet address, a one-time
 * pairing code, the paired machines, what each may do here, and unpairing.
 * Frame: `Settings · Machines` in design/tars-redesign.pen. Main holds every
 * state (electron/handlers/machines-handlers.ts); this reads its view, and
 * the header's Add a machine opens the code (src/app/settings/page.tsx).
 */
export const MachinesSection = () => {
  const { view, error } = useMachines();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [pairNote, setPairNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const here = rendererPlatform() === 'win32' ? 'this PC' : 'this Mac';

  // The field follows the saved name (a change from the other window, or this one's save).
  const savedName = view?.self.name;
  useEffect(() => { if (savedName !== undefined) setName(savedName); }, [savedName]);
  useEffect(() => {
    if (!view?.offer) return;
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tick);
  }, [view?.offer]);
  useEffect(() => {
    if (view?.offer && new Date(view.offer.expiresAt) <= now) void api()?.closeOffer();
  }, [now, view?.offer]);

  if (!view) {
    return <SettingsCard><SettingsRow label="Machines" description={error ?? 'Reading...'} /></SettingsCard>;
  }

  const saveName = async () => {
    if (name.trim() === view.self.name) return;
    const r = await api()?.setName(name);
    setNameError(r && !r.success ? r.error : null);
  };
  const pair = async () => {
    setPairNote(null);
    const r = await api()?.pair(code);
    setPairNote(r?.success ? { ok: true, text: `Paired with ${r.name}.` } : { ok: false, text: r && !r.success ? r.error : 'Pairing failed.' });
    if (r?.success) setCode('');
  };

  return (
    <SettingsCard>
      <SettingsRow
        label="This machine"
        description={nameError ?? 'The name your other machines see.'}
        control={(
          <Input width="control" aria-label="This machine" value={name} error={!!nameError}
            onChange={e => setName(e.target.value)} onBlur={saveName} />
        )}
      />
      <SettingsRow
        label="Address on your tailnet"
        wrap
        description="Your machines reach it over Tailscale only, never from the internet. Your system may ask once whether Tars can accept connections: allow it on private networks."
        control={addressNote(view) === null
          ? <Input width="control" mono readOnly aria-label="Address on your tailnet" value={view.self.address ?? ''} />
          : <span className="text-[11.5px] text-muted-foreground">{addressNote(view)}</span>}
      />
      {view.offer && (
        <div data-settings-row className="px-4 py-[11px] shrink-0">
          <div className="flex items-center gap-2 px-2.5 py-2 bg-secondary border border-border">
            <StatusSquare tone="waiting" />
            <span className="text-[11.5px] leading-snug text-foreground">
              {`Pairing code ${view.offer.code}. Type it on the other machine, in Settings > Machines. It works once and expires in ${left(view.offer.expiresAt, now)}.`}
            </span>
          </div>
        </div>
      )}
      <SettingsRow
        label="Pair with a code"
        description={pairNote ? pairNote.text : 'The code the other machine shows under Add a machine.'}
        control={(
          <div className="flex items-center gap-2">
            <Input mono aria-label="Pair with a code" value={code} placeholder="000 000"
              onChange={e => setCode(e.target.value)} />
            <Button size="sm" variant="primary" onClick={pair} disabled={code.replace(/\D/g, '').length !== 6}>Pair</Button>
          </div>
        )}
      />
      {view.peers.map(m => (
        <div key={m.id}>
          <SettingsRow
            label={m.name}
            description={statusLine(m, now)}
            control={(
              <div className="flex items-center gap-2 justify-end">
                <StatusSquare tone={STATUS[m.status].tone} />
                <span className={`text-[11.5px] ${STATUS[m.status].ink}`}>{STATUS[m.status].word(m)}</span>
                {m.status === 'unpaired' && (
                  <Button size="sm" variant="secondary" onClick={() => { void api()?.unpair(m.id); }}>forget</Button>
                )}
              </div>
            )}
          />
          <SettingsRow
            label={mayHeading(m.name)}
            description="See shows your agents and their terminals. Drive also starts, stops and messages them."
            control={(
              <SegmentedControl<PeerPermission>
                ariaLabel={mayHeading(m.name)}
                value={m.mayOnMe}
                options={[{ value: 'see', label: 'See' }, { value: 'drive', label: 'Drive' }]}
                onChange={v => { void api()?.setPermission(m.id, v); }}
              />
            )}
          />
        </div>
      ))}
      {view.peers.length > 0 && (
        <SettingsRow
          label="Unpair a machine"
          description={`Its secret is forgotten here at once. It can no longer see or drive anything on ${here}.`}
          control={(
            <div className="flex items-center gap-2 justify-end">
              {view.peers.map(m => (
                <Button key={m.id} size="sm" variant="secondary" onClick={() => { void api()?.unpair(m.id); }}>{`unpair ${m.name}`}</Button>
              ))}
            </div>
          )}
        />
      )}
    </SettingsCard>
  );
};
