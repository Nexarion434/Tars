'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Monitor } from 'lucide-react';
import { Button, Input, SegmentedControl, StatusSquare } from '@/components/ui';
import type { CloudClientView, CloudServerView } from '@/types/electron';
import { serverInput, serverLine, statusWord, type ServerForm } from '@/lib/cloud';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import { Toggle } from './Toggle';

const api = () => window.electronAPI?.cloud;
const EMPTY: ServerForm = { host: '', runs: 'docker', container: 'tars-server', sudo: true, doorSocket: '', command: '' };
const RUNS = [{ value: 'docker' as const, label: 'Docker' }, { value: 'command' as const, label: 'Installed' }];
const INK = { running: 'text-status-running', idle: 'text-muted-foreground', error: 'text-status-error' } as const;

/** A device's kind beside its name, as the frame tags it. */
const Tag = ({ children }: { children: string }) => (
  <span className="border border-border px-1.5 text-[10.5px] leading-[16px] text-muted-foreground">{children}</span>
);

/**
 * Settings > Cloud: the Tars servers this computer reaches over SSH, with
 * the user's own key (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 11).
 * Frames: `Settings · Cloud · simple`, `· advanced open` and `· connected` in
 * design/tars-redesign.pen. A server is added by its address alone; how it runs,
 * its container, admin rights and its door wait under Advanced, closed, and open
 * by themselves when one of them is missing. The first connect mints this
 * computer's credential there. Each server says its link in words (main's
 * sentences, never retyped here), offers Disconnect (the SSH link here only) and
 * Forget (also removes this computer there), and lists the devices with access,
 * read as soon as it is connected, each with Remove. Main holds every state
 * (electron/handlers/cloud-handlers.ts); nothing here sees a credential.
 */
