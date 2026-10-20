'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Input, PanelCaption, StatusSquare } from '@/components/ui';
import type { HermesGatewayView } from '@/types/electron';
import { tildePath } from '@/lib/display-path';
import {
  allowedProjects, chipsOf, gatewayAddresses, gatewayCaption, notSavedLine, projectPicks, projectsLine,
  type GatewayConnection, type KnownProject,
} from '@/lib/hermes-gateways';
import { SettingsRow } from './SettingsRow';

/** Row actions are words, not glyphs: 26px bordered lowercase mono. */
const ROW_ACTION = 'font-mono lowercase';
const ASK = 'mx-4 my-2 flex items-center gap-3 px-3 py-2 bg-secondary border border-border';
const ERROR = 'px-4 pb-2 text-[11.5px] text-danger';

/**
 * Settings > Hermes > Gateways (2.0.4, the window of #469; frames `Gateways · Settings, Hermes` and `· states`):
 * every Hermes that hands Tars work, each with its own route and secret, and the projects it may reach, none until
 * the user allows some. A secret never reaches the page: main shows a new one once in a dialog of its own (add,
 * replace) and copies it on request (copy secret). Add is the header's action, so the page passes `adding` down.
 */
export function HermesGatewaysSection({ adding, onAddingChange }: { adding: boolean; onAddingChange: (adding: boolean) => void }) {
  const [gateways, setGateways] = useState<HermesGatewayView[] | null>(null);
  const [info, setInfo] = useState<GatewayConnection | null>(null);
  const [known, setKnown] = useState<KnownProject[]>([]);

  const read = useCallback(async () => {
    const answer = await window.electronAPI?.hermes?.gateways?.list().catch(() => null);
    setGateways(answer?.gateways ?? []);
  }, []);

  useEffect(() => {
    void read();
    window.electronAPI?.hermes?.getConnectionInfo().then(setInfo).catch(() => setInfo(null));
    window.electronAPI?.fs?.listProjects()
      .then((list) => setKnown(list.filter((p) => !p.path.includes('/.worktrees/')).map((p) => ({ path: p.path, name: p.name }))))
      .catch(() => setKnown([]));
  }, [read]);

  return (
    <>
      {adding && (
        <NewGateway
          onAdded={() => { onAddingChange(false); void read(); }}
          onCancel={() => onAddingChange(false)}
        />
      )}
      {gateways === null
        ? <SettingsRow label="Gateways" description="Reading the gateways…" />
        : gateways.map((gateway) => (
          <GatewayBlock key={gateway.id} gateway={gateway} info={info} known={known} onChanged={read} />
        ))}
    </>
  );
}

