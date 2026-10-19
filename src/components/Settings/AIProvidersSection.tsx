'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { Button, Input, MetaChip, PanelCaption, Select, StatusBadge, Dropdown } from '@/components/ui';
import { isValidOpenAIBaseUrl } from '@/lib/validateUrl';
import type { AnyTone } from '@/components/ui';
import { Toggle } from './Toggle';
import { SettingsRow } from './SettingsRow';
import { SecretRow } from './SecretRow';
import CliPanels, { type CliVersions } from './CliPanels';
import { CLIS } from '@/lib/clis';
import { versionNumber } from '@/lib/cli-version';
import { secretIsSet } from '@/lib/secret-settings';
import { useCliDetection } from '@/hooks/useCliDetection';
import { settingsSectionOffered } from '@/lib/claude-accounts-offered';
import type { AppSettings } from './types';

interface AIProvidersSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
  /** What secrets.set answered (useSettings' setSecretState). */
  onSecretChanged: (field: string, set: boolean) => void;
  /** Opens Settings, Claude accounts, from Claude Code's Sign-in row. */
  onOpenClaudeAccounts?: () => void;
}


/** 12px mark: lit when the provider can actually run, flat when it cannot. */
const Mark = ({ on }: { on: boolean }) => (
  <span className={`w-3 h-3 shrink-0 ${on ? 'bg-primary' : 'bg-border-accent'}`} />
);

/**
 * The label half of a provider row: mark, name, and the status word beside it -
 * `ready`, `not installed`, `key set`, `no key`. The word carries the status
 * colour and nothing else: no fill, no pill.
 */
const ProviderLabel = ({ name, status, tone, on }: {
  name: string;
  status: string;
  tone: AnyTone;
  on: boolean;
}) => (
  <span className="inline-flex items-center gap-2 min-w-0">
    <Mark on={on} />
    <span className="truncate">{name}</span>
    <StatusBadge tone={tone} className="font-mono shrink-0">{status}</StatusBadge>
  </span>
);

/** Everything a row hides behind `configure`, on its own raised surface. */
const ConfigureArea = ({ children }: { children: ReactNode }) => (
  <div className="bg-secondary divide-y divide-border">{children}</div>
);

const ConfigureButton = ({ open, onClick }: { open: boolean; onClick: () => void }) => (
  <Button size="sm" variant="ghost" aria-expanded={open} onClick={onClick}>
    configure
  </Button>
);

const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

