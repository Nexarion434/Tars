import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, seedSandbox, splashGone } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';

/**
 * Three reports on the installed 1.9.1-win.3, Settings > Hermes, with Hermes
 * Desktop set to SSH, reproduced here and then fixed.
 *
 * (a) "the Import button imports the wrong data". Hermes Desktop keeps two
 *     files: the v2 registry connections.json (a `primary` and a list of
 *     connections) and the v1 connection.json it no longer updates. The import
 *     read v1 only (JeanBrasse/Tars#262 reads the registry), and read the
 *     section named by `mode`, `raw[mode]`, where Hermes Desktop's v1 keeps an
 *     SSH connection under `remote` (measured on a Windows install, keys only).
 *     And the Status said "connected" after an import, with nothing asked.
 * (b) "a tiny field where I must put the address, and I can't paste into it".
 *     Every text field of the page, in every mode, measured, and edited by
 *     typing, Ctrl+V (Playwright's and the OS's) and a right click. The SSH
 *     host field was 18px wide beside a user field of 300, and a right click
 *     offered no menu anywhere in the app.
 * (c) "Sign in seems to do nothing". Sign in, in every mode the page offers,
 *     against a fake gateway, and what the page shows after each. SSH mode
 *     had no token field and said nothing of the tunnel Tars does not open.
 *     The design chosen for it: the Auth row in SSH mode, the tunnel named in
 *     the Status hint, the hint wrapped. Whether Tars should open the tunnel
 *     itself is not decided: recorded as `knownOpen`, not asserted.
 *
 * The last test lists every finding still open: red on the build before the
 * fixes, with the count in the commit that added this version of the spec.
 *
 * Every run leaves values.json and a screenshot per step in its output folder,
 * and in HERMES_BUGS_SHOTS when that names a folder.
 *
 *   E2E_PORT_OFFSET=80 npx playwright test e2e/hermes-bugs.spec.ts
 */

test.describe.configure({ mode: 'serial' });

const COMMAND = 'E2E_PORT_OFFSET=80 npx playwright test e2e/hermes-bugs.spec.ts';
const DIST = path.resolve('electron', 'dist');
const HELPER = path.resolve('e2e', 'win32-desktop.ps1');
const API_PORT = Number(apiPort(31468));
const SHOTS = process.env.HERMES_BUGS_SHOTS || '';

const COOKIE = 'e2e-session-cookie-bugs';
const USER = 'operator';
const PASSWORD = 'e2e-password';
const VERSION = '0.20.0-e2e';
/** The token gateway's session token, as Hermes Desktop's SSH connection holds one. */
const GATEWAY_TOKEN = 'e2e-gateway-token-ssh';
/** A port nothing listens on: the SSH tunnel Tars never opens. Never 9119, which a real Hermes may hold. */
const DEAD_PORT = 9;

// ─── Two fake gateways: one takes a password sign-in, one only a token ────────

interface GatewayLog { method: string; url: string; body?: unknown }

function startGateway(kind: 'password' | 'token') {
  const log: GatewayLog[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://gateway');
      let body: unknown;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      // The password is never recorded, only whether one came.
      const shown = body && typeof body === 'object' && 'password' in (body as object)
        ? { ...(body as object), password: (body as { password?: string }).password ? '(given)' : '(empty)' } : body;
      log.push({ method: req.method || 'GET', url: url.pathname, body: shown });
      const send = (status: number, payload: unknown, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === '/api/status') {
        send(200, kind === 'password'
          ? { version: VERSION, gateway_state: 'running', auth_required: true, auth_flows: ['password'], auth_providers: ['basic'] }
          : { version: VERSION, gateway_state: 'running', auth_required: true, auth_flows: ['token'], auth_providers: [] });
        return;
      }
      if (url.pathname === '/auth/password-login' && req.method === 'POST' && kind === 'password') {
        const b = body as { username?: string; password?: string };
        if (b?.username === USER && b?.password === PASSWORD) send(200, { ok: true }, { 'Set-Cookie': [`hermes_session_at=${COOKIE}; Path=/; HttpOnly`] });
        else send(401, { detail: 'Invalid username or password' });
        return;
      }
      const authorized = String(req.headers.cookie || '').includes(`hermes_session_at=${COOKIE}`)
        || (kind === 'token' && req.headers['x-hermes-session-token'] === GATEWAY_TOKEN);
      if (authorized && url.pathname === '/api/cron/jobs') { send(200, []); return; }
      send(authorized ? 404 : (url.pathname === '/auth/password-login' ? 404 : 401), { detail: authorized ? 'Not Found' : (url.pathname === '/auth/password-login' ? 'Not Found' : 'Unauthorized') });
    });
  });
  return new Promise<{ url: string; port: number; log: GatewayLog[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, port, log, close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

// ─── The app ─────────────────────────────────────────────────────────────────

let home: string;
let app: ElectronApplication;
let page: Page;
let gw: Awaited<ReturnType<typeof startGateway>>;
let tokenGw: Awaited<ReturnType<typeof startGateway>>;
const errors: string[] = [];
const journey: Record<string, unknown> = {};

/**
 * What the fixed page must do, recorded rather than asserted on the spot: the
 * steps are serial and share one app, and a failure there would stop the
 * measuring of the others. The last test asserts them all.
 */
const findings: { what: string; got: unknown; want: unknown }[] = [];
function check(what: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) findings.push({ what, got, want });
}

/**
 * Whether something answers on 127.0.0.1:9119, the port an imported SSH
 * connection resolves to. On a machine running Hermes Desktop that can be its
 * tunnel to a real gateway, which a sandbox must never probe: the SSH import
 * steps are skipped then, with the reason.
 */
function portAnswers(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}
let realGatewayPort = false;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  realGatewayPort = await portAnswers(9119);
  gw = await startGateway('password');
  tokenGw = await startGateway('token');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hermes-bugs-'));
  seedSandbox(home);
  fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tars-private', 'overseer.json'), JSON.stringify({ paused: true }));
  app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: String(API_PORT), DOROTHY_E2E: '1' },
  });
  page = await app.firstWindow();
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.waitForLoadState('domcontentloaded');
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  recordValues({ command: COMMAND, journey, pageErrors: errors });
  await app?.close();
  await gw?.close();
  await tokenGw?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