export const CloudSection = () => {
  const [servers, setServers] = useState<CloudServerView[] | null>(null);
  const [form, setForm] = useState<ServerForm>(EMPTY);
  const [advanced, setAdvanced] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [clients, setClients] = useState<Record<string, CloudClientView[] | string>>({});
  const asked = useRef(new Set<string>());

  const read = useCallback(() => { api()?.list().then(setServers).catch(() => setServers([])); }, []);
  useEffect(() => {
    read();
    return api()?.onState(read);
  }, [read]);

  const readClients = useCallback(async (id: string) => {
    const answer = await api()?.clients(id).catch(() => null);
    if (answer) setClients(all => ({ ...all, [id]: answer.success ? answer.clients : answer.error }));
  }, []);
  // A connected server's devices are read once, when it is first seen connected.
  useEffect(() => {
    for (const server of servers ?? []) {
      if (server.state.phase !== 'connected' || asked.current.has(server.id)) continue;
      asked.current.add(server.id);
      void readClients(server.id);
    }
  }, [servers, readClients]);

  if (!api()) {
    return <SettingsCard><SettingsRow label="Tars servers" description="Tars servers are reached from the desktop app." /></SettingsCard>;
  }

  const act = async (key: string, call: () => Promise<{ success: boolean; error?: string } | undefined>) => {
    setBusy(key);
    setNote(null);
    try {
      const answer = await call();
      if (answer && !answer.success) setNote(answer.error ?? 'It did not work.');
    } finally {
      setBusy(null);
      read();
    }
  };
  const add = () => act('add', async () => {
    const checked = serverInput(form);
    if (!checked.ok) {
      // With an address given, what is missing is under Advanced: show it.
      if (form.host.trim()) setAdvanced(true);
      return { success: false, error: checked.error };
    }
    const saved = await api()!.save(checked.input);
    if (!saved.success) return saved;
    setForm(EMPTY);
    return api()!.connect(saved.id);
  });
  const revoke = (id: string, clientId: string) => act(`revoke:${clientId}`, async () => {
    const answer = await api()!.revoke(id, clientId);
    if (answer.success) await readClients(id);
    return answer;
  });
  const set = (patch: Partial<ServerForm>) => setForm(f => ({ ...f, ...patch }));
  const listedServers = servers ?? [];
  const Chevron = advanced ? ChevronDown : ChevronRight;

  return (
    <SettingsCard>
      {listedServers.map(server => {
        const status = statusWord(server.state.phase);
        const name = server.name ?? server.host;
        const listed = clients[server.id];
        const connected = server.state.phase === 'connected';
        return (
          <div key={server.id} data-cloud-server={server.id} className="px-4 pt-3.5 pb-4">
            <div className="border border-border bg-secondary divide-y divide-border">
              <SettingsRow
                label={<span className="text-[15px]">{name}</span>}
                description={<span data-cloud-server-line>{serverLine(server)}</span>}
                control={(
                  <span className={`inline-flex items-center gap-2 text-[11.5px] ${INK[status.tone]}`}>
                    <StatusSquare tone={status.tone} />
                    {status.word}
                  </span>
                )}
              />
              <SettingsRow
                wrap
                label="From this computer"
                description="Disconnect ends the link from this computer only: the server and its agents keep going. Forget also removes this computer's access on the server."
                control={(
                  <span className="inline-flex gap-1.5">
                    {connected
                      ? <Button size="sm" disabled={!!busy} onClick={() => void act(`disconnect:${server.id}`, () => api()!.disconnect(server.id))}>Disconnect</Button>
                      : <Button size="sm" disabled={!!busy} onClick={() => void act(`connect:${server.id}`, () => api()!.connect(server.id))}>Connect</Button>}
                    <Button size="sm" variant="danger" disabled={!!busy} onClick={() => void act(`forget:${server.id}`, () => api()!.forget(server.id))}>Forget this server</Button>
                  </span>
                )}
              />
              <SettingsRow
                wrap
                label="Devices with access"
                description={typeof listed === 'string' ? listed : 'Every computer and outside agent that can reach this server. Remove one and it loses access right away.'}
                control={Array.isArray(listed) ? undefined : (
                  <Button size="sm" disabled={!!busy} onClick={() => void readClients(server.id)}>{listed ? 'Read again' : 'Show devices'}</Button>
                )}
              />
              {Array.isArray(listed) && listed.map(client => {
                const shown = client.name ?? client.id;
                const Icon = client.kind === 'outside-agent' ? Bot : Monitor;
                return (
                  <SettingsRow
                    key={client.id}
                    label={(
                      <span className="inline-flex items-center gap-2" title={client.id}>
                        <Icon size={13} className="shrink-0 text-muted-foreground" aria-hidden />
                        {shown}
                        {client.id === server.clientId && <Tag>this computer</Tag>}
                        {client.kind === 'outside-agent' && <Tag>outside agent</Tag>}
                      </span>
                    )}
                    control={<Button size="sm" disabled={!!busy} aria-label={`Remove ${shown}`} onClick={() => void revoke(server.id, client.id)}>Remove</Button>}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      <SettingsRow
        wide
        label={listedServers.length ? 'Add another server' : 'Server address'}
        description={listedServers.length
          ? 'Like user@server, or a shortcut from your SSH settings.'
          : 'Like user@server, or a shortcut from your SSH settings. Tars signs in with your own key, never a password.'}
        control={(
          <span className="flex w-full items-center gap-1.5">
            <Input mono value={form.host} onChange={e => set({ host: e.target.value })} placeholder="user@server" aria-label="Server address" />
            <Button variant="primary" className="shrink-0" disabled={busy === 'add'} onClick={() => void add()}>Connect</Button>
          </span>
        )}
      />
      {note && <p data-cloud-note className="px-4 py-2 text-[11.5px] text-status-error">{note}</p>}
      <SettingsRow
        label={<button type="button" aria-expanded={advanced} onClick={() => setAdvanced(open => !open)}>Advanced</button>}
        description="How the server runs, its container and its door."
        control={(
          <Button variant="ghost" size="icon" tabIndex={-1} aria-hidden onClick={() => setAdvanced(open => !open)}>
            <Chevron size={14} />
          </Button>
        )}
      />
      {advanced && (
        <>
          <div className="px-4 py-3.5">
            <p data-cloud-advanced-note className="flex items-center gap-2.5 border border-border bg-secondary px-4 py-2.5 text-[12px] text-muted-foreground">
              <span className="h-1.5 w-1.5 shrink-0 bg-muted-foreground" aria-hidden />
              Filled in for you on the usual Docker setup, except the door path. Change the rest only if your server runs Tars another way.
            </p>
          </div>
          <SettingsRow
            wrap
            label="How it runs"
            description="Docker: Tars runs in a container on your server, and starts it when it is stopped. Installed: Tars runs on the server itself, started by a command you give."
            control={<SegmentedControl options={RUNS} value={form.runs} onChange={runs => set({ runs })} size="sm" />}
          />
          {form.runs === 'docker' ? (
            <>
              <SettingsRow
                wide
                label="Container name"
                description="The container Tars lives in on your server."
                control={<Input mono value={form.container} onChange={e => set({ container: e.target.value })} aria-label="Container name" />}
              />
              <SettingsRow
                label="Admin rights"
                description="Most Docker servers need them to reach the container. Tars never asks you for a password."
                control={<Toggle enabled={form.sudo} onChange={() => set({ sudo: !form.sudo })} label="Admin rights" />}
              />
              <SettingsRow
                wide
                label="Door path"
                description="Where Tars listens on the server, so this computer can reach it. On Docker, the path on the server, not inside the container."
                control={<Input mono value={form.doorSocket} onChange={e => set({ doorSocket: e.target.value })} placeholder="/home/<user>/.tars-private/door.sock" aria-label="Door path" />}
              />
            </>
          ) : (
            <SettingsRow
              wide
              label="Command"
              description="What starts Tars on your server, word for word."
              control={<Input mono value={form.command} onChange={e => set({ command: e.target.value })} placeholder="node /srv/tars/electron/dist/server/cli.js" aria-label="Command" />}
            />
          )}
        </>
      )}
    </SettingsCard>
  );
};