export const AIProvidersSection = ({ appSettings, onSaveAppSettings, onUpdateLocalSettings, onSecretChanged, onOpenClaudeAccounts }: AIProvidersSectionProps) => {
  // Not on a Windows build, which has no Claude accounts yet (lib/claude-accounts-offered.ts): read after hydration, as the bridge is.
  const [accountsOffered, setAccountsOffered] = useState(true);
  useEffect(() => setAccountsOffered(settingsSectionOffered('claude-accounts')), []);
  // One row at a time is open: the keys and model lists are reference material,
  // not a form you fill top to bottom.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [cliVersions, setCliVersions] = useState<CliVersions>(() =>
    Object.fromEntries(CLIS.filter((c) => !c.soon).map((c) => [c.id, { path: null, version: null, loading: true }])),
  );
  // Ready is where the one detection found the CLI (CLI Paths shows the same
  // path), and its version is asked of that very binary.
  const { paths: detected } = useCliDetection();

  // The one field here that isn't a key: reject and explain rather than
  // silently persisting something that will 404 the moment an agent starts.
  const [customUrlInvalid, setCustomUrlInvalid] = useState(false);
  const handleCustomUrlBlur = () => {
    const value = appSettings.customOpenAIBaseUrl || '';
    const invalid = value.trim().length > 0 && !isValidOpenAIBaseUrl(value);
    setCustomUrlInvalid(invalid);
    if (!invalid) onSaveAppSettings({ customOpenAIBaseUrl: value });
  };

  // Ollama has no key to gate on: whether it's usable is whether the local
  // server answers, so this is a live check, not a settings read.
  const [ollamaStatus, setOllamaStatus] = useState<{ checking: boolean; reachable: boolean }>({ checking: true, reachable: false });
  const checkOllama = useCallback(async () => {
    setOllamaStatus({ checking: true, reachable: false });
    const result = await window.electronAPI?.ollama?.test().catch(() => undefined);
    setOllamaStatus({ checking: false, reachable: !!result?.reachable });
  }, []);
  useEffect(() => { checkOllama(); }, [checkOllama]);

  useEffect(() => {
    if (!detected) return;
    let current = true;
    void Promise.all(
      CLIS.filter((c) => !c.soon).map(async (cli) => {
        const path = (cli.pathKey && detected[cli.pathKey]) || null;
        if (!path) return [cli.id, { path: null, version: null, loading: false }] as const;
        try {
          const result = await window.electronAPI?.shell?.version(path);
          return [cli.id, { path, version: result?.success ? versionNumber(result.output) : null, loading: false }] as const;
        } catch {
          return [cli.id, { path, version: null, loading: false }] as const;
        }
      }),
    ).then((entries) => { if (current) setCliVersions(Object.fromEntries(entries)); });
    return () => { current = false; };
  }, [detected]);

  const toggleExpanded = (id: string) => setExpanded((cur) => (cur === id ? null : id));

  // Same fields the provider cards carried, one entry per provider. The key
  // handlers are unchanged: type into local settings, persist on blur.
  const apiProviders = [
    {
      // Not a section of its own: it is a provider like the others, with two
      // more fields. A vendor with no catalogue still belongs in the list of
      // vendors.
      id: 'custom-openai',
      name: 'Custom (OpenAI-compatible)',
      detail: appSettings.customOpenAIBaseUrl || 'no base url set',
      note: 'Leave blank if the endpoint needs none.',
      docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
      placeholder: 'sk-... (optional)',
      enabled: !!appSettings.customOpenAIEnabled,
      onToggle: () => onSaveAppSettings({ customOpenAIEnabled: !appSettings.customOpenAIEnabled }),
      keyField: 'customOpenAIApiKey' as const,
      models: [appSettings.customOpenAIModel || 'no model set'],
      extraRows: (
        <>
          <SettingsRow
            label="Base URL"
            description={
              customUrlInvalid
                ? <span className="text-danger">Must be a full http:// or https:// URL, and not a link-local address, e.g. https://api.example.com/v1</span>
                : 'Any OpenAI-compatible /chat/completions endpoint: vLLM, LM Studio, a hosted vendor with no Anthropic support.'
            }
            control={
              <Input
                width="control"
                value={appSettings.customOpenAIBaseUrl ?? ''}
                onChange={(e) => { onUpdateLocalSettings({ customOpenAIBaseUrl: e.target.value }); setCustomUrlInvalid(false); }}
                onBlur={handleCustomUrlBlur}
                placeholder="https://api.example.com/v1"
              />
            }
          />
          <SettingsRow
            label="Model"
            description="The exact model id this endpoint expects. There is no catalogue to pick from, so type it as the vendor documents it."
            control={
              <Input
                width="control"
                value={appSettings.customOpenAIModel || ''}
                onChange={(e) => onUpdateLocalSettings({ customOpenAIModel: e.target.value })}
                onBlur={() => onSaveAppSettings({ customOpenAIModel: appSettings.customOpenAIModel })}
                placeholder="llama-3.1-70b-instruct"
              />
            }
          />
        </>
      ),
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      detail: 'openrouter · one key, 300+ models',
      note: 'The fallback every other provider uses when it has no key of its own.',
      docsUrl: 'https://openrouter.ai/keys',
      placeholder: 'sk-or-v1-...',
      enabled: !!appSettings.openRouterEnabled,
      onToggle: () => onSaveAppSettings({ openRouterEnabled: !appSettings.openRouterEnabled }),
      keyField: 'openRouterApiKey' as const,
      models: ['deepseek/deepseek-r1', 'moonshotai/kimi-k2', 'xiaomi/mimo-v2-pro', 'qwen/qwq-32b', 'openai/gpt-4.1', 'google/gemini-2.5-pro', '300+ more…'],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      detail: 'deepseek · anthropic-compatible',
      note: 'Direct via api.deepseek.com. Falls back to OpenRouter with no key.',
      docsUrl: 'https://platform.deepseek.com/api_keys',
      placeholder: 'sk-...',
      enabled: !!appSettings.deepSeekEnabled,
      onToggle: () => onSaveAppSettings({ deepSeekEnabled: !appSettings.deepSeekEnabled }),
      keyField: 'deepSeekApiKey' as const,
      models: ['deepseek/deepseek-r1', 'deepseek/deepseek-chat', 'deepseek/deepseek-r1-distill-llama-70b'],
    },
    {
      id: 'moonshot',
      name: 'MoonshotAI (Kimi)',
      detail: 'moonshot · anthropic-compatible',
      note: 'Direct via api.moonshot.ai. Falls back to OpenRouter with no key.',
      docsUrl: 'https://platform.moonshot.cn/console/api-keys',
      placeholder: 'sk-...',
      enabled: !!appSettings.moonshotEnabled,
      onToggle: () => onSaveAppSettings({ moonshotEnabled: !appSettings.moonshotEnabled }),
      keyField: 'moonshotApiKey' as const,
      models: ['moonshotai/kimi-k2', 'moonshotai/moonlight-16k', 'moonshotai/kimi-vl-a3b-thinking'],
    },
    {
      id: 'mimo',
      name: 'MiMo (Xiaomi)',
      detail: 'mimo · routes via openrouter',
      note: 'No Anthropic-compatible endpoint: requests always use your OpenRouter key.',
      docsUrl: 'https://platform.xiaomimimo.com',
      placeholder: 'sk-...',
      enabled: !!appSettings.mimoEnabled,
      onToggle: () => onSaveAppSettings({ mimoEnabled: !appSettings.mimoEnabled }),
      keyField: 'mimoApiKey' as const,
      models: ['xiaomi/mimo-v2-pro', 'xiaomi/mimo-v2-flash', 'xiaomi/mimo-v2-omni'],
    },
    {
      id: 'qwen',
      name: 'Qwen (Alibaba)',
      detail: 'qwen · routes via openrouter',
      note: 'No Anthropic-compatible endpoint: requests always use your OpenRouter key.',
      docsUrl: 'https://dashscope.console.aliyun.com/apiKey',
      placeholder: 'sk-...',
      enabled: !!appSettings.qwenEnabled,
      onToggle: () => onSaveAppSettings({ qwenEnabled: !appSettings.qwenEnabled }),
      keyField: 'qwenApiKey' as const,
      models: ['qwen/qwq-32b', 'qwen/qwen-2.5-72b-instruct', 'qwen/qwen-2.5-coder-32b-instruct', 'qwen/qwen3-235b-a22b'],
    },
    {
      id: 'zhipu',
      name: 'Zai (GLM)',
      detail: 'zhipu · anthropic-compatible',
      note: 'Direct via open.bigmodel.cn. Falls back to OpenRouter with no key.',
      docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
      placeholder: '...',
      enabled: !!appSettings.zhipuEnabled,
      onToggle: () => onSaveAppSettings({ zhipuEnabled: !appSettings.zhipuEnabled }),
      keyField: 'zhipuApiKey' as const,
      models: ['zhipuai/glm-4.6', 'zhipuai/glm-4.5', 'zhipuai/glm-4-plus', 'zhipuai/glm-4-air', 'zhipuai/glm-4-flash'],
    },
    {
      id: 'minimax',
      name: 'MiniMax',
      detail: 'minimax · anthropic-compatible',
      note: 'Direct via api.minimax.io. Falls back to OpenRouter with no key.',
      docsUrl: 'https://www.minimax.chat/platform',
      placeholder: '...',
      enabled: !!appSettings.minimaxEnabled,
      onToggle: () => onSaveAppSettings({ minimaxEnabled: !appSettings.minimaxEnabled }),
      keyField: 'minimaxApiKey' as const,
      models: ['minimax/minimax-m2', 'minimax/minimax-m1', 'minimax/minimax-01'],
    },
    {
      id: 'venice',
      name: 'Venice AI',
      detail: 'venice · openai-compatible only',
      note: 'No Anthropic-compatible endpoint and not on OpenRouter: Tars translates locally, no fallback.',
      docsUrl: 'https://venice.ai/api',
      placeholder: 'vn_...',
      enabled: !!appSettings.veniceEnabled,
      onToggle: () => onSaveAppSettings({ veniceEnabled: !appSettings.veniceEnabled }),
      keyField: 'veniceApiKey' as const,
      models: ['llama-3.3-70b', 'venice-uncensored-1-2', 'deepseek-v3.2', 'qwen3-235b-a22b-instruct-2507'],
    },
    {
      id: 'ollama-cloud',
      name: 'Ollama Cloud',
      detail: 'ollama-cloud · anthropic-compatible, bearer auth',
      note: 'Direct via ollama.com. Its endpoint wants a Bearer token rather than the usual key header - Tars sends it that way automatically.',
      docsUrl: 'https://ollama.com/settings/keys',
      placeholder: '...',
      enabled: !!appSettings.ollamaCloudEnabled,
      onToggle: () => onSaveAppSettings({ ollamaCloudEnabled: !appSettings.ollamaCloudEnabled }),
      keyField: 'ollamaCloudApiKey' as const,
      models: ['gpt-oss:120b', 'glm-5.2', 'kimi-k2.7-code', 'deepseek-v4-pro'],
    },
  ];

  return (
    <>
      <CliPanels
        versions={cliVersions}
        configuredPaths={appSettings.cliPaths}
        claudeRows={
          <>
                {/* The frame's Sign-in row. It replaces an API key row that kept a key nothing in the main
                    process ever read, and put it back into its field. */}
                <SettingsRow
                  wrap
                  label="Sign-in"
                  description={accountsOffered
                    ? "Claude Code signs in with your Claude account; several accounts are in Settings, Claude accounts. An API provider's key goes on its own row, under API providers."
                    : "Claude Code signs in with your Claude account. An API provider's key goes on its own row, under API providers."}
                  control={accountsOffered && onOpenClaudeAccounts ? (
                    <Button size="sm" className="font-mono" onClick={onOpenClaudeAccounts}>Claude accounts</Button>
                  ) : undefined}
                />
                <SettingsRow
                  label="Default model"
                  description="The model a new Claude agent starts on."
                  control={
                    <Dropdown
                      className="w-[300px]"
                      ariaLabel="Default Claude model"
                      value={appSettings.defaultClaudeModel || 'sonnet'}
                      onChange={(v) => onSaveAppSettings({ defaultClaudeModel: v })}
                      options={[
                        { value: 'sonnet', label: 'Sonnet', hint: 'daily coding' },
                        { value: 'opus', label: 'Opus', hint: 'complex reasoning' },
                        { value: 'haiku', label: 'Haiku', hint: 'fast and cheap' },
                      ]}
                    />
                  }
                />
                <SettingsRow
                  label="Verbose mode"
                  description="Starts agents with --verbose for detailed output."
                  control={
                    <Toggle
                      enabled={!!appSettings.verboseModeEnabled}
                      onChange={() => onSaveAppSettings({ verboseModeEnabled: !appSettings.verboseModeEnabled })}
                    />
                  }
                />
                <SettingsRow
                  label="Chrome browser sharing"
                  description={
                    <>
                      Shares your logged-in Chrome via --chrome. Needs Claude Code 2.0.73+ and the{' '}
                      <a
                        href="https://chromewebstore.google.com/detail/claude-in-chrome/ofnckddkabkmfmjkfgiofpofhpgjdlda"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-foreground"
                      >
                        Claude in Chrome
                      </a>{' '}
                      extension.
                    </>
                  }
                  control={
                    <Toggle
                      enabled={!!appSettings.chromeEnabled}
                      onChange={() => onSaveAppSettings({ chromeEnabled: !appSettings.chromeEnabled })}
                    />
                  }
                />
                <SettingsRow
                  label="Status line"
                  description="Model, context, branch, session time and tokens, live inside the CLI."
                  control={
                    <Toggle
                      enabled={appSettings.statusLineEnabled === true}
                      onChange={() => onSaveAppSettings({ statusLineEnabled: !appSettings.statusLineEnabled })}
                    />
                  }
                />
          </>
        }
      />

      <div className="px-4 pt-4 pb-2">
        <PanelCaption>LOCAL</PanelCaption>
      </div>

      <div>
        <SettingsRow
          label={
            <ProviderLabel
              name="Ollama"
              status={ollamaStatus.checking ? 'checking' : ollamaStatus.reachable ? 'ready' : 'not running'}
              tone={ollamaStatus.checking ? 'idle' : ollamaStatus.reachable ? 'running' : 'idle'}
              on={ollamaStatus.reachable}
            />
          }
          description={<span className="font-mono">{appSettings.ollamaBaseUrl || OLLAMA_DEFAULT_BASE_URL}</span>}
          control={<ConfigureButton open={expanded === 'ollama'} onClick={() => toggleExpanded('ollama')} />}
        />

        {expanded === 'ollama' && (
          <ConfigureArea>
            <SettingsRow
              label="Base URL"
              description="No API key: Ollama is a local server, not a hosted vendor. Needs v0.14+ for its native Anthropic-compatible endpoint."
              control={
                <Input
                  width="control"
                  value={appSettings.ollamaBaseUrl ?? ''}
                  onChange={(e) => onUpdateLocalSettings({ ollamaBaseUrl: e.target.value })}
                  onBlur={() => onSaveAppSettings({ ollamaBaseUrl: appSettings.ollamaBaseUrl })}
                  placeholder={OLLAMA_DEFAULT_BASE_URL}
                />
              }
            />
            <SettingsRow
              label="Connection"
              description="Checks whether the server answers, not whether any particular model is pulled."
              control={
                <Button size="sm" variant="ghost" onClick={checkOllama} disabled={ollamaStatus.checking}>
                  {ollamaStatus.checking ? 'checking…' : 'test connection'}
                </Button>
              }
            />
            <div className="px-4 py-3 flex flex-wrap items-center gap-1.5">
              {['llama3.3', 'qwen2.5-coder', 'deepseek-r1', 'gpt-oss'].map((m) => (
                <MetaChip key={m}>{m}</MetaChip>
              ))}
              <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">whatever you&apos;ve pulled works too</span>
            </div>
          </ConfigureArea>
        )}
      </div>

      <div className="px-4 pt-4 pb-2">
        <PanelCaption>API PROVIDERS</PanelCaption>
      </div>

      {apiProviders.map((p) => {
        const hasKey = secretIsSet(appSettings, p.keyField);
        const open = expanded === p.id;
        return (
          <div key={p.id}>
            <SettingsRow
              label={
                <ProviderLabel
                  name={p.name}
                  status={hasKey ? 'key set' : 'no key'}
                  tone={hasKey ? 'running' : 'idle'}
                  on={hasKey}
                />
              }
              description={<span className="font-mono">{p.detail}</span>}
              control={<ConfigureButton open={open} onClick={() => toggleExpanded(p.id)} />}
              secondaryControl={<Toggle enabled={p.enabled} onChange={p.onToggle} />}
            />

            {open && (
              <ConfigureArea>
                {'extraRows' in p && p.extraRows}
                <SecretRow
                  field={p.keyField}
                  label="API key"
                  description={p.note}
                  set={hasKey}
                  placeholder={p.placeholder}
                  clearWarning={`Clear ${p.name}'s key? Its agents go without it from their next start.`}
                  onChanged={onSecretChanged}
                />
                <div className="px-4 py-3 flex flex-wrap items-center gap-1.5">
                  {p.models.map((m) => (
                    <MetaChip key={m}>{m}</MetaChip>
                  ))}
                  <a
                    href={p.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto font-mono text-[10.5px] text-muted-foreground hover:text-foreground underline"
                  >
                    get a key
                  </a>
                </div>
              </ConfigureArea>
            )}
          </div>
        );
      })}

      {/* What used to be a four-paragraph card explaining routing. One line is
          the whole rule; the per-provider detail lines say the rest. */}
      <div className="px-4 py-3">
        <p className="bg-bg-tertiary px-3 py-2 text-[11px] text-muted-foreground">
          Every provider runs on the Claude CLI with its base URL pointed at that provider - its own
          key when you set one, the OpenRouter key otherwise.
        </p>
      </div>
    </>
  );
};