const row = (label: string) => page.locator('[data-settings-row]').filter({ has: page.locator('[data-settings-label]', { hasText: new RegExp(`^${label}$`) }) });
const statusHint = () => row('Status').locator('[data-settings-hint]');
const statusBadge = () => row('Status').locator('span').filter({ hasText: /^(checking|connected|signed out|unreachable|unknown)$/ }).first();
const connectionFile = () => path.join(home, '.dorothy', 'hermes-connection.json');
// Since 1.9.3 the token is saved apart from the connection, in ~/.tars-private,
// which no agent is handed (electron/services/hermes-config.ts).
const privateTokenFile = () => path.join(home, '.tars-private', 'hermes-token');
const readPrivateToken = () => (fs.existsSync(privateTokenFile()) ? fs.readFileSync(privateTokenFile(), 'utf-8').trim() : undefined);
const desktopDir = () => path.join(home, 'AppData', 'Roaming', 'Hermes');

async function shot(name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function openConnection() {
  await page.goto(`${DEV_URL}/settings?section=hermes`, { waitUntil: 'domcontentloaded' });
  await splashGone(page);
  await row('Gateway URL').locator('input').waitFor();
  await expect(row('Sign in').getByText('checking', { exact: true })).toHaveCount(0, { timeout: 15_000 });
}

type ModeLabel = 'Local' | 'SSH' | 'Remote' | 'Cloud';
async function pickMode(label: ModeLabel) {
  await page.getByRole('radiogroup', { name: 'Hermes connection mode' }).getByRole('radio', { name: label, exact: true }).click();
}
async function pickAuth(label: 'Token' | 'OAuth') {
  await page.getByRole('radiogroup', { name: 'Hermes auth mode' }).getByRole('radio', { name: label, exact: true }).click();
}

/** Every text field on the page: its row, its box, and whether it can be written. */
async function measureFields() {
  return page.evaluate(() => [...document.querySelectorAll('[data-settings-row]')].flatMap(r => {
    const label = r.querySelector('[data-settings-label]')?.textContent?.trim() ?? '';
    const column = r.querySelector('[data-settings-label]')?.parentElement?.nextElementSibling as HTMLElement | null;
    return [...r.querySelectorAll('input')].map((el, i) => {
      const b = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        row: label, index: i, key: `${label}#${i}`,
        placeholder: el.placeholder || null, title: el.title || null, type: el.type,
        value: el.type === 'password' ? (el.value ? '(set)' : '') : el.value,
        w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.left), right: Math.round(b.right),
        contentWidth: Math.round(b.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth)),
        readOnly: el.readOnly, disabled: el.disabled,
        cssWidth: s.width, flex: `${s.flexGrow} ${s.flexShrink} ${s.flexBasis}`, minWidth: s.minWidth,
        classes: el.className.split(/\s+/).filter(c => /^(w-|min-w|flex-|shrink)/.test(c)),
        columnRight: column ? Math.round(column.getBoundingClientRect().right) : null,
        overflowsColumn: column ? b.right > column.getBoundingClientRect().right + 0.5 : null,
        viewportWidth: window.innerWidth,
        overflowsViewport: b.right > window.innerWidth + 0.5,
      };
    });
  }));
}

/** Where `.w-24` and `.w-full` sit in the page's CSS: the later one wins on an element that has both. */
async function widthRuleOrder() {
  return page.evaluate(() => {
    const order: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const r of [...rules]) {
        if ('selectorText' in r && /^\.(w-24|w-full)$/.test((r as CSSStyleRule).selectorText)) order.push((r as CSSStyleRule).selectorText);
        if ('cssRules' in r && (r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of [...document.styleSheets]) { try { walk(sheet.cssRules); } catch { /* cross-origin */ } }
    return order;
  });
}

// ─── Clipboard, restored after as the hermes-connection spec does (text only) ──

async function withClipboard<T>(text: string, run: () => Promise<T>): Promise<T> {
  const saved = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
    return await run();
  } finally {
    await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), saved);
  }
}

// ─── Real OS input (win32), as in hermes-connection.spec.ts ──────────────────

function desktop(args: string[]): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER, ...args], { encoding: 'utf8' }).trim();
}

async function inMain<T>(src: string): Promise<T> {
  return app.evaluate((_e, { dist, src }) => {
    const w = process.mainModule!.require(`${dist}/core/window-manager.js`).getMainWindow();
    return new Function('w', src)(w);
  }, { dist: DIST, src }) as Promise<T>;
}

