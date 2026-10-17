import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Tars's Hermes session, kept and watched, in the real app (services/hermes-session-watch.ts).
 *
 * The sandbox's connection file names a stand-in of a signed-in Hermes gateway,
 * built on what Hermes 0.21.5's own code does: /api/status says a sign-in is
 * required, /auth/password-login sets the session cookies, and every signed-in
 * request rotates the access cookie, as its middleware does when it refreshes.
 * The app asks it every half second (DOROTHY_HERMES_SESSION_EVERY_MS).
 * - Before any sign-in, the window is told Tars is signed out, with the sentence
 *   the kanban tools answer with.
 * - Signed in through hermes.signIn, the window is told at once: signed in, 0.21.5
 *   measured. Each check carries the cookie the previous answer rotated: the
 *   session is renewed by the checks themselves.
 * - The gateway names a version whose rules were not measured: the window is told.
 * - The gateway ends the session (a new signing secret, as a restart can): the
 *   window is told signed out, at the next check.
 * - The gateway stops answering: the window is told unreachable, not signed out.
 *
 * The artefact: values.json with every state pushed and every request the stand-in saw.
 */

type State = { session: string; version?: string; unmeasured: boolean; message?: string };
type Api = { electronAPI: { hermes: {
  sessionState(): Promise<State>;
  onSessionState(cb: (s: State) => void): () => void;
  signIn(p: { connection: Record<string, unknown>; username: string; password: string }): Promise<{ success: boolean; error?: string }>;
} } };

test('Tars renews its Hermes session by asking it, and the window is told at once when it ends', async () => {
  test.setTimeout(180_000);
  let version = '0.21.5';
  let secret = 'first';
  let rotation = 0;
  let current = '';
  const requests: Array<{ path: string; cookie: string; status: number; latest?: boolean }> = [];
  const gateway = http.createServer((req, res) => {
    const cookie = String(req.headers.cookie ?? '');
    const at = /hermes_session_at=([^;]+)/.exec(cookie)?.[1] ?? '';
    const answer = (status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
      requests.push({ path: String(req.url), cookie, status, latest: !!at && at === current });
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const url = String(req.url);
    if (url === '/api/status') return answer(200, { version, auth_required: true, auth_flows: ['cookie'], auth_providers: ['basic'], gateway_state: 'running' });
    if (url === '/auth/password-login' && req.method === 'POST') {
      current = `${secret}.0`;
      return answer(200, { ok: true }, { 'Set-Cookie': [`hermes_session_at=${current}; Path=/; HttpOnly`, `hermes_session_rt=${secret}.rt; Path=/; HttpOnly`] });
    }
    if (!at.startsWith(`${secret}.`)) return answer(401, { detail: 'Unauthorized' });
    rotation += 1;
    const presented = at;
    current = `${secret}.${rotation}`;
    requests.push({ path: `${req.url} (rotated)`, cookie: presented, status: 200, latest: true });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `hermes_session_at=${current}; Path=/; HttpOnly` });
    res.end(JSON.stringify({ jobs: [] }));
  });
  await new Promise<void>(r => gateway.listen(0, '127.0.0.1', r));
  const port = (gateway.address() as AddressInfo).port;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-hermes-session-'));
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  const connection = { mode: 'local', localPort: port, authMode: 'oauth' };
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify(connection));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const app = await launchSandboxed(electron, home, {
    env: {
      NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31302), DOROTHY_E2E: '1',
      DOROTHY_HERMES_SESSION_EVERY_MS: '500',
    },
  });
  const errors: string[] = [];
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Api).electronAPI?.hermes?.onSessionState, null, { timeout: 60_000 });
    await page.evaluate(() => {
      const w = window as unknown as Api & { __states: State[] };
      w.__states = [];
      w.electronAPI.hermes.onSessionState(s => w.__states.push(s));
    });
    const now = () => page.evaluate(() => (window as unknown as Api).electronAPI.hermes.sessionState());
    const pushed = () => page.evaluate(() => (window as unknown as { __states: State[] }).__states);

    // Before any sign-in: signed out, in the kanban tools' own sentence.
    await expect.poll(async () => (await now()).session, { timeout: 30_000 }).toBe('signed-out');
    const out = await now();
    expect(out.message).toMatch(/^Tars is signed out of Hermes: sign in again in Settings, Hermes\./);
    seen.beforeSignIn = out;

    // Signed in: told at once, 0.21.5 measured, and each check renews the cookie.
    const signed = await page.evaluate(c => (window as unknown as Api).electronAPI.hermes.signIn({ connection: c, username: 'u', password: 'p' }), connection);
    expect(signed.success).toBe(true);
    await expect.poll(async () => (await pushed()).at(-1)?.session, { timeout: 15_000 }).toBe('signed-in');
    expect(await now()).toMatchObject({ session: 'signed-in', version: '0.21.5', unmeasured: false });
    await expect.poll(() => rotation, { timeout: 15_000 }).toBeGreaterThanOrEqual(5);
    // The checks present the cookies the answers rotated: the rotated ones were
    // kept, so the session is renewed by the checks themselves. The first two
    // can both carry the sign-in's own cookie: a sign-in starts a check and its
    // own probe together, each sent before the other's answer came back.
    const authed = requests.filter(r => r.path.endsWith('(rotated)'));
    const values = authed.map(r => /hermes_session_at=([^;]+)/.exec(r.cookie)?.[1]);
    seen.renewed = values;
    expect(values.at(-1)).toMatch(/^first\.[1-9][0-9]*$/);
    expect(new Set(values.filter(v => v !== 'first.0')).size).toBeGreaterThanOrEqual(2);

    // A version whose rules were not measured: told.
    version = '0.22.0';
    await expect.poll(async () => (await pushed()).at(-1), { timeout: 15_000 }).toMatchObject({ session: 'signed-in', version: '0.22.0', unmeasured: true });

    // The gateway ends the session: told signed out at the next check.
    secret = 'second';
    await expect.poll(async () => (await pushed()).at(-1)?.session, { timeout: 15_000 }).toBe('signed-out');
    expect((await now()).message).toMatch(/^Tars is signed out of Hermes/);

    // The gateway stops answering: unreachable, not signed out.
    await new Promise<void>(r => { gateway.closeAllConnections(); gateway.close(() => r()); });
    await expect.poll(async () => (await pushed()).at(-1)?.session, { timeout: 15_000 }).toBe('unreachable');
    expect((await now()).message).not.toMatch(/signed out/);

    seen.pushed = await pushed();
    seen.requests = requests.length;
    expect(errors).toEqual([]);
  } finally {
    recordValues({ ...seen, errors });
    await app.close();
    if (gateway.listening) gateway.close();
    await removeHome(home);
  }
});
