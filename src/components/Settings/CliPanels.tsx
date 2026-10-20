'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Dropdown, MetaChip, PanelCaption, PasswordInput, StatusSquare } from '@/components/ui';
import type { CliKeyState } from '@/types/electron';
import { CLIS, type CliDef } from '@/lib/clis';
import { tildePath } from '@/lib/display-path';
import { SettingsRow } from './SettingsRow';
import type { CLIPaths } from './types';

/** Each CLI as the one detection found it (useCliDetection): its path, the version that binary gave, or still checking. */
export type CliVersions = Record<string, { path: string | null; version: string | null; loading: boolean }>;

/**
 * Settings > Providers, one panel per CLI (frame: `Providers · one panel per
 * CLI · Codex`): the CLIs in one list (src/lib/clis.ts), and the one picked,
 * with its API key (the cliKeys of PR 459: set or cleared, never shown back), its
 * command and version. Claude Code's own options keep their rows. A CLI is ready
 * where the detection CLI Paths shows found it, and its version is that binary's
 * number alone (frame `Secrets · CLIs, one detection`).
 */
export default function CliPanels({ versions, configuredPaths, claudeRows }: { versions: CliVersions; configuredPaths?: CLIPaths; claudeRows: ReactNode }) {
  const [selected, setSelected] = useState('claude');
  const [keys, setKeys] = useState<CliKeyState[] | null>(null);
  const readKeys = useCallback(async () => {
    const list = await window.electronAPI?.cliKeys?.list().catch(() => null);
    setKeys(list ?? []);
  }, []);
  useEffect(() => { void readKeys(); }, [readKeys]);

  const driven = CLIS.filter((c) => !c.soon);
  const cli = driven.find((c) => c.id === selected) ?? driven[0];
  const v = versions[cli.id];
  const keyState = cli.keyId ? keys?.find((k) => k.id === cli.keyId) ?? null : null;

  return (
    <div data-cli-panels className="flex min-h-[420px] border-b border-border">
      <div className="w-[230px] shrink-0 border-r border-border px-3 py-3">
        <PanelCaption>{`COMMAND-LINE AGENTS · ${driven.length}`}</PanelCaption>
        <ul aria-label="Command-line agents" className="mt-1 flex flex-col gap-0.5">
          {driven.map((c) => {
            const state = versions[c.id];
            const on = c.id === cli.id;
            const word = state?.loading ? 'checking' : state?.path ? 'ready' : 'not installed';
            return (
              <li key={c.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSelected(c.id)}
                  className={`w-full text-left px-2.5 py-1.5 border transition-colors ${on ? 'bg-secondary border-border-accent' : 'border-transparent hover:bg-secondary'}`}
                >
                  <span className="flex items-center gap-2">
                    <StatusSquare tone={state?.path ? 'running' : 'idle'} />
                    <span className={`text-[12.5px] ${state?.path ? 'text-foreground' : 'text-muted-foreground'}`}>{c.name}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">{word}</span>
                  </span>
                  <span className="block pl-[14px] font-mono text-[10.5px] text-muted-foreground">
                    {c.command}
                    {state?.version && <> <span data-cli-version>{state.version}</span></>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <PanelCaption className="mt-3">TO COME</PanelCaption>
        <ul aria-label="To come" className="mt-1 flex flex-col">
          {CLIS.filter((c) => c.soon).map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-2.5 py-1 text-[12px] text-muted-foreground">
              <StatusSquare tone="idle" />
              {c.name}
            </li>
          ))}
        </ul>
      </div>
      <section aria-label={`${cli.name} settings`} className="flex-1 min-w-0 pl-4">
        <div className="flex items-center gap-2 pt-3 pb-2">
          <h3 className="font-display text-[20px] leading-tight text-foreground">{cli.name}</h3>
          <MetaChip>{cli.command}</MetaChip>
          {v?.version && <span data-cli-version className="inline-flex"><MetaChip>{v.version}</MetaChip></span>}
        </div>
        {cli.keyId && (
          <KeyRow cli={cli} state={keyState} onChanged={readKeys} />
        )}
        {cli.id === 'claude' && claudeRows}
        {cli.id === 'qwen-code' && <QwenCodeRows />}
        <SettingsRow
          label="Command"
          description={v?.path ? (
            <>
              <span data-cli-path className="font-mono">{tildePath(v.path)}</span>
              {configuredPaths?.[cli.pathKey as keyof CLIPaths] === v.path
                ? ', set in CLI Paths.'
                : ', found on your PATH. Change it in CLI Paths.'}
            </>
          ) : `${cli.command} is not installed. Tars finds it on your PATH once it is, or in CLI Paths.`}
        />
      </section>
    </div>
  );
}

/**
 * A CLI's API key: whether one is set and under which variable, never the key.
 * Set takes what is pasted and forgets it; clear asks once.
 */
function KeyRow({ cli, state, onChanged }: { cli: CliDef; state: CliKeyState | null; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(''); setReplacing(false); setConfirming(false); setError(null); }, [cli.id]);

  const set = async (patch: { key?: string | null; envVar?: string | null }) => {
    if (!cli.keyId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI?.cliKeys?.set(cli.keyId, patch);
      if (!result?.success) { setError(`Not saved: ${result?.error || 'Tars could not save it.'}`); return; }
      setDraft('');
      setReplacing(false);
      setConfirming(false);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const variable = state?.envVar ? state.envVar : 'the variable you pick below';
  const description = state?.hasKey
    ? `Given to ${cli.name}'s agents only, through their environment, as ${variable}: never in a command line, never in ${cli.name}'s own files, never shown again once saved.`
    : `No key set: ${cli.name}'s agents use its own sign-in, or the key your shell holds.`;

  return (
    <>
      <SettingsRow
        label="API key"
        description={description}
        control={state?.hasKey && !replacing ? (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[11.5px] text-success"><StatusSquare tone="running" />a key is set</span>
            <Button size="sm" className="font-mono" onClick={() => setReplacing(true)}>replace</Button>
            <Button size="sm" className="font-mono" onClick={() => setConfirming(true)}>clear</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <PasswordInput
              width="control"
              aria-label={`${cli.name} API key`}
              value={draft}
              autoComplete="off"
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Paste a key"
            />
            <Button size="sm" variant="primary" disabled={busy || !draft.trim()} onClick={() => set({ key: draft.trim() })}>set</Button>
            {replacing && <Button size="sm" className="font-mono" onClick={() => { setReplacing(false); setDraft(''); }}>cancel</Button>}
          </div>
        )}
      />
      {state && !state.envVarFixed && state.envVarChoices.length > 0 && (
        <SettingsRow
          label="Key variable"
          description={`${cli.name} reads a key per model provider: the variable its agents get the key under.`}
          control={
            <Dropdown
              className="w-[220px]"
              ariaLabel={`${cli.name} key variable`}
              value={state.envVar ?? ''}
              onChange={(value) => set({ envVar: value })}
              options={state.envVarChoices.map((choice) => ({ value: choice, label: choice }))}
            />
          }
        />
      )}
      {confirming && (
        <div role="alertdialog" aria-label={`Clear ${cli.name}'s key`} className="my-2 flex items-center gap-3 px-3 py-2 bg-secondary border border-border">
          <StatusSquare tone="waiting" />
          <p className="flex-1 text-[12px] text-foreground">{`Clear ${cli.name}'s key? Its agents go back to their own sign-in at their next start.`}</p>
          <Button size="sm" className="font-mono" onClick={() => setConfirming(false)}>cancel</Button>
          <Button size="sm" className="font-mono" disabled={busy} onClick={() => set({ key: null })}>clear</Button>
        </div>
      )}
      {error && <p className="pb-2 text-[11.5px] text-danger">{error}</p>}
    </>
  );
}

/**
 * Qwen Code's own rows (PR 461): its models, read from the CLI's settings
 * (models.ofCli), and how it takes effort and permissions.
 */
function QwenCodeRows() {
  const [models, setModels] = useState<Array<{ id: string; name: string }> | null>(null);
  useEffect(() => {
    let live = true;
    window.electronAPI?.models?.ofCli('qwen-code')
      .then((res) => { if (live) setModels(res?.models ?? []); })
      .catch(() => { if (live) setModels([]); });
    return () => { live = false; };
  }, []);
  return (
    <>
      <SettingsRow
        label="Models"
        description={models === null
          ? 'Reading Qwen Code\'s models.'
          : models.length
            ? 'From Qwen Code\'s own settings (~/.qwen/settings.json): a new Qwen Code agent picks one of these.'
            : 'None in Qwen Code\'s settings (~/.qwen/settings.json): add a model provider there, then pick its models here.'}
        control={models && models.length > 0 ? (
          <ul aria-label="Qwen Code models" className="flex flex-col items-end gap-0.5">
            {models.map((m) => <li key={m.id} className="font-mono text-[11.5px] text-foreground">{m.name}</li>)}
          </ul>
        ) : undefined}
      />
      <SettingsRow label="Effort" description="Written into the settings Tars gives each Qwen Code agent, from the effort the agent is given." />
      <SettingsRow label="Permission mode" description="Plan, normal, auto or bypass, picked for each agent in New agent: Qwen Code runs them as its own approval modes." />
    </>
  );
}