/** The window's handle and the physical screen point at the centre of `locator`, the window held on top. */
async function osPoint(locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('nothing to click');
  await inMain("w.show(); w.setAlwaysOnTop(true, 'screen-saver'); w.moveTop(); w.focus();");
  const hwnd = await inMain<string>('return w.getNativeWindowHandle().readBigInt64LE(0).toString();');
  const { x, y } = await app.evaluate(({ screen }, { dist, cx, cy }) => {
    const w = process.mainModule!.require(`${dist}/core/window-manager.js`).getMainWindow();
    const c = w.getContentBounds();
    const p = screen.dipToScreenPoint({ x: c.x + cx, y: c.y + cy });
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }, { dist: DIST, cx: box.x + box.width / 2, cy: box.y + box.height / 2 });
  return { hwnd, x, y };
}

async function osClickThenKeys(locator: ReturnType<Page['locator']>, combos: string[]) {
  const { hwnd, x, y } = await osPoint(locator);
  const out: string[] = [];
  try {
    await page.waitForTimeout(300);
    out.push(desktop(['-Mode', 'click', '-Hwnd', hwnd, '-X', String(x), '-Y', String(y)]));
    for (const combo of combos) {
      await page.waitForTimeout(200);
      out.push(desktop(['-Mode', 'keys', '-Hwnd', hwnd, '-Combo', combo]));
    }
    await page.waitForTimeout(400);
    return out;
  } finally {
    await inMain('w.setAlwaysOnTop(false);');
  }
}

/**
 * One field, three ways in: typing, Ctrl+V, and a right click. `sample` is
 * what a user would enter there (digits for a number field).
 */
async function editField(key: string, sample: string, viaOs = false) {
  const [label, index] = key.split('#');
  const field = row(label).locator('input').nth(Number(index));
  const read = () => field.inputValue();
  const clear = async () => { await field.click(); await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace'); };

  await clear();
  await page.keyboard.type(sample);
  const typed = await read();

  const pasteText = sample.replace(/\d$/, '7');
  const pwPaste = await withClipboard(pasteText, async () => { await clear(); await page.keyboard.press('Control+V'); return read(); });

  let osPaste: { value: string; sent: string[]; focused: boolean; mode: string | null } | { error: string } | null = null;
  // Real OS input only where it matters (the SSH host row, a typed URL): it
  // needs the window in the foreground, which a user working beside the run takes.
  if (viaOs && process.platform === 'win32') {
    osPaste = await withClipboard(pasteText, async () => {
      await clear();
      await page.locator('main h1').first().click();
      try {
        const sent = await osClickThenKeys(field, ['ctrl+a', 'ctrl+v']);
        return {
          value: await read(), sent,
          focused: await field.evaluate(el => el === document.activeElement),
          mode: await page.locator('[aria-label="Hermes connection mode"] [aria-checked="true"]').textContent(),
        };
      } catch (err) {
        // The helper refuses (exit 3) when another window took the foreground.
        return { error: String(err).slice(0, 200) };
      }
    });
  }

  // A right click: what the renderer asks for, whether anyone in the main
  // process answers, and the menu it would pop (recorded by recordPopups).
  const menu = await withClipboard(pasteText, async () => {
    await clear();
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { __ctx: unknown[]; __ctxListeners: number; __popups: unknown[] };
      g.__ctx = [];
      g.__popups = [];
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      g.__ctxListeners = wc.listenerCount('context-menu');
      wc.once('context-menu', (_e, p) => g.__ctx.push({ isEditable: p.isEditable, editFlags: p.editFlags, x: p.x, y: p.y }));
    });
    await field.click({ button: 'right' });
    await page.waitForTimeout(500);
    const seen = await app.evaluate(() => {
      const g = globalThis as unknown as { __ctx: unknown[]; __ctxListeners: number; __popups: { role?: string; enabled: boolean }[][] };
      return { appListenersBefore: g.__ctxListeners, events: g.__ctx, popups: g.__popups };
    });
    return { ...seen, valueAfter: await read() };
  });

  return { typed, pasteText, pwPaste, osPaste, menu };
}

// ─── (a) Import ──────────────────────────────────────────────────────────────

/** The v2 registry as Hermes Desktop writes it (keys measured on a Windows install), with an ssh primary. */
const REGISTRY = {
  version: 2, primary: 'conn-ssh', launchMode: 'primary', lastUsed: 'conn-ssh',
  connections: [
    { id: 'conn-local', kind: 'local', label: 'This machine' },
    { id: 'conn-ssh', kind: 'ssh', label: 'VPS', host: 'vps-current.example', user: 'operator', port: 2222, keyPath: 'C:\\Users\\sandbox\\.ssh\\id_current', remoteHermesPath: '/opt/hermes', token: { encoding: 'safeStorage', value: 'x' } },
  ],
};

