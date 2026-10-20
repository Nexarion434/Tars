'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { secretIsSet } from '@/lib/secret-settings';
import { Toggle } from './Toggle';
import { SettingsRow } from './SettingsRow';
import { SecretRow } from './SecretRow';
import type { AppSettings } from './types';

interface SocialDataSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
  /** What secrets.set answered (useSettings' setSecretState). */
  onSecretChanged: (field: string, set: boolean) => void;
}

export const SocialDataSection = ({ appSettings, onSaveAppSettings, onSecretChanged }: SocialDataSectionProps) => {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [testingX, setTestingX] = useState(false);
  const [testXResult, setTestXResult] = useState<{ success: boolean; message: string } | null>(null);

  // Each test asks main, which reads the keys it keeps: they are set through
  // their own rows (secrets.set), never handed to the page (2.0.4, #466).
  const handleTestConnection = async () => {
    if (!window.electronAPI?.socialData?.test) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.socialData.test();
      if (result.success) {
        setTestResult({ success: true, message: 'API key is valid! Connected to SocialData.' });
      } else {
        setTestResult({ success: false, message: result.error || 'Connection failed' });
      }
    } catch (err) {
      setTestResult({ success: false, message: `Connection failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setTesting(false);
    }
  };

  const handleTestXConnection = async () => {
    setTestingX(true);
    setTestXResult(null);
    try {
      if (!window.electronAPI?.xApi?.test) {
        setTestXResult({ success: false, message: 'X API bridge not available. Please restart the app.' });
        return;
      }

      const result = await window.electronAPI.xApi.test();
      if (result.success) {
        setTestXResult({ success: true, message: result.username ? `Authenticated as @${result.username}` : 'X API credentials are valid!' });
      } else {
        setTestXResult({ success: false, message: result.error || 'Connection failed' });
      }
    } catch (err) {
      setTestXResult({ success: false, message: `Connection failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setTestingX(false);
    }
  };

  const canEnable = secretIsSet(appSettings, 'socialDataApiKey');
  const canEnableXPosting = (['xApiKey', 'xApiSecret', 'xAccessToken', 'xAccessTokenSecret'] as const)
    .every((field) => secretIsSet(appSettings, field));
  const xKey = (field: 'xApiKey' | 'xApiSecret' | 'xAccessToken' | 'xAccessTokenSecret', label: string, noun: 'key' | 'secret' | 'token', description: string) => (
    <SecretRow
      field={field}
      label={label}
      noun={noun}
      set={secretIsSet(appSettings, field)}
      description={description}
      clearWarning={`Clear the ${label.toLowerCase()}? Posting stops until it is set again.`}
      onChanged={onSecretChanged}
    />
  );

  // No cards of our own: the bordered surface comes from the `<SettingsCard>`
  // in `settings/page.tsx`, and the page name is in the header. Where a
  // credential comes from is one line on the row that asks for it, and each
  // key has its row (frame `Secrets · states`): a set key says so, and a pair
  // of them no longer fits the 300px column.
  return (
    <>
      <SettingsRow
        label="Read access"
        description={
          testResult ? (
            <span className={testResult.success ? 'text-status-running' : 'text-status-error'}>
              {testResult.message}
            </span>
          ) : (
            <>Search and analyse X through SocialData.</>
          )
        }
        control={
          <Button
            size="sm"
            variant="ghost"
            className="font-mono"
            onClick={handleTestConnection}
            disabled={!canEnable || testing}
          >
            test
          </Button>
        }
        secondaryControl={
          <Toggle
            enabled={appSettings.socialDataEnabled}
            onChange={() => onSaveAppSettings({ socialDataEnabled: !appSettings.socialDataEnabled })}
            disabled={!canEnable}
          />
        }
      />

      <SecretRow
        field="socialDataApiKey"
        label="SocialData key"
        set={canEnable}
        description="From socialdata.tools."
        placeholder="sd_..."
        clearWarning="Clear SocialData's key? Your agents can no longer search X until a key is set."
        onChanged={onSecretChanged}
      />

      <SettingsRow
        label="Posting"
        description={
          testXResult ? (
            <span className={testXResult.success ? 'text-status-running' : 'text-status-error'}>
              {testXResult.message}
            </span>
          ) : (
            <>Post, reply and delete on your behalf. OAuth 1.0a, from the X developer portal.</>
          )
        }
        control={
          <Button
            size="sm"
            variant="ghost"
            className="font-mono"
            onClick={handleTestXConnection}
            disabled={!canEnableXPosting || testingX}
          >
            test
          </Button>
        }
        secondaryControl={
          <Toggle
            enabled={appSettings.xPostingEnabled}
            onChange={() => onSaveAppSettings({ xPostingEnabled: !appSettings.xPostingEnabled })}
            disabled={!canEnableXPosting}
          />
        }
      />

      {xKey('xApiKey', 'Consumer key', 'key', "The X app's API key.")}
      {xKey('xApiSecret', 'Consumer secret', 'secret', "The X app's API secret.")}
      {xKey('xAccessToken', 'Access token', 'token', 'Needs Read and Write permissions, or posting fails at the API.')}
      {xKey('xAccessTokenSecret', 'Access token secret', 'secret', 'Comes with the access token.')}
    </>
  );
};
