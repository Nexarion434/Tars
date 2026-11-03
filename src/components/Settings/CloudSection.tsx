'use client';

import { useCallback, useEffect, useState } from 'react';
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

/**
 * Settings > Cloud: the Tars servers this computer reaches over SSH, with
 * the user's own key (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md, Task 11).
 * Frame: `Settings · Cloud` in design/tars-redesign.pen, drawn from
 * `Settings · Machines`. A server is added by its host and how it runs, then
 * connected: the first connect mints this computer's credential there. Each
 * server says its link in words (main's sentences, never retyped here), and
 * offers Disconnect (the SSH link here only), Forget (also revokes this
 * computer there), and its clients, each with Revoke. Main holds every state
 * (electron/handlers/cloud-handlers.ts); nothing here sees a credential.
 */
export const CloudSection = () => {
  const [servers, setServers] = useState<CloudServerView[] | null>(null);
  const [form, setForm] = useState<ServerForm>(EMPTY);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [clients, setClients] = useState<Record<string, CloudClientView[] | string>>({});

  const read = useCallback(() => { api()?.list().then(setServers).catch(() => setServers([])); }, []);
  useEffect(() => {
    read();
    return api()?.onState(read);
  }, [read]);

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
    if (!checked.ok) return { success: false, error: checked.error };
    const saved = await api()!.save(checked.input);
    if (!saved.success) return saved;
    setForm(EMPTY);
    return api()!.connect(saved.id);
  });
  const showClients = (id: string) => act(`clients:${id}`, async () => {
    const answer = await api()!.clients(id);
    setClients(all => ({ ...all, [id]: answer.success ? answer.clients : answer.error }));
    return { success: true };
  });
  const revoke = (id: string, clientId: string) => act(`revoke:${clientId}`, async () => {
    const answer = await api()!.revoke(id, clientId);
    if (answer.success) await showClients(id);
    return answer;
  });
  const set = (patch: Partial<ServerForm>) => setForm(f => ({ ...f, ...patch }));

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard>
        <SettingsRow
          label="SSH host"
          description="user@host, or an alias from your SSH config. Your own key, never a password."
          control={<Input mono value={form.host} onChange={e => set({ host: e.target.value })} placeholder="ubuntu@100.101.245.29" aria-label="SSH host" />}
        />
        <SettingsRow
          label="How the server runs"
          description={form.runs === 'docker'
            ? 'Docker: Tars runs sudo -n docker exec in its container, and starts the container when it is down.'
            : "Installed: the command that runs the server's CLI on the host."}
          control={<SegmentedControl options={RUNS} value={form.runs} onChange={runs => set({ runs })} size="sm" />}
        />
        {form.runs === 'docker' ? (
          <>
            <SettingsRow
              label="Container"
              description="Started with sudo -n, which never asks for a password."
              control={<Input mono value={form.container} onChange={e => set({ container: e.target.value })} aria-label="Container" />}
              secondaryControl={<Toggle enabled={form.sudo} onChange={() => set({ sudo: !form.sudo })} label="sudo" />}
            />
            <SettingsRow
              label="Door socket on the host"
              description="For Docker: the door as the host sees it, in the home the container mounts."
              control={<Input mono value={form.doorSocket} onChange={e => set({ doorSocket: e.target.value })} placeholder="/home/ubuntu/tars-cloud/home/.tars-private/door.sock" aria-label="Door socket on the host" />}
            />
          </>
        ) : (
          <SettingsRow
            label="Command"
            control={<Input mono value={form.command} onChange={e => set({ command: e.target.value })} placeholder="node /srv/tars/electron/dist/server/cli.js" aria-label="Command" />}
          />
        )}
        <SettingsRow
          label="Add and connect"
          description="The first connect mints this computer's credential on the server, named after this computer."
          control={<Button variant="primary" disabled={busy === 'add'} onClick={() => void add()}>Connect</Button>}
        />
        {note && <p data-cloud-note className="px-4 py-2 text-[11.5px] text-status-error">{note}</p>}
      </SettingsCard>

      {(servers ?? []).map(server => {
        const status = statusWord(server.state.phase);
        const name = server.name ?? server.host;
        const listed = clients[server.id];
        const connected = server.state.phase === 'connected';
        return (
          <SettingsCard key={server.id}>
            <SettingsRow
              label={name}
              description={<span data-cloud-server-line>{serverLine(server)}</span>}
              control={(
                <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] ${INK[status.tone]}`}>
                  <StatusSquare tone={status.tone} />
                  {status.word}
                </span>
              )}
            />
            <SettingsRow
              label="This computer's link"
              description="Disconnect ends the SSH link here only: the server and its agents go on. Forget also revokes this computer there."
              control={(
                <span className="inline-flex gap-2">
                  {connected
                    ? <Button size="sm" disabled={!!busy} onClick={() => void act(`disconnect:${server.id}`, () => api()!.disconnect(server.id))}>Disconnect</Button>
                    : <Button size="sm" disabled={!!busy} onClick={() => void act(`connect:${server.id}`, () => api()!.connect(server.id))}>Connect</Button>}
                  <Button size="sm" variant="danger" disabled={!!busy} onClick={() => void act(`forget:${server.id}`, () => api()!.forget(server.id))}>Forget {name}</Button>
                </span>
              )}
            />
            <SettingsRow
              label={`Clients of ${name}`}
              description={typeof listed === 'string' ? listed : 'Every computer and outside agent that holds a credential there. A client revoked sees and drives nothing there any more.'}
              control={<Button size="sm" disabled={!!busy} onClick={() => void showClients(server.id)}>{listed ? 'Read again' : 'Show clients'}</Button>}
            />
            {Array.isArray(listed) && listed.map(client => (
              <SettingsRow
                key={client.id}
                label={<span className="font-mono">{client.name ?? client.id}</span>}
                description={[client.kind, client.scopes.join(', '), client.id, client.id === server.clientId ? 'this computer' : null].filter(Boolean).join(' · ')}
                control={<Button size="sm" disabled={!!busy} onClick={() => void revoke(server.id, client.id)}>Revoke {client.name ?? client.id}</Button>}
              />
            ))}
          </SettingsCard>
        );
      })}
    </div>
  );
};