async function importWith(v1: unknown | null, name: string, registry: unknown | null = REGISTRY) {
  // Local on a dead port, so the mount probe reaches nothing, and no token.
  fs.writeFileSync(connectionFile(), JSON.stringify({ mode: 'local', localPort: DEAD_PORT, authMode: 'token' }));
  fs.rmSync(privateTokenFile(), { force: true });
  fs.rmSync(desktopDir(), { recursive: true, force: true });
  fs.mkdirSync(desktopDir(), { recursive: true });
  if (registry) fs.writeFileSync(path.join(desktopDir(), 'connections.json'), JSON.stringify(registry));
  if (v1) fs.writeFileSync(path.join(desktopDir(), 'connection.json'), JSON.stringify(v1));
  await openConnection();
  const calls = gw.log.length;
  const importButton = row('Gateway URL').getByRole('button', { name: 'import' });
  // Offered only when Tars finds Hermes Desktop's files: connections.json alone must count.
  if (!(await importButton.isVisible())) return { offered: false as const };
  await importButton.click();
  await expect(statusHint()).toContainText('Imported from Hermes Desktop', { timeout: 10_000 });
  // The status settles once whatever the import started has answered.
  await expect(row('Status').getByRole('button', { name: /^(test|testing)$/ })).toHaveText('test', { timeout: 15_000 });
  const mode = await page.locator('[aria-label="Hermes connection mode"] [aria-checked="true"]').textContent();
  const fields = await measureFields();
  const saved = JSON.parse(fs.readFileSync(connectionFile(), 'utf-8'));
  const savedToken = readPrivateToken();
  await shot(name);
  return {
    offered: true as const,
    mode, hint: (await statusHint().textContent())?.trim(), badge: (await statusBadge().textContent())?.trim(),
    // Whether the Status hint is read whole: nothing cut on either axis, no ellipsis.
    hintBox: await statusHint().evaluate((el: HTMLElement) => ({
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
      textOverflow: getComputedStyle(el).textOverflow, whiteSpace: getComputedStyle(el).whiteSpace,
    })),
    gatewayCalls: gw.log.slice(calls).map(l => `${l.method} ${l.url}`),
    fields: fields.map(f => ({ key: f.key, placeholder: f.placeholder, value: f.value, w: f.w })), saved, savedToken,
  };
}

const SSH_IMPORT_SKIP = 'something answers on 127.0.0.1:9119 (a Hermes Desktop tunnel?), which an imported SSH connection would probe';

test('(a) import: v2 ssh primary beside a stale v1 remote URL', async () => {
  test.skip(realGatewayPort, SSH_IMPORT_SKIP);
  const r = await importWith({ mode: 'remote', remote: { url: 'http://old-gateway.invalid:9119', authMode: 'token', token: { encoding: 'plain', value: 'old-token' } } }, 'a1-import-stale-v1-remote');
  journey.importStaleRemote = r;
  if (!r.offered) { check('a1: the import is offered', false, true); return; }
  // What PR #262 would give: the registry's ssh primary.
  check('a1: the import follows the v2 primary (ssh)', r.mode, 'SSH');
  check('a1: the v2 host is imported', r.saved.ssh?.host, 'vps-current.example');
});

/** Hermes Desktop's v1 as a Windows install keeps it: mode ssh, the SSH fields under `remote`, no `ssh` key. */
const V1_SSH_UNDER_REMOTE = {
  mode: 'ssh',
  remote: { mode: 'ssh', host: 'vps-stale.example', user: 'root-stale', keyPath: 'C:\\old\\id_stale', remoteHermesPath: '/opt/hermes', token: { encoding: 'safeStorage', value: 'x' }, authMode: 'token' },
  profiles: {},
};

test('(a) import: v2 ssh primary beside a v1 that keeps its SSH fields under remote', async () => {
  test.skip(realGatewayPort, SSH_IMPORT_SKIP);
  const r = await importWith(V1_SSH_UNDER_REMOTE, 'a2-import-v1-real-shape');
  journey.importRealShape = r;
  if (!r.offered) { check('a2: the import is offered', false, true); return; }
  check('a2: the import lands in SSH', r.mode, 'SSH');
  check('a2: the v2 host is imported', r.saved.ssh?.host, 'vps-current.example');
  check('a2: the v2 user is imported', r.saved.ssh?.user, 'operator');
  // Nothing listens: the tunnel sentence, with its command, is read whole (the Status hint wraps).
  check('a2: the Status hint names the tunnel', /Tars does not open the SSH tunnel: start it first \(ssh .+\)\.$/.test(r.hint ?? ''), true);
  check('a2: the Status hint is not cut on its width', r.hintBox.scrollWidth <= r.hintBox.clientWidth, true);
  check('a2: the Status hint is not cut on its height', r.hintBox.scrollHeight <= r.hintBox.clientHeight, true);
  check('a2: the Status hint has no ellipsis', r.hintBox.textOverflow === 'ellipsis', false);
});

test('(a) import: that v1 alone, with no registry, still brings its SSH host', async () => {
  test.skip(realGatewayPort, SSH_IMPORT_SKIP);
  const r = await importWith(V1_SSH_UNDER_REMOTE, 'a3-import-v1-only', null);
  journey.importV1Only = r;
  if (!r.offered) { check('a3: the import is offered', false, true); return; }
  check('a3: the import lands in SSH', r.mode, 'SSH');
  check('a3: v1\'s host, from under `remote`', r.saved.ssh, { host: 'vps-stale.example', user: 'root-stale', keyPath: 'C:\\old\\id_stale', remotePort: 9119 });
});

test('(a) import: the status says what the gateway answered, not "connected" on faith', async () => {
  const r = await importWith(null, 'a4-import-then-probe', {
    version: 2, primary: 'box', launchMode: 'primary', lastUsed: 'box',
    connections: [{ id: 'box', kind: 'remote', label: 'Box', url: gw.url, authMode: 'token' }],
  });
  journey.importThenProbe = r;
  if (!r.offered) { check('a4: the import is offered when connections.json is the only file', false, true); return; }
  check('a4: the imported gateway is asked for its status', r.gatewayCalls.includes('GET /api/status'), true);
  check('a4: the status is the gateway\'s answer (sign-in required)', /sign-in required \(basic\)/.test(r.hint ?? ''), true);
  check('a4: the badge does not say connected for a gateway that wants a sign-in', r.badge === 'connected', false);
});

