import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../../electron/utils/redact-secrets';

/**
 * A path under a secret-sounding name is a location, not a secret (audit B
 * U-07). `looksLikePlaceholder` knew `/…`, `~/…` and URLs; a Windows path was
 * none of those, so `GITHUB_TOKEN_FILE=C:\Users\nicol\.config\gh\hosts.yml`
 * or `"tokenPath": "C:\\Users\\…"` in a config print came out masked, and the
 * line an agent relayed to Telegram no longer said where the file was.
 *
 * How it can fail, written before the code:
 *  1. A drive path, either separator, is masked.
 *  2. A JSON-escaped drive path (`C:\\Users\\…`, how app-settings.json and any
 *     JSON.stringify print it) is masked.
 *  3. The long forms `\\?\C:\…` and `\\?\UNC\…`, and a share `\\host\share\…`,
 *     are masked.
 *  4. `~\…`, the Windows spelling of `~/…`, is masked.
 *  5. Over-reach: a real secret that merely contains a colon or a backslash
 *     somewhere, or starts with a letter and a colon, stops being masked.
 */

const j = (...parts: string[]) => parts.join('');

describe('redactSecrets and Windows paths', () => {
  it.each([
    'GITHUB_TOKEN=C:\\Users\\nicol\\.config\\gh\\hosts.yml',
    'GITHUB_TOKEN=C:/Users/nicol/.config/gh/hosts.yml',
    'SECRET_FILE=d:\\vault\\keys.json',
    'API_KEY_PATH=\\\\?\\C:\\Users\\nicol\\key.txt',
    'API_KEY_PATH=\\\\?\\UNC\\server\\share\\key.txt',
    'API_KEY_PATH=\\\\server\\share\\key.txt',
    'API_KEY_PATH=~\\.keys\\anthropic',
  ])('1, 3, 4: leaves %s alone', (line) => {
    expect(redactSecrets(line)).toBe(line);
  });

  it('2: leaves a JSON-escaped drive path alone', () => {
    const json = '{"tokenPath":"C:\\\\Users\\\\nicol\\\\.dorothy\\\\api-token"}';
    expect(redactSecrets(json)).toBe(json);
  });

  it('5: still masks a secret that holds a colon or a backslash, or starts with a letter and a colon', () => {
    const secrets = [
      j('Zk8', 'q:Lm2', 'Rv7bTnL4pWyE9x'),
      j('a:', 'bcd3', 'Kq8ZmR2vX7bT'),
      j('Qw\\', 'e9Rt5', 'Yu2Io8Pa4Sd'),
    ];
    for (const secret of secrets) {
      expect(redactSecrets(`API_KEY=${secret}`), secret).not.toContain(secret);
    }
  });
});
