'use client';

import { useState } from 'react';
import { Button, DialogShell, Input, SegmentedControl, StatusSquare } from '@/components/ui';
import type { CloudProjectView, CloudServerView } from '@/types/electron';
import { cloudProjectInput, LOCAL_PLACE, newProjectPlaces, type CloudProjectForm, type ProjectPlace } from '@/lib/cloud';

const STARTS = [{ value: 'empty' as const, label: 'Empty' }, { value: 'git' as const, label: 'Clone from Git' }];
const CAPTION = 'text-[10px] uppercase tracking-wider text-muted-foreground';

export interface NewProjectViewProps {
  places: ProjectPlace[];
  place: string;
  form: CloudProjectForm;
  error: string | null;
  busy: boolean;
  onPlace(id: string): void;
  onForm(patch: Partial<CloudProjectForm>): void;
  onCancel(): void;
  onCreate(): void;
}

/**
 * New project, asked where it lives first (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md,
 * Task 8). Frames: `Overlay · New project · where`, `· from Git`,
 * `· name taken`, each with its light copy. This computer goes on to the
 * folder picker as + Project always did; a connected server takes a plain
 * folder name and how the project starts, and its own sentence when it
 * refuses one (a name it has: the field keeps what was typed).
 */
export function NewProjectView({ places, place, form, error, busy, onPlace, onForm, onCancel, onCreate }: NewProjectViewProps) {
  const server = places.find(p => p.id === place && p.id !== LOCAL_PLACE);
  return (
    <DialogShell
      onClose={onCancel}
      width={760}
      title="New project"
      subtitle="A folder your agents work in."
      footerLeft={<span data-new-project-note className="text-[11.5px] text-muted-foreground">{server ? `It is created on ${server.label}.` : 'You pick the folder next.'}</span>}
      footerRight={(
        <>
          <Button size="md" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="md" disabled={busy} onClick={onCreate}>Create project</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-[18px]">
        <div className="flex flex-col gap-2">
          <p className={CAPTION}>Where it lives</p>
          <div className="flex gap-2" role="radiogroup" aria-label="Where it lives">
            {places.map(p => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={p.id === place}
                data-new-project-place={p.id}
                onClick={() => onPlace(p.id)}
                className={`flex-1 h-[52px] px-2.5 flex flex-col justify-center gap-0.5 text-left border ${p.id === place ? 'bg-secondary border-border-accent' : 'border-border'}`}
              >
                <span className="flex items-center gap-1.5 text-[12.5px] text-foreground">
                  {p.id !== LOCAL_PLACE && <StatusSquare tone="running" />}
                  {p.label}
                </span>
                <span className="font-mono text-[9.5px] text-muted-foreground">{p.line}</span>
              </button>
            ))}
          </div>
        </div>
        {server && (
          <>
            <div className="flex flex-col gap-1.5">
              <p className={CAPTION}>Name</p>
              <Input mono value={form.name} onChange={e => onForm({ name: e.target.value })} placeholder="my-app" aria-label="Name" />
              {error
                ? <p data-new-project-error className="text-[10.5px] text-status-error">{error}</p>
                : <p className="text-[10.5px] text-muted-foreground">A plain folder name, like my-app: letters, numbers, dots and dashes.</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <p className={CAPTION}>Start with</p>
              <div className="flex items-center gap-2.5">
                <SegmentedControl options={STARTS} value={form.start} onChange={start => onForm({ start })} />
                {form.start === 'git' && (
                  <Input mono value={form.url} onChange={e => onForm({ url: e.target.value })} placeholder="https://github.com/you/my-app.git" aria-label="Git address" />
                )}
              </div>
              <p className="text-[10.5px] text-muted-foreground">
                {form.start === 'git'
                  ? `${server.label} clones it with its own Git access, so a private repository needs that access on the server.`
                  : `An empty folder on ${server.label}, ready for its first agent.`}
              </p>
            </div>
          </>
        )}
      </div>
    </DialogShell>
  );
}

/** The dialog with its state: a connected server first, as the frame shows it chosen. */
export default function NewProjectDialog({ servers, onClose, onPickLocal, onCreated }: {
  servers: CloudServerView[];
  onClose(): void;
  /** This computer: the folder picker, as + Project always opened. */
  onPickLocal(): void;
  onCreated(serverId: string, project: CloudProjectView): void;
}) {
  const places = newProjectPlaces(servers);
  const [place, setPlace] = useState(places[1]?.id ?? LOCAL_PLACE);
  const [form, setForm] = useState<CloudProjectForm>({ name: '', start: 'empty', url: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (place === LOCAL_PLACE) { onClose(); onPickLocal(); return; }
    const checked = cloudProjectInput(form);
    if (!checked.ok) { setError(checked.error); return; }
    setBusy(true);
    setError(null);
    try {
      const answer = await window.electronAPI?.cloud?.createProject(place, checked.body);
      if (answer?.success) { onCreated(place, answer.project); onClose(); }
      else setError(answer?.error ?? 'Tars servers are not available in this window.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <NewProjectView
      places={places}
      place={place}
      form={form}
      error={error}
      busy={busy}
      onPlace={setPlace}
      onForm={patch => { setForm(f => ({ ...f, ...patch })); setError(null); }}
      onCancel={onClose}
      onCreate={() => void create()}
    />
  );
}
