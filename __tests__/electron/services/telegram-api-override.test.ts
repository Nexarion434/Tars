import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, app: { getPath: () => '/tmp', isPackaged: false } }));

import { telegramApiOverride } from '../../../electron/services/telegram-bot';

/**
 * Where Tars's Telegram bot sends its requests, which carry the bot's token in their path: Telegram's API, or for the
 * E2E alone a stand-in of it on the loopback (PR F's proof of Telegram's chat numbers).
 *
 * How this can fail, written before the code:
 * 1. The override is read outside the E2E (DOROTHY_E2E unset or another value): a variable in the environment would
 *    then send the bot's token anywhere.
 * 2. An address that is not the loopback is taken: another host, localhost resolved through a hosts file, https to a
 *    remote, a userinfo trick ("http://127.0.0.1@evil.example"), a path that changes where the token lands.
 * 3. A malformed value throws and stops the bot from starting.
 */
describe('the Bot API address', () => {
  const e2e = (url: string | undefined) => ({ DOROTHY_E2E: '1', DOROTHY_TELEGRAM_API_URL: url });

  it('is Telegram\'s unless the E2E names a stand-in on 127.0.0.1', () => {
    expect(telegramApiOverride({})).toEqual({});
    expect(telegramApiOverride({ DOROTHY_TELEGRAM_API_URL: 'http://127.0.0.1:4000' })).toEqual({});
    expect(telegramApiOverride({ DOROTHY_E2E: 'true', DOROTHY_TELEGRAM_API_URL: 'http://127.0.0.1:4000' })).toEqual({});
    expect(telegramApiOverride(e2e('http://127.0.0.1:4000'))).toEqual({ baseApiUrl: 'http://127.0.0.1:4000' });
    expect(telegramApiOverride(e2e('http://127.0.0.1:4000/'))).toEqual({ baseApiUrl: 'http://127.0.0.1:4000' });
  });

  it.each([
    'http://evil.example:4000', 'http://localhost:4000', 'https://127.0.0.1:4000', 'http://127.0.0.1@evil.example:4000',
    'http://user:pw@127.0.0.1:4000', 'http://127.0.0.1:4000/elsewhere', 'http://[::1]:4000', 'not a url', '',
  ])('takes no %j', (url) => {
    expect(telegramApiOverride(e2e(url))).toEqual({});
  });
});