/** A registry whose primary is SSH, holding its token as `token`. */
const sshRegistry = (token: { encoding: string; value: string }) => ({
  ...REGISTRY,
  connections: REGISTRY.connections.map(c => (c.kind === 'ssh' ? { ...c, token } : c)),
});
const NOTICE = 'Token not imported: Hermes Desktop keeps it encrypted. Sign in or paste it.';

test('(a) import: an SSH primary\'s plain token comes with it, into the token field SSH mode now has', async () => {
  test.skip(realGatewayPort, SSH_IMPORT_SKIP);
  const r = await importWith(null, 'a5-import-ssh-plain-token', sshRegistry({ encoding: 'plain', value: 'tok-ssh-plain' }));
  const tokenField = await page.getByPlaceholder('X-Hermes-Session-Token').inputValue().catch(() => null);
  const notice = await page.getByText(NOTICE).isVisible();
  journey.importSshPlainToken = { ...r, tokenField: tokenField === 'tok-ssh-plain' ? '(the token)' : tokenField, notice };
  if (!r.offered) { check('a5: the import is offered', false, true); return; }
  check('a5: the SSH token is saved', r.savedToken === 'tok-ssh-plain', true);
  check('a5: and not with the connection', r.saved.token, undefined);
  check('a5: the token field holds it', tokenField === 'tok-ssh-plain', true);
  check('a5: no notice when the token came', notice, false);
});

test('(a) import: an SSH primary\'s encrypted token is left behind, and the notice says so in SSH mode', async () => {
  test.skip(realGatewayPort, SSH_IMPORT_SKIP);
  const r = await importWith(null, 'a6-import-ssh-encrypted-token', sshRegistry({ encoding: 'safeStorage', value: 'djEwY2lwaGVydGV4dA==' }));
  const notice = await page.getByText(NOTICE).isVisible();
  journey.importSshEncryptedToken = { ...r, notice };
  if (!r.offered) { check('a6: the import is offered', false, true); return; }
  check('a6: no token is saved', [r.saved.token, r.savedToken], [undefined, undefined]);
  check('a6: the notice shows in SSH mode', notice, true);
});

// ─── (b) Fields: size, read-only, and the three ways in ──────────────────────

const MODES: { name: string; mode: ModeLabel; auth?: 'Token' | 'OAuth' }[] = [
  { name: 'local', mode: 'Local' },
  { name: 'ssh', mode: 'SSH' },
  { name: 'remote-token', mode: 'Remote', auth: 'Token' },
  { name: 'remote-oauth', mode: 'Remote', auth: 'OAuth' },
  { name: 'cloud-token', mode: 'Cloud', auth: 'Token' },
  { name: 'cloud-oauth', mode: 'Cloud', auth: 'OAuth' },
];

/**
 * The menus the app pops, recorded instead of shown (showPopups puts them
 * back): editField's right click must not leave a native menu open over the
 * run. Electron pops it at the OS cursor, wherever the mouse rests, and one
 * left open there by the real Ctrl+V test held the point of the real right
 * click that follows, which the helper then refused (NOT-TARGET-AT-POINT).
 */
async function recordPopups() {
  await app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __popups: unknown[]; __realPopup?: typeof Menu.prototype.popup };
    g.__popups = [];
    g.__realPopup ??= Menu.prototype.popup;
    Menu.prototype.popup = function (this: Electron.Menu) {
      g.__popups.push(this.items.map(i => ({ role: i.role, enabled: i.enabled })));
    };
  });
}

async function showPopups() {
  await app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __realPopup?: typeof Menu.prototype.popup };
    if (g.__realPopup) Menu.prototype.popup = g.__realPopup;
  });
}

test('(b) every field, every mode: its size, and typing, Ctrl+V and a right click', async () => {
  test.setTimeout(600_000);
  fs.rmSync(connectionFile(), { force: true });
  fs.rmSync(desktopDir(), { recursive: true, force: true });
  await openConnection();
  const cssOrder = await widthRuleOrder();
  await recordPopups();
  const byMode: Record<string, unknown> = {};
  // Filled as the modes go, so a step that fails still leaves what was measured.
  journey.fields = { cssOrder, byMode };
  for (const m of MODES) {
    await pickMode(m.mode);
    if (m.auth) await pickAuth(m.auth);
    const fields = await measureFields();
    await shot(`b-${m.name}`);
    const edits: Record<string, unknown> = {};
    byMode[m.name] = { fields, edits };
    const modeNow = () => page.locator('[aria-label="Hermes connection mode"] [aria-checked="true"]').textContent();
    for (const f of fields) {
      if (f.readOnly || f.disabled) continue;
      const sample = f.type === 'number' ? '2222' : f.type === 'password' ? 'secret-typed1' : f.row === 'SSH host' && f.index === 0 ? 'vps.example.com' : 'typed-abc1';
      edits[f.key] = await editField(f.key, sample);
      // A step that moved the page to another mode is recorded, and the mode put back.
      const now = await modeNow();
      if (now !== m.mode) {
        (edits[f.key] as Record<string, unknown>).modeChangedTo = now;
        await pickMode(m.mode);
        if (m.auth) await pickAuth(m.auth);
      }
    }
    // Leave the form as found for the next mode.
    await openConnection();
  }
  await showPopups();

  const ssh = (byMode.ssh as { fields: Awaited<ReturnType<typeof measureFields>> }).fields;
  const host = ssh.find(f => f.key === 'SSH host#0')!;
  const user = ssh.find(f => f.key === 'SSH host#1')!;
  // The row's own intent (HermesSection: the user `w-24`, the host the rest): 96 + 8 + 196 = 300.
  check('b: the SSH user field is 96px wide', user.w, 96);
  check('b: the SSH host field takes the rest of the 300px column', host.w, 196);
  check('b: the SSH user field stays inside the 300px column', user.overflowsColumn, false);
  for (const [mode, data] of Object.entries(byMode)) {
    for (const [key, e] of Object.entries((data as { edits: Record<string, Awaited<ReturnType<typeof editField>>> }).edits)) {
      const popped = (e.menu.popups ?? [])[0] ?? [];
      check(`b: ${mode} ${key}: a right click pops Cut, Copy, Paste, Select All`, popped.map(i => i.role?.toLowerCase()), ['cut', 'copy', 'paste', 'selectall']);
      check(`b: ${mode} ${key}: Paste is enabled with text on the clipboard`, popped.find(i => i.role?.toLowerCase() === 'paste')?.enabled, true);
    }
  }
});

