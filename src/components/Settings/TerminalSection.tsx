import { useEffect, useState } from 'react';
import { Select, Dropdown, Input } from '@/components/ui';
import type { DropdownOption } from '@/components/ui';
import { rendererPlatform } from '@/lib/terminal';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import type { AppSettings } from './types';

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;
const DEFAULT_FONT_SIZE = 11;

const FONT_SIZES = Array.from(
  { length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 },
  (_, i) => MIN_FONT_SIZE + i
);

interface TerminalSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
}

type Detected = NonNullable<Awaited<ReturnType<NonNullable<NonNullable<Window['electronAPI']>['desktopShell']>['detectShells']>>>;
type ShellId = Detected['choices'][number]['id'];

const SHELL_NAMES: Record<ShellId, string> = {
  pwsh: 'PowerShell 7',
  powershell: 'Windows PowerShell',
  cmd: 'Command Prompt',
  'git-bash': 'Git Bash',
};

const sameFile = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The file name for a shell of Windows's own folder, the full path for anything installed. */
function shellHint(path: string): string {
  const inSystem = /^[a-z]:\\windows\\system32\\/i.test(path);
  return inSystem ? path.slice(path.lastIndexOf('\\') + 1) : path;
}

/**
 * The shell a new terminal opens in, Windows only (decision D9): the shells
 * this machine has, the one Tars picks when none is chosen, or a path typed
 * by hand. macOS and Linux keep $SHELL and never show these rows.
 */
function ShellRows({ appSettings, onSaveAppSettings }: TerminalSectionProps) {
  const [detected, setDetected] = useState<Detected | null>(null);
  const [customChosen, setCustomChosen] = useState(false);
  const setting = appSettings.terminalShell?.trim() ?? '';
  const [draft, setDraft] = useState(setting);

  useEffect(() => {
    if (rendererPlatform() !== 'win32') return;
    let live = true;
    window.electronAPI?.desktopShell?.detectShells()
      .then((d) => { if (live) setDetected(d); })
      .catch((err) => console.error('Settings > Terminal: shell detection failed', err));
    return () => { live = false; };
  }, []);

  useEffect(() => setDraft(setting), [setting]);

  if (!detected) return null;

  const match = setting ? detected.choices.find((c) => c.path && sameFile(c.path, setting)) : undefined;
  const value = customChosen || (setting && !match) ? 'custom' : match ? match.id : 'default';
  const defaultChoice = detected.choices.find((c) => c.path && sameFile(c.path, detected.defaultPath));
  const defaultName = defaultChoice ? SHELL_NAMES[defaultChoice.id] : shellHint(detected.defaultPath);

  const options: DropdownOption[] = [
    { value: 'default', label: `Default (${defaultName})`, hint: shellHint(detected.defaultPath) },
    ...detected.choices.map((c) => ({
      value: c.id,
      label: SHELL_NAMES[c.id],
      hint: c.path ? shellHint(c.path) : 'not installed',
      disabled: !c.path,
    })),
    { value: 'custom', label: 'Custom path' },
  ];

  const choose = (v: string) => {
    if (v === 'custom') {
      setCustomChosen(true);
      return;
    }
    setCustomChosen(false);
    const picked = detected.choices.find((c) => c.id === v);
    onSaveAppSettings({ terminalShell: picked?.path ?? '' });
  };

  const commitDraft = () => {
    const next = draft.trim();
    if (next && next !== setting) onSaveAppSettings({ terminalShell: next });
  };

  return (
    <>
      <SettingsRow
        label="Shell"
        description="The shell every new terminal opens in. Terminals already open keep theirs."
        control={
          <Dropdown
            className="w-[300px]"
            ariaLabel="Terminal shell"
            value={value}
            onChange={choose}
            options={options}
          />
        }
      />
      {value === 'custom' && (
        <SettingsRow
          label="Shell path"
          description="Full path to the executable. Arguments are not supported."
          control={
            <Input
              width="control"
              mono
              aria-label="Shell path"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={(e) => { if (e.key === 'Enter') commitDraft(); }}
            />
          }
        />
      )}
    </>
  );
}

export const TerminalSection = ({ appSettings, onSaveAppSettings }: TerminalSectionProps) => {
  const currentTheme = appSettings.terminalTheme || 'dark';
  const currentFontSize = appSettings.terminalFontSize || DEFAULT_FONT_SIZE;

  return (
    <SettingsCard>
      <ShellRows appSettings={appSettings} onSaveAppSettings={onSaveAppSettings} />

      <SettingsRow
        label="Theme"
        description="Applies to every agent terminal: Claude, Codex, Gemini and every CLI provider."
        control={
          <Dropdown
            className="w-[300px]"
            ariaLabel="Terminal theme"
            value={currentTheme}
            onChange={(v) => onSaveAppSettings({ terminalTheme: v as 'dark' | 'light' })}
            options={[
              { value: 'dark', label: 'dark' },
              { value: 'light', label: 'light' },
            ]}
          />
        }
      />

      <SettingsRow
        label="Font size"
        description="Controls font size on the Terminals page. Persisted across sessions."
        control={
          <Dropdown
            className="w-[300px]"
            ariaLabel="Terminal font size"
            value={String(currentFontSize)}
            onChange={(v) => onSaveAppSettings({ terminalFontSize: Number(v) })}
            options={FONT_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
          />
        }
      />
    </SettingsCard>
  );
};
