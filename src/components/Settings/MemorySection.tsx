'use client';

import type { ReactNode } from 'react';
import { Button, Input } from '@/components/ui';
import { secretIsSet } from '@/lib/secret-settings';
import { SettingsCard } from './SettingsCard';
import { OverseerAutonomy } from './OverseerAutonomy';
import { SettingsRow } from './SettingsRow';
import { SecretRow } from './SecretRow';
import { Toggle } from './Toggle';
import type { AppSettings } from './types';

interface MemorySectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
  /** What secrets.set answered (useSettings' setSecretState). */
  onSecretChanged: (field: string, set: boolean) => void;
}

interface BackendRowsProps {
  title: string;
  description: ReactNode;
  docUrl: string;
  enabled: boolean;
  url: string;
  urlPlaceholder: string;
  /** The setting secrets.set takes for the backend's secret, and whether main holds one. */
  tokenField: 'memoryGbrainAuthToken' | 'memoryHonchoApiKey';
  tokenSet: boolean;
  tokenLabel: string;
  tokenHint: string;
  onToggle: (enabled: boolean) => void;
  /** `persist` is false while typing and true on blur - see the note below. */
  onUrlChange: (url: string, persist: boolean) => void;
  onSecretChanged: (field: string, set: boolean) => void;
}

/**
 * A backend is three rows, never a card: the switch, its endpoint and its
 * secret. The endpoint and the secret stay on screen whether or not the backend
 * is on - you configure it first, then turn it on.
 *
 * There is no per-backend Save button any more. Typing updates the settings in
 * place and leaving a field writes them, so the header's single action is free
 * to be `Check`.
 */
function BackendRows({
  title,
  description,
  docUrl,
  enabled,
  url,
  urlPlaceholder,
  tokenField,
  tokenSet,
  tokenLabel,
  tokenHint,
  onToggle,
  onUrlChange,
  onSecretChanged,
}: BackendRowsProps) {
  return (
    <>
      <SettingsRow
        label={title}
        description={
          <>
            {description}{' '}
            <a href={docUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              Docs
            </a>
          </>
        }
        control={<Toggle enabled={enabled} onChange={() => onToggle(!enabled)} />}
      />

      <SettingsRow
        label="MCP endpoint URL"
        control={
          <Input
            mono
            width="control"
            value={url}
            onChange={e => onUrlChange(e.target.value, false)}
            onBlur={e => onUrlChange(e.target.value.trim(), true)}
            placeholder={urlPlaceholder}
          />
        }
      />

      <SecretRow
        field={tokenField}
        label={tokenLabel}
        noun={tokenField === 'memoryHonchoApiKey' ? 'key' : 'token'}
        set={tokenSet}
        description={tokenHint}
        clearWarning={`Clear the ${tokenLabel.toLowerCase()}? The backend is called without one from the next agent on.`}
        onChanged={onSecretChanged}
      />
    </>
  );
}

export const MemorySection = ({ appSettings, onSaveAppSettings, onUpdateLocalSettings, onSecretChanged }: MemorySectionProps) => {
  const write = (updates: Partial<AppSettings>, persist: boolean) =>
    (persist ? onSaveAppSettings : onUpdateLocalSettings)(updates);

  const vaultPath = appSettings.obsidianVaultPaths?.[0] ?? '';

  const chooseVault = async () => {
    const picked = await window.electronAPI?.dialog?.openFolder();
    // Cancelling the picker must not clear a path that is already set.
    if (picked) onSaveAppSettings({ obsidianVaultPaths: [picked] });
  };

  return (
    <>
    <SettingsCard>
      <BackendRows
        title="gbrain"
        description="Shared semantic memory (vector + knowledge graph)."
        docUrl="https://github.com/garrytan/gbrain"
        enabled={!!appSettings.memoryGbrainEnabled}
        url={appSettings.memoryGbrainMcpUrl || ''}
        urlPlaceholder="https://gbrain.example.com/mcp"
        tokenField="memoryGbrainAuthToken"
        tokenSet={secretIsSet(appSettings, 'memoryGbrainAuthToken')}
        tokenLabel="Auth token"
        tokenHint="Sent as a bearer token to gbrain's MCP server."
        onToggle={enabled => onSaveAppSettings({ memoryGbrainEnabled: enabled })}
        onUrlChange={(url, persist) => write({ memoryGbrainMcpUrl: url }, persist)}
        onSecretChanged={onSecretChanged}
      />

      {/* Obsidian is a folder of markdown, not an MCP endpoint, so it gets a
          path and a picker rather than a URL and a token. */}
      <SettingsRow
        label="Obsidian"
        description={
          <>
            Read and write your vault as a memory. Agents write into a Tars folder inside it, never into your own notes.{' '}
            <a href="https://obsidian.md" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              Docs
            </a>
          </>
        }
        control={
          <div className="flex items-center gap-2">
            <Input
              mono
              width="control"
              value={vaultPath}
              onChange={e => write({ obsidianVaultPaths: e.target.value ? [e.target.value] : [] }, false)}
              onBlur={e => {
                const v = e.target.value.trim();
                onSaveAppSettings({ obsidianVaultPaths: v ? [v] : [] });
              }}
              placeholder="/Users/you/Documents/MyVault"
            />
            <Button size="md" onClick={chooseVault}>Browse</Button>
          </div>
        }
      />

      <BackendRows
        title="Honcho"
        description="Plastic Labs' memory layer (peers, sessions, working representations)."
        docUrl="https://honcho.dev/docs/v3/guides/integrations/mcp"
        enabled={!!appSettings.memoryHonchoEnabled}
        url={appSettings.memoryHonchoMcpUrl || 'https://mcp.honcho.dev'}
        urlPlaceholder="https://mcp.honcho.dev"
        tokenField="memoryHonchoApiKey"
        tokenSet={secretIsSet(appSettings, 'memoryHonchoApiKey')}
        tokenLabel="API key"
        tokenHint="Sent to Honcho's MCP server."
        onToggle={enabled => onSaveAppSettings({ memoryHonchoEnabled: enabled })}
        onUrlChange={(url, persist) => write({ memoryHonchoMcpUrl: url }, persist)}
        onSecretChanged={onSecretChanged}
      />

      {/* Honcho only, so it is a sibling row rather than a fourth row on
          BackendRows: gbrain needs no workspace and should not grow a field
          it would leave empty forever. */}
      <SettingsRow
        label="Workspace ID"
        description="Honcho refuses any tool call that does not name a workspace, and none of its tools asks for one, so an agent cannot supply it by itself. Without this a valid API key connects and then does nothing at all. Copy it from your Honcho dashboard. Left empty, no workspace is sent and Tars behaves exactly as it did before."
        control={
          <Input
            mono
            width="control"
            value={appSettings.memoryHonchoWorkspaceId || ''}
            onChange={e => write({ memoryHonchoWorkspaceId: e.target.value }, false)}
            onBlur={e => write({ memoryHonchoWorkspaceId: e.target.value.trim() }, true)}
            placeholder="Sent as X-Honcho-Workspace-ID"
          />
        }
      />
    </SettingsCard>

    <OverseerAutonomy />
    </>
  );
};