// ─── (c) Sign in ─────────────────────────────────────────────────────────────

async function setSshPorts(local: number) {
  const ports = row('Ports').locator('input');
  await ports.nth(2).fill(String(local));
}

async function signIn(name: string, setup: () => Promise<void>, gateway: Awaited<ReturnType<typeof startGateway>> | null) {
  fs.rmSync(connectionFile(), { force: true });
  await openConnection();
  await setup();
  const button = row('Sign in').getByRole('button', { name: /^(Sign in|Signing in)$/ });
  const disabledEmpty = await button.isDisabled();
  await page.getByPlaceholder('user', { exact: true }).fill(USER);
  await page.getByPlaceholder('password', { exact: true }).fill(PASSWORD);
  const disabledFilled = await button.isDisabled();
  const modeAtClick = await page.locator('[aria-label="Hermes connection mode"] [aria-checked="true"]').textContent();
  const before = gateway?.log.length ?? 0;
  const t0 = Date.now();
  await button.click();
  // Settled: the button is back to Sign in, or the row turned to sign out.
  await expect(row('Sign in').getByRole('button', { name: /^(Sign in|sign out)$/ })).toBeVisible({ timeout: 20_000 });
  const ms = Date.now() - t0;
  const calls = gateway ? gateway.log.slice(before).map(l => `${l.method} ${l.url}`) : [];
  const signOutShown = await row('Sign in').getByRole('button', { name: 'sign out', exact: true }).isVisible();
  const hintBox = await statusHint().evaluate((el: HTMLElement) => ({ text: el.textContent?.trim(), cut: el.scrollWidth > el.clientWidth }));
  const out = {
    modeAtClick, disabledEmpty, disabledFilled, ms, calls, signOutShown,
    badge: (await statusBadge().textContent())?.trim(), statusHint: hintBox,
    signInHint: (await row('Sign in').locator('[data-settings-hint]').textContent())?.trim(),
  };
  await shot(`c-${name}`);
  if (signOutShown) await row('Sign in').getByRole('button', { name: 'sign out', exact: true }).click();
  return out;
}

test('(c) sign in, in every mode the page offers', async () => {
  test.setTimeout(300_000);
  const r: Record<string, unknown> = {};
  // The case reported: SSH, the host left empty by the import, no tunnel (Tars opens none).
  r.sshNoTunnel = await signIn('ssh-no-tunnel', async () => { await pickMode('SSH'); await setSshPorts(DEAD_PORT); }, null);
  // SSH with a tunnel standing on the local port (emulated by pointing it at the fake).
  r.sshTunnel = await signIn('ssh-tunnel', async () => {
    await pickMode('SSH');
    await row('SSH host').locator('input').nth(0).fill('vps.example.com');
    await setSshPorts(gw.port);
  }, gw);
  // The same tunnel to a gateway that takes a token, not a password (Hermes Desktop's SSH token).
  r.sshTokenGateway = await signIn('ssh-token-gateway', async () => { await pickMode('SSH'); await setSshPorts(tokenGw.port); }, tokenGw);
  r.local = await signIn('local', async () => { await pickMode('Local'); await row('Gateway port').locator('input').fill(String(gw.port)); }, gw);
  for (const [mode, auth] of [['Remote', 'Token'], ['Remote', 'OAuth'], ['Cloud', 'Token'], ['Cloud', 'OAuth']] as const) {
    r[`${mode}-${auth}`.toLowerCase()] = await signIn(`${mode}-${auth}`.toLowerCase(), async () => {
      await pickMode(mode);
      await row('Gateway URL').locator('input').fill(gw.url);
      await pickAuth(auth);
    }, gw);
  }
  journey.signIn = r;
  // Open, and not decided here (whether Tars opens the tunnel, a token field in
  // SSH mode): recorded as measured, not asserted.
  journey.knownOpen = {
    sshNoTunnel: { what: 'SSH mode: Tars opens no tunnel, so a sign-in reaches nothing on the local port', measured: r.sshNoTunnel },
    sshTokenGateway: { what: 'SSH mode: no token field, and a token gateway answers a password sign-in with Not Found', measured: r.sshTokenGateway },
  };
});