/** A name only: main mints the route and the secret, and shows the secret once in its own dialog. */
function NewGateway({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const label = name.trim();
    if (!label || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await window.electronAPI?.hermes?.gateways?.add({ label });
      if (answer?.success) onAdded();
      else setError(notSavedLine(answer?.error));
    } catch (err) {
      setError(notSavedLine(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="New gateway">
      <form onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <SettingsRow
          label="Name"
          description="What you call this Hermes, in Tars only."
          wide
          control={
            <div className="flex w-full items-center gap-2">
              <Input
                aria-label="Gateway name"
                autoFocus
                className="min-w-0 flex-1"
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
              />
              <Button type="submit" size="sm" variant="primary" disabled={busy || !name.trim()}>add</Button>
              <Button type="button" size="sm" className={ROW_ACTION} onClick={onCancel}>cancel</Button>
            </div>
          }
        />
      </form>
      {error && <p className={ERROR}>{error}</p>}
    </section>
  );
}

/** A copy of an address, which is no secret: the page puts it on the clipboard itself. */
function AddressRow({ label, description, address, empty }: { label: string; description: string; address: string | null; empty: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <SettingsRow
      label={label}
      description={description}
      wide
      control={
        <div className="flex w-full items-center gap-2">
          <Input
            mono
            readOnly
            className={`min-w-0 flex-1 ${address ? '' : 'text-muted-foreground'}`}
            value={address ?? ''}
            placeholder={empty}
            onFocus={(e) => e.currentTarget.select()}
          />
          {address && (
            <Button
              size="sm"
              className={ROW_ACTION}
              onClick={() => {
                void navigator.clipboard?.writeText(address).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? 'copied' : 'copy'}
            </Button>
          )}
        </div>
      }
    />
  );
}

function GatewayBlock({ gateway, info, known, onChanged }: {
  gateway: HermesGatewayView;
  info: GatewayConnection | null;
  known: KnownProject[];
  onChanged: () => Promise<void>;
}) {
  const [asking, setAsking] = useState<'replace' | 'remove' | null>(null);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const caption = gatewayCaption(gateway);
  const addresses = gatewayAddresses(info, gateway.path);
  const reached = allowedProjects(gateway.projects, known);
  const chips = chipsOf(reached.map((p) => p.name));
  const line = projectsLine(reached.length);
  const picks = projectPicks(gateway.projects, known);
  const isDefault = gateway.id === 'default';

  /** One call to main at a time, its refusal said under the block. */
  const act = async (call: () => Promise<{ success: boolean; error?: string } | undefined>, refused: (error?: string) => string) => {
    setBusy(true);
    setError(null);
    try {
      const answer = await call();
      if (!answer?.success) { setError(refused(answer?.error)); return false; }
      return true;
    } catch (err) {
      setError(refused(err instanceof Error ? err.message : String(err)));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const copySecret = async () => {
    let copiedNow = false;
    const ok = await act(async () => {
      const answer = await window.electronAPI?.hermes?.gateways?.copySecret({ id: gateway.id });
      copiedNow = !!answer?.success && answer.copied;
      return answer;
    }, (e) => (e ? `Not copied: ${e}` : 'Not copied.'));
    if (!ok || !copiedNow) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const replace = async () => {
    const ok = await act(async () => window.electronAPI?.hermes?.gateways?.rotate({ id: gateway.id }), (e) => (e ? `Not replaced: ${e}` : 'Not replaced.'));
    if (ok) setAsking(null);
  };

  const remove = async () => {
    const ok = await act(async () => window.electronAPI?.hermes?.gateways?.remove({ id: gateway.id }), () => 'Not removed: Tars no longer has this gateway.');
    setAsking(null);
    if (ok) await onChanged();
  };

  const saveProjects = async () => {
    if (!picked) return;
    const projects = picks.filter((p) => picked.has(p.path)).map((p) => p.path);
    await act(async () => window.electronAPI?.hermes?.gateways?.setProjects({ id: gateway.id, projects }), notSavedLine);
    setPicked(null);
    await onChanged();
  };

  const toggle = (path: string) => setPicked((now) => {
    const next = new Set(now ?? []);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  return (
    <section aria-label={gateway.label}>
      <div className="flex items-center justify-between gap-2.5 px-4 pt-[18px] pb-1">
        <div className="flex min-w-0 items-center gap-2.5">
          <PanelCaption className="shrink-0">{caption.title}</PanelCaption>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{caption.sub}</span>
        </div>
        {!isDefault && (
          <Button size="sm" variant="danger" className={ROW_ACTION} onClick={() => setAsking('remove')} disabled={busy}>remove</Button>
        )}
      </div>
      {asking === 'remove' && (
        <div role="alertdialog" aria-label={`Remove ${gateway.label}`} className={ASK}>
          <StatusSquare tone="error" />
          <p className="flex-1 text-[12px] text-foreground">{`Remove ${gateway.label}? Its address stops answering now, and its secret is deleted.`}</p>
          <Button size="sm" className={ROW_ACTION} onClick={() => setAsking(null)}>cancel</Button>
          <Button size="sm" variant="danger" className={ROW_ACTION} disabled={busy} onClick={() => void remove()}>remove</Button>
        </div>
      )}

      <div className="divide-y divide-border">
        <AddressRow label="Address" description={addresses.line} address={addresses.tailnet} empty={info ? 'no tailnet address' : 'reading…'} />
        <AddressRow label="On this machine" description="A Hermes on this machine posts here." address={addresses.local} empty="reading…" />

        <SettingsRow
          label="Secret"
          description="Its Hermes sends it as a bearer token. Tars never shows it here."
          wide
          control={
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-[11.5px] text-success"><StatusSquare tone="running" />a secret is set</span>
              <Button size="sm" className={ROW_ACTION} disabled={busy} onClick={() => void copySecret()}>{copied ? 'copied' : 'copy secret'}</Button>
              <Button size="sm" className={ROW_ACTION} disabled={busy} onClick={() => setAsking('replace')}>replace</Button>
            </div>
          }
        />
        {asking === 'replace' && (
          <div role="alertdialog" aria-label={`Replace the secret of ${gateway.label}`} className={ASK}>
            <StatusSquare tone="waiting" />
            <p className="flex-1 text-[12px] text-foreground">Replace this gateway&apos;s secret? The one its Hermes holds stops working now, and Tars shows the new one once.</p>
            <Button size="sm" className={ROW_ACTION} onClick={() => setAsking(null)}>cancel</Button>
            <Button size="sm" className={ROW_ACTION} disabled={busy} onClick={() => void replace()}>replace</Button>
          </div>
        )}

        {picked ? (
          <div>
            <SettingsRow label="Projects" description="Tick the projects this gateway may reach." />
            {picks.length === 0 && <p className="px-4 py-2 text-[11.5px] text-muted-foreground">Tars lists no project yet: add one on the Projects page.</p>}
            {picks.map((p) => {
              const on = picked.has(p.path);
              return (
                <button
                  key={p.path}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  aria-label={p.name}
                  onClick={() => toggle(p.path)}
                  className="flex w-[calc(100%-32px)] mx-4 items-center gap-2.5 py-[7px] border-b border-border text-left"
                >
                  <span className={`w-3 h-3 shrink-0 border ${on ? 'bg-primary border-primary' : 'bg-card border-border-accent'}`} />
                  <span className="text-[12.5px] text-foreground">{p.name}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{tildePath(p.path)}</span>
                </button>
              );
            })}
            <div className="flex items-center gap-2 px-4 pt-2.5 pb-2.5">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveProjects()}>save</Button>
              <Button size="sm" className={ROW_ACTION} onClick={() => setPicked(null)}>cancel</Button>
            </div>
          </div>
        ) : (
          <SettingsRow
            label="Projects"
            description={line.waiting ? <span className="text-status-waiting">{line.hint}</span> : line.hint}
            wide
            control={
              <div className="flex min-w-0 items-center gap-2">
                {reached.length === 0 ? (
                  <span className="flex items-center gap-1.5 text-[11.5px] text-status-waiting"><StatusSquare tone="waiting" />none</span>
                ) : (
                  <>
                    {chips.shown.map((name) => (
                      <span key={name} className="inline-flex h-[22px] shrink-0 items-center border border-border bg-secondary px-2 font-mono text-[11px] text-muted-foreground">{name}</span>
                    ))}
                    {chips.more > 0 && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{`+${chips.more}`}</span>}
                  </>
                )}
                <Button
                  size="sm"
                  className={`${ROW_ACTION} shrink-0`}
                  disabled={busy}
                  onClick={() => { setError(null); setPicked(new Set(picks.filter((p) => p.ticked).map((p) => p.path))); }}
                >
                  {reached.length === 0 ? 'allow projects' : 'change'}
                </Button>
              </div>
            }
          />
        )}
      </div>
      {error && <p className={`${ERROR} pt-2`}>{error}</p>}
    </section>
  );
}