/**
 * SSH mode, the design chosen for it: the Auth row Remote and Cloud
 * have, so a token gateway is reached through a tunnel; and when nothing
 * answers on the tunnel's local end, the Status hint says Tars does not open
 * it, with the command built from the form.
 */
test('(c) SSH: a token field, and the tunnel named when nothing answers', async () => {
  fs.rmSync(connectionFile(), { force: true });
  await openConnection();
  await pickMode('SSH');
  const tokenField = page.getByPlaceholder('X-Hermes-Session-Token');
  const tokenShown = await tokenField.isVisible();
  await row('SSH host').locator('input').nth(0).fill('vps.example.com');
  await row('SSH host').locator('input').nth(1).fill('operator');
  await row('Ports').locator('input').nth(0).fill('2222');
  await setSshPorts(DEAD_PORT);
  await row('Status').getByRole('button', { name: 'test', exact: true }).click();
  await expect(row('Status').getByRole('button', { name: 'test', exact: true })).toBeEnabled({ timeout: 20_000 });
  const noTunnel = {
    badge: (await statusBadge().textContent())?.trim(), hint: (await statusHint().textContent())?.trim(),
    cut: await statusHint().evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight),
  };
  await shot('c-ssh-no-tunnel-hint');

  // A tunnel on the local end (emulated: the port is the token gateway's), and its token.
  let viaToken: { badge?: string; hint?: string } | null = null;
  if (tokenShown) {
    await tokenField.fill(GATEWAY_TOKEN);
    await setSshPorts(tokenGw.port);
    await row('Status').getByRole('button', { name: 'test', exact: true }).click();
    await expect(row('Status').getByRole('button', { name: 'test', exact: true })).toBeEnabled({ timeout: 20_000 });
    viaToken = { badge: (await statusBadge().textContent())?.trim(), hint: (await statusHint().textContent())?.trim() };
    await shot('c-ssh-token-through-tunnel');
  }
  journey.sshOptionA = { tokenShown, noTunnel, viaToken };

  check('c: SSH mode shows the token field', tokenShown, true);
  check('c: nothing on the local end: the hint names the tunnel Tars does not open',
    noTunnel.hint, `Nothing answers on 127.0.0.1:${DEAD_PORT}. Tars does not open the SSH tunnel: start it first (ssh -p 2222 -L ${DEAD_PORT}:127.0.0.1:9119 operator@vps.example.com).`);
  check('c: a token gateway through the tunnel, with its token: connected', viaToken?.badge, 'connected');
});

/**
 * Last, because it brings the window to the foreground, where a user working
 * beside the run can click into it: real OS keystrokes (Ctrl+V through the
 * input queue, with no application menu on Windows) into the SSH host row.
 */
test('(b) the SSH host row takes a real Ctrl+V from the OS', async () => {
  test.skip(process.platform !== 'win32', 'the OS input helper is Windows only');
  fs.rmSync(connectionFile(), { force: true });
  await openConnection();
  await pickMode('SSH');
  const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null);
  await recordPopups();
  try {
    journey.osPaste = {
      applicationMenuIsNull: menu,
      host: await editField('SSH host#0', 'vps.example.com', true),
      user: await editField('SSH host#1', 'typed-abc1', true),
    };
  } finally {
    await showPopups();
  }
  await shot('b-ssh-after-os-paste');
});

/**
 * A real right click, through the OS input queue, on the empty SSH host field:
 * a menu must open (a new window of the app's main process: Electron draws
 * its menus on Windows with Chromium's views, class Chrome_WidgetWin_1), and
 * choosing Paste from it with the real keyboard (Down, which skips the three
 * disabled items of an empty field, then Enter) must put the clipboard there.
 */
test('(b) a real right click on the SSH host field opens a menu whose Paste lands there', async () => {
  test.skip(process.platform !== 'win32', 'the OS input helper is Windows only');
  fs.rmSync(connectionFile(), { force: true });
  await openConnection();
  await pickMode('SSH');
  const field = row('SSH host').locator('input').nth(0);
  // The main process's own pid, which owns the windows (not the launcher's).
  const pid = String(await app.evaluate(() => process.pid));
  const TEXT = 'vps.pasted.example';
  const windows = () => desktop(['-Mode', 'list', '-ProcId', pid]).split(/\r?\n/).filter(Boolean);
  // What the main process saw, for the record: the event, and the menu it popped (still shown).
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const g = globalThis as unknown as { __rc: { events: number; popped: number }; __osPopup?: typeof Menu.prototype.popup };
    g.__rc = { events: 0, popped: 0 };
    BrowserWindow.getAllWindows()[0].webContents.on('context-menu', () => { g.__rc.events++; });
    const real = Menu.prototype.popup;
    g.__osPopup = real;
    Menu.prototype.popup = function (this: Electron.Menu, ...args: Parameters<typeof real>) { g.__rc.popped++; return real.apply(this, args); };
  });
  const seen = () => app.evaluate(() => (globalThis as unknown as { __rc: { events: number; popped: number } }).__rc);
  const result = await withClipboard(TEXT, async () => {
    await field.fill('');
    const { hwnd, x, y } = await osPoint(field);
    try {
      await page.waitForTimeout(300);
      const before = new Set(windows().map(l => l.split('|')[0]));
      // The helper refuses (exit 3) while another window holds the point or the
      // foreground, which a user working beside the run causes: tried three times.
      let clicked = '';
      for (let attempt = 1; !clicked; attempt++) {
        try {
          clicked = desktop(['-Mode', 'rclick', '-Hwnd', hwnd, '-X', String(x), '-Y', String(y)]);
        } catch (err) {
          if (attempt === 3) throw err;
          await osPoint(field);
          await page.waitForTimeout(1000);
        }
      }
      // The menu's window, once it is shown: asked for up to 3 s.
      let open: string[] = [];
      for (let i = 0; i < 10 && open.length === 0; i++) {
        await page.waitForTimeout(300);
        open = windows().filter(l => !before.has(l.split('|')[0]));
      }
      if (open.length === 0) return { clicked, menus: 0, main: await seen(), value: await field.inputValue() };
      const [menuHwnd, menuClass, , L, T, W, H] = open[0].split('|');
      const rect = { x: Number(L), y: Number(T), w: Number(W), h: Number(H) };
      // The window and the menu, as the screen shows them.
      if (SHOTS) desktop(['-Mode', 'capture', '-X', String(rect.x - 320), '-Y', String(rect.y - 80), '-W', String(rect.w + 640), '-H', String(rect.h + 160), '-Out', path.join(SHOTS, 'b-ssh-native-menu.png')]);
      // The first item the keyboard can reach: with nothing selected and text
      // on the clipboard, Paste is the only one enabled.
      // In one call, the two keys 150 ms apart: the menu closes as soon as
      // another window takes the foreground, and the helper checks it before each.
      const picked = [desktop(['-Mode', 'menukeys', '-ProcId', pid, '-Hwnd', menuHwnd, '-Combo', 'down+enter'])];
      await expect.poll(() => field.inputValue(), { timeout: 5000 }).toBe(TEXT).catch(() => {});
      return { clicked, menus: open.length, menuClass, main: await seen(), rect, picked, value: await field.inputValue() };
    } finally {
      await inMain('w.setAlwaysOnTop(false);');
    }
  });
  await shot('b-ssh-after-right-click-paste');
  journey.osRightClick = result;
  await app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __osPopup?: typeof Menu.prototype.popup };
    if (g.__osPopup) Menu.prototype.popup = g.__osPopup;
  });
  check('b: a real right click on an editable field opens a menu', result.menus > 0, true);
  check('b: its Paste puts the clipboard in the SSH host field', result.value, TEXT);
});

/**
 * The helper's own guards, each made to trip: a click or a right click at a
 * point the target window does not hold (another window, or none, is there),
 * a key name menukeys does not know, and a key while another process holds the
 * foreground. Each is refused before any input is sent.
 */
test('(helper) win32-desktop.ps1 refuses to act where its target is not', async () => {
  test.skip(process.platform !== 'win32', 'the OS input helper is Windows only');
  const pid = String(await app.evaluate(() => process.pid));
  const hwnd = await inMain<string>('return w.getNativeWindowHandle().readBigInt64LE(0).toString();');
  const refused = (args: string[]) => {
    try { return { code: 0, out: desktop(args) }; } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { code: e.status ?? -1, out: String(e.stdout ?? '').trim() };
    }
  };
  // 40 px right of the window's right edge, on the screen's own pixels.
  const outside = await app.evaluate(({ screen }, { dist }) => {
    const w = process.mainModule!.require(`${dist}/core/window-manager.js`).getMainWindow();
    const b = w.getBounds();
    const p = screen.dipToScreenPoint({ x: b.x + b.width + 40, y: b.y + Math.round(b.height / 2) });
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }, { dist: DIST });
  const guards = {
    clickOutside: refused(['-Mode', 'click', '-Hwnd', hwnd, '-X', String(outside.x), '-Y', String(outside.y)]),
    rclickOutside: refused(['-Mode', 'rclick', '-Hwnd', hwnd, '-X', String(outside.x), '-Y', String(outside.y)]),
    unknownKey: refused(['-Mode', 'menukeys', '-ProcId', pid, '-Hwnd', hwnd, '-Combo', 'down+f13']),
    otherForeground: null as null | { code: number; out: string },
  };
  await inMain('w.setAlwaysOnTop(false); w.minimize(); w.blur();');
  try {
    // Windows hands the foreground on when it likes: asked again until another
    // process holds it. Until then the Esc goes to the app itself, which is harmless.
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(500);
      guards.otherForeground = refused(['-Mode', 'menukeys', '-ProcId', pid, '-Hwnd', hwnd, '-Combo', 'esc']);
      if (guards.otherForeground.code !== 0) break;
    }
  } finally {
    await inMain('w.restore(); w.show(); w.focus();');
  }
  journey.helperGuards = guards;
  check('helper: a click outside the target is refused', guards.clickOutside, { code: 3, out: 'NOT-TARGET-AT-POINT' });
  check('helper: a right click outside the target is refused', guards.rclickOutside, { code: 3, out: 'NOT-TARGET-AT-POINT' });
  check('helper: an unknown key name is refused', guards.unknownKey, { code: 2, out: 'UNKNOWN-KEY f13' });
  check('helper: a key while another process holds the foreground is refused', guards.otherForeground, { code: 3, out: 'NOT-FOREGROUND-PROCESS' });
});

test('no page error on the way', async () => {
  expect(errors).toEqual([]);
});

test('the three reports are fixed', async () => {
  journey.findings = findings;
  expect(findings).toEqual([]);
});
