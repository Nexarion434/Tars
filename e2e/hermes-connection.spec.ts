import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';
import { assertWindowOnScreen, launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, seedSandbox, splashGone, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';

/**
 * The Hermes journey, end to end, against a gateway that answers from here.
 *
 * Reported by Nicolas on the Windows build 1.9.0-win.2: "the Gateway URL field
 * cannot be edited". Measured with this spec: in Local mode (and SSH) the field
 * is read-only on purpose, it shows the address the port below resolves to
 * (HermesSection.tsx, `readOnly={!typedUrl}`), and Local is where a fresh
 * install lands, on every platform, when ~/.dorothy/hermes-connection.json
 * does not exist. No drag region, overlay or disabled state is involved: the
 * field's own computed app-region is `none`, it is the element at its centre,
 * and in Remote mode it takes typing from Playwright and from a real OS click
 * and keystroke alike (win32).
 *
 * So the field now says it: read-only reads as read-only (frame XFApe, rows
 * kjeqD and B85KKr, validated by Nicolas). The panel's `surface` fill instead
 * of a field's `surface-raised`, the value in `text-secondary`,
 * the default cursor, the text still selectable; and the hint says the whole
 * sentence, "Derived from the port below. Switch to Remote to type a URL.",
 * never cut. The Local step asserts the look and the hint, the Remote step
 * that an editable field differs, and the webhook step the webhook field's
 * look. All three fail on the build before this change.
 *
 * Focused, a read-only field shows the accent focus border an editable field
 * has, from a click and from Tab alike (decision A1). A keyboard-only border
 * (frame RKPfa, option A) cannot be told apart in CSS: Electron 44's Chromium
 * matches :focus-visible on a mouse click into any text field, readonly
 * included, which fieldLook records as focusVisible. The Local and webhook
 * steps check both ways in.
 *
 * What does differ on Windows is the way out that macOS has: the `import`
 * button, which copies Hermes Desktop's connection (a URL, in Remote mode) and
 * is offered only when that app's connection.json is found. Until 9caf31d8
 * Tars looked for it under ~/Library/Application Support/Hermes on every
 * platform; Hermes Desktop on Windows keeps it under %APPDATA%\Hermes (it is
 * there on Nicolas's machine). The import test pins the way out: offered,
 * taken, and the field editable afterwards. It fails on the build before
 * 9caf31d8, where Windows never shows the button.
 *
 * The rest walks what the connection page offers and what depends on it: the
 * URL and the token saved and read back after a reload, a sign-in, the test
 * with its success and its failures, the webhook secret against the real API,
 * the Tailscale line, the Chat's Hermes room sending and receiving, the Brain
 * page's Hermes backend, and the Schedules the page links to. The gateway is a
 * node:http server in this process: /api/status is public and every other
 * route wants the token or the session cookie, as a Hermes gateway does.
 *
 * Every run leaves values.json and a screenshot per step in its output folder.
 *
 *   E2E_PORT_OFFSET=80 npx playwright test e2e/hermes-connection.spec.ts
 */

test.describe.configure({ mode: 'serial' });

const COMMAND = 'E2E_PORT_OFFSET=80 npx playwright test e2e/hermes-connection.spec.ts';
const DIST = path.resolve('electron', 'dist');
const HELPER = path.resolve('e2e', 'win32-desktop.ps1');
const API_PORT = Number(apiPort(31466));

const TOKEN = 'e2e-session-token-7f3a';
const COOKIE = 'e2e-session-cookie-51c9';
const USER = 'noah';
const PASSWORD = 'e2e-password';
const VERSION = '0.20.0-e2e';
const REPLY = 'The fleet is quiet: four agents running, nothing waiting on you.';

// ─── The fake gateway ────────────────────────────────────────────────────────

interface GatewayLog { method: string; url: string; authorized: boolean; body?: unknown }

function startFakeGateway() {
  const log: GatewayLog[] = [];
  const jobs: Record<string, { id: string; name: string; schedule: string; prompt: string; enabled: boolean; profile: string }> = {
    'nightly-e2e': { id: 'nightly-e2e', name: 'nightly e2e digest', schedule: '0 3 * * *', prompt: 'Digest the night.', enabled: true, profile: 'default' },
  };
  let memoryActive = 'holographic';

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://gateway');
      const cookie = String(req.headers.cookie || '');
      const authorized = req.headers['x-hermes-session-token'] === TOKEN || cookie.includes(`hermes_session_at=${COOKIE}`);
      let body: unknown;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      log.push({ method: req.method || 'GET', url: url.pathname + url.search, authorized, body });
      const send = (status: number, payload: unknown, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname === '/api/status') {
        send(200, { version: VERSION, gateway_state: 'running', auth_required: true, auth_flows: ['password'], auth_providers: ['basic'] });
        return;
      }
      if (url.pathname === '/auth/password-login' && req.method === 'POST') {
        const b = body as { username?: string; password?: string };
        if (b?.username === USER && b?.password === PASSWORD) {
          send(200, { ok: true }, { 'Set-Cookie': [`hermes_session_at=${COOKIE}; Path=/; HttpOnly`] });
        } else {
          send(401, { detail: 'Invalid username or password' });
        }
        return;
      }
      if (!authorized) { send(401, { detail: 'Unauthorized' }); return; }

      // The live session needs a websocket: refused, so a turn takes the cron path.
      if (url.pathname === '/api/auth/ws-ticket') { send(404, { detail: 'Not Found' }); return; }

      if (url.pathname === '/api/cron/jobs' && req.method === 'GET') { send(200, Object.values(jobs)); return; }
      if (url.pathname === '/api/cron/jobs' && req.method === 'POST') {
        const b = body as { name: string; schedule: string; prompt: string };
        const id = 'overseer-e2e';
        jobs[id] = { id, name: b.name, schedule: b.schedule, prompt: b.prompt, enabled: true, profile: 'default' };
        send(200, { id });
        return;
      }
      const job = /^\/api\/cron\/jobs\/([^/]+)(\/(trigger|runs))?$/.exec(url.pathname);
      if (job) {
        const [, id, , sub] = job;
        if (!jobs[id]) { send(404, { detail: 'job not found' }); return; }
        if (!sub && req.method === 'PUT') {
          const updates = (body as { updates?: { prompt?: string } })?.updates ?? {};
          if (updates.prompt) jobs[id].prompt = updates.prompt;
          send(200, jobs[id]);
          return;
        }
        if (sub === 'trigger') { send(200, { ok: true }); return; }
        if (sub === 'runs') {
          const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
          send(200, [{ id: `cron_${id}_${stamp}` }]);
          return;
        }
      }
      if (/^\/api\/sessions\/cron_[^/]+\/messages$/.test(url.pathname)) {
        send(200, [{ role: 'assistant', content: JSON.stringify({ say: REPLY, action: null }) }]);
        return;
      }
      if (url.pathname === '/api/memory' && req.method === 'GET') {
        send(200, {
          active: memoryActive,
          providers: [
            { name: 'holographic', description: 'The gateway\'s own long-term store.', available: true, configured: true, status: 'ok' },
            { name: 'mem0', description: 'A hosted memory service.', available: true, configured: true, status: 'ok' },
          ],
          builtin_files: { 'MEMORY.md': 120 },
        });
        return;
      }
      if (url.pathname === '/api/memory/provider' && req.method === 'PUT') {
        memoryActive = (body as { provider: string }).provider;
        send(200, { ok: true });
        return;
      }
      if (url.pathname === '/api/files/read') {
        const text = '# Memory\nNoah reviews every PR before it merges.\n';
        send(200, { data_url: `data:text/markdown;base64,${Buffer.from(text).toString('base64')}` });
        return;
      }
      if (url.pathname === '/api/mcp/servers') {
        send(200, { servers: [{ name: 'gbrain-e2e', url: 'http://100.64.0.9:8765/mcp', transport: 'http', enabled: true }] });
        return;
      }
      send(404, { detail: 'Not Found' });
    });
  });

  return new Promise<{ url: string; log: GatewayLog[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        log,
        close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

// ─── The app ─────────────────────────────────────────────────────────────────

let home: string;
let app: ElectronApplication;
let page: Page;
let gateway: Awaited<ReturnType<typeof startFakeGateway>>;
const errors: string[] = [];
const journey: Record<string, unknown> = {};

test.beforeAll(async () => {
  test.setTimeout(180_000);
  gateway = await startFakeGateway();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hermes-conn-'));
  seedSandbox(home);
  // No check-in of Hermes's own during the run: the watch would take the
  // gateway's one cron job between the steps that read it.
  fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tars-private', 'overseer.json'), JSON.stringify({ paused: true }));
  app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: String(API_PORT), DOROTHY_E2E: '1' },
  });
  page = await app.firstWindow();
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  // No setViewportSize: an emulated viewport no longer maps the page's pixels
  // onto the window's, and the Windows step clicks the real screen.
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  recordValues({ command: COMMAND, journey, gatewayCalls: gateway?.log.map(l => `${l.method} ${l.url}${l.authorized ? '' : ' (anonymous)'}`) });
  await app?.close();
  await gateway?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

const row = (label: string) => page.locator('[data-settings-row]').filter({ has: page.locator('[data-settings-label]', { hasText: new RegExp(`^${label}$`) }) });
const gatewayField = () => row('Gateway URL').locator('input');
const tokenField = () => page.getByPlaceholder('X-Hermes-Session-Token');
const statusHint = () => row('Status').locator('[data-settings-hint]');
const statusBadge = () => row('Status').locator('span').filter({ hasText: /^(checking|connected|unreachable|unknown)$/ }).first();
const connectionFile = () => path.join(home, '.dorothy', 'hermes-connection.json');
const readConnectionFile = () => JSON.parse(fs.readFileSync(connectionFile(), 'utf-8'));

async function openConnection() {
  await page.goto(`${DEV_URL}/settings?section=hermes`, { waitUntil: 'domcontentloaded' });
  await splashGone(page);
  await gatewayField().waitFor();
  // The mount probe settles the Sign in row; the Status row is last to move.
  await expect(row('Sign in').getByText('checking', { exact: true })).toHaveCount(0, { timeout: 15_000 });
}

async function pickMode(label: 'Local' | 'SSH' | 'Remote' | 'Cloud') {
  await page.getByRole('radiogroup', { name: 'Hermes connection mode' }).getByRole('radio', { name: label, exact: true }).click();
}

async function pickAuth(label: 'Token' | 'OAuth') {
  await page.getByRole('radiogroup', { name: 'Hermes auth mode' }).getByRole('radio', { name: label, exact: true }).click();
}

async function testConnection() {
  await row('Status').getByRole('button', { name: 'test', exact: true }).click();
  await expect(row('Status').getByRole('button', { name: 'test', exact: true })).toBeEnabled({ timeout: 20_000 });
  return { badge: (await statusBadge().textContent())?.trim(), hint: (await statusHint().textContent())?.trim() };
}

/** What stands at a field's centre, and what would stop a click there. */
async function fieldReport(field: ReturnType<typeof gatewayField>) {
  return field.evaluate((el: HTMLInputElement) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    let region = 'none';
    for (let n: Element | null = el; n; n = n.parentElement) {
      const v = getComputedStyle(n).getPropertyValue('-webkit-app-region');
      if (v === 'drag' || v === 'no-drag') { region = v; break; }
    }
    return {
      value: el.value, readOnly: el.readOnly, disabled: el.disabled,
      appRegion: getComputedStyle(el).getPropertyValue('-webkit-app-region'), nearestRegion: region,
      hitIsField: hit === el, pointerEvents: getComputedStyle(el).pointerEvents,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      mode: document.querySelector('[aria-label="Hermes connection mode"] [aria-checked="true"]')?.textContent ?? null,
    };
  });
}

/**
 * How a field reads, and the tokens it should read as. A read-only field
 * (frame XFApe, rows kjeqD and B85KKr) has the panel's `surface` fill, prints
 * its value in `text-secondary` and shows the default cursor, where an editable
 * one has `surface-raised`; both turn their border to the accent on focus. Colours are compared as the browser
 * resolves them, so a token's value can change without touching this spec.
 */
async function fieldLook(field: ReturnType<typeof gatewayField>) {
  return field.evaluate(async (el: HTMLInputElement) => {
    // Fields fade their colours (transition-colors): read them once settled,
    // not halfway from one mode's look to the other's.
    await Promise.all(el.getAnimations().map(a => a.finished.catch(() => {})));
    const token = (name: string) => {
      const probe = document.createElement('div');
      probe.style.color = `var(${name})`;
      el.parentElement!.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    };
    const s = getComputedStyle(el);
    return {
      background: s.backgroundColor, color: s.color, border: s.borderTopColor,
      outline: s.outlineStyle, boxShadow: s.boxShadow, cursor: s.cursor, userSelect: s.userSelect,
      focused: el === document.activeElement,
      focusVisible: el.matches(':focus-visible'),
      tokens: { surface: token('--card'), surfaceRaised: token('--secondary'), border: token('--border'), textSecondary: token('--text-secondary') },
    };
  });
}

/** Whether a hint is shown whole: nothing cut on either axis, no ellipsis. */
async function hintReport(hint: ReturnType<Page['locator']>) {
  return hint.evaluate((el: HTMLElement) => ({
    text: el.textContent?.trim(),
    scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
    textOverflow: getComputedStyle(el).textOverflow, whiteSpace: getComputedStyle(el).whiteSpace,
  }));
}

let localLook: Awaited<ReturnType<typeof fieldLook>> | null = null;
/** A focused editable field's border: the accent focus border (`$accent-focus`). */
let accentFocusBorder: string | null = null;

/**
 * A read-only field focused from the keyboard (Shift+Tab from the control after
 * it), then, after focus has left it, from a click.
 */
async function keyboardThenPointer(field: ReturnType<typeof gatewayField>, after: ReturnType<Page['locator']>) {
  await after.focus();
  await page.keyboard.press('Shift+Tab');
  const keyboard = await fieldLook(field);
  await page.locator('main h1').first().click();
  await field.click();
  const pointer = await fieldLook(field);
  return { keyboard, pointer };
}

// ─── Windows: real OS input, which is what a drag region would swallow ──────

function desktop(args: string[]): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER, ...args], { encoding: 'utf8' }).trim();
}

async function inMain<T>(src: string): Promise<T> {
  return app.evaluate((_e, { dist, src }) => {
    const w = process.mainModule!.require(`${dist}/core/window-manager.js`).getMainWindow();
    return new Function('w', src)(w);
  }, { dist: DIST, src }) as Promise<T>;
}

/**
 * A real click at the centre of `locator`, then one real key. The window is
 * held on top for the two, since the helper refuses to act (exit 3) when
 * anything else took the foreground in between, which a user working beside
 * the run does.
 */
async function osClickAndKey(locator: ReturnType<Page['locator']>, key: string) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('nothing to click');
  await inMain("w.show(); w.setAlwaysOnTop(true, 'screen-saver'); w.moveTop(); w.focus();");
  await assertWindowOnScreen(app);
  const hwnd = await inMain<string>('return w.getNativeWindowHandle().readBigInt64LE(0).toString();');
  // The page's CSS pixels are the content's DIPs (no viewport emulation in this
  // spec); the helper is DPI aware and clicks in physical pixels.
  const { x, y } = await app.evaluate(({ BrowserWindow, screen }, { dist, cx, cy }) => {
    const w = process.mainModule!.require(`${dist}/core/window-manager.js`).getMainWindow() as InstanceType<typeof BrowserWindow>;
    const c = w.getContentBounds();
    const p = screen.dipToScreenPoint({ x: c.x + cx, y: c.y + cy });
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }, { dist: DIST, cx: box.x + box.width / 2, cy: box.y + box.height / 2 });
  try {
    await page.waitForTimeout(300);
    const clicked = desktop(['-Mode', 'click', '-Hwnd', hwnd, '-X', String(x), '-Y', String(y)]);
    await page.waitForTimeout(300);
    const typed = desktop(['-Mode', 'keys', '-Hwnd', hwnd, '-Combo', key]);
    await page.waitForTimeout(300);
    return { clicked, typed };
  } finally {
    await inMain('w.setAlwaysOnTop(false);');
  }
}

// ─── The journey ─────────────────────────────────────────────────────────────

test('Gateway URL: read-only in Local, where a fresh install lands; nothing covers it', async () => {
  await openConnection();
  const local = await fieldReport(gatewayField());
  const idle = await fieldLook(gatewayField());
  // What a user does: click in, select all, type. Local keeps its derived address.
  await gatewayField().click();
  const focused = await fieldLook(gatewayField());
  await page.keyboard.press('Control+A');
  // Read-only, not dead: the address can still be selected, so copied.
  const selection = await gatewayField().evaluate((el: HTMLInputElement) => ({ start: el.selectionStart, end: el.selectionEnd, length: el.value.length }));
  await page.keyboard.type('http://100.64.0.7:9119');
  const afterTyping = await gatewayField().inputValue();
  const hint = await hintReport(row('Gateway URL').locator('[data-settings-hint]'));
  await stepShot(page, '01-local-read-only');
  localLook = idle;
  journey.localMode = { ...local, afterTyping, hint, look: { idle, focused }, selection };

  expect(local.mode).toBe('Local');
  expect(local.readOnly).toBe(true);
  expect(local.disabled).toBe(false);
  expect(local.hitIsField).toBe(true);
  expect(local.nearestRegion).not.toBe('drag');
  expect(afterTyping).toBe('http://127.0.0.1:9');
  // The read-only look (frame XFApe, row kjeqD): the panel's fill, not a field's.
  expect(idle.background, 'a read-only field has the surface fill').toBe(idle.tokens.surface);
  expect(idle.background).not.toBe(idle.tokens.surfaceRaised);
  expect(idle.color, 'its value is secondary text').toBe(idle.tokens.textSecondary);
  expect(idle.border).toBe(idle.tokens.border);
  expect(idle.cursor).toBe('default');
  expect(idle.userSelect).not.toBe('none');
  // Focused by a click, only the border moves: no outline, no shadow, same fill.
  expect(focused.focused).toBe(true);
  expect({ outline: focused.outline, boxShadow: focused.boxShadow, background: focused.background })
    .toEqual({ outline: idle.outline, boxShadow: idle.boxShadow, background: idle.background });
  expect(selection).toEqual({ start: 0, end: selection.length, length: 'http://127.0.0.1:9'.length });
  // The whole hint, never cut: it may wrap, it has no ellipsis, and it fits its box.
  expect(hint.text).toBe('Derived from the port below. Switch to Remote to type a URL.');
  expect(hint.whiteSpace, 'the hint may wrap').not.toBe('nowrap');
  expect(hint.textOverflow, 'the hint is never ellipsed').not.toBe('ellipsis');
  expect(hint.scrollWidth, 'the hint is not cut on its width').toBeLessThanOrEqual(hint.clientWidth);
  expect(hint.scrollHeight, 'the hint is not cut on its height').toBeLessThanOrEqual(hint.clientHeight);

  // The accent focus border, as an editable field shows it: the port field below.
  const portField = row('Gateway port').locator('input');
  await portField.click();
  const editableFocused = await fieldLook(portField);
  accentFocusBorder = editableFocused.border;
  const focus = await keyboardThenPointer(gatewayField(), portField);
  journey.localMode = { ...journey.localMode as object, focus: { editable: editableFocused.border, ...focus } };

  expect(editableFocused.border, 'a focused editable field turns its border').not.toBe(editableFocused.tokens.border);
  expect(focused.border, 'a click shows the accent focus border').toBe(accentFocusBorder);
  expect(focus.keyboard.focused, 'Shift+Tab lands on the Gateway URL field').toBe(true);
  expect(focus.keyboard.border, 'Tab shows the accent focus border').toBe(accentFocusBorder);
  expect(focus.keyboard.background, 'and the field stays read-only in look').toBe(idle.background);
  expect(focus.pointer.focused).toBe(true);
  expect(focus.pointer.border, 'a click after Tab shows it too').toBe(accentFocusBorder);
});

test('Gateway URL: Remote takes typing, from Playwright and from real OS input, and reads it back', async () => {
  await openConnection();
  await pickMode('Remote');
  const remote = await fieldReport(gatewayField());
  const remoteIdle = await fieldLook(gatewayField());
  await gatewayField().click();
  const remoteFocused = await fieldLook(gatewayField());
  await page.keyboard.press('Control+A');
  await page.keyboard.type('http://100.64.0.7:9119');
  const typed = await gatewayField().inputValue();

  let os: Record<string, unknown> | null = null;
  if (process.platform === 'win32') {
    // Focus elsewhere first, so the field holding focus afterwards is the
    // real click's doing, then one real key typed through the OS queue.
    await page.locator('main h1').first().click();
    await page.evaluate(() => {
      const g = globalThis as unknown as { __keys: string[] };
      g.__keys = [];
      for (const t of ['keydown', 'keypress', 'input', 'mousedown', 'focusin', 'blur']) {
        window.addEventListener(t, e => g.__keys.push(`${t}:${(e as KeyboardEvent).key ?? ''}:${(e.target as HTMLElement)?.tagName}:${document.hasFocus()}`), true);
      }
    });
    const sent = await osClickAndKey(gatewayField(), 'x');
    // The key goes through the OS queue: waited for, not read at once.
    await expect.poll(() => gatewayField().inputValue(), { timeout: 5000 }).toMatch(/x/).catch(() => {});
    os = {
      events: await page.evaluate(() => (globalThis as unknown as { __keys: string[] }).__keys),
      ...sent,
      focused: await gatewayField().evaluate(el => el === document.activeElement),
      value: await gatewayField().inputValue(),
    };
  }
  await stepShot(page, '02-remote-typed');
  journey.remoteMode = { ...remote, typed, os, look: { idle: remoteIdle, focused: remoteFocused } };

  expect(remote.mode).toBe('Remote');
  expect(remote.readOnly).toBe(false);
  expect(typed).toBe('http://100.64.0.7:9119');
  // The editable field is visibly another thing than the read-only one.
  expect(remoteIdle.background, 'an editable field has the surface-raised fill').toBe(remoteIdle.tokens.surfaceRaised);
  expect(localLook, 'the Local step ran first').not.toBeNull();
  expect(remoteIdle.background, 'Remote and Local fields differ').not.toBe(localLook!.background);
  expect(remoteIdle.cursor).not.toBe('default');
  // And it does take a focus ring, so the Local assertion is not vacuous.
  expect(remoteFocused.focused).toBe(true);
  expect(remoteFocused.border).not.toBe(remoteIdle.border);
  expect(remoteFocused.border, 'one accent focus border for every editable field').toBe(accentFocusBorder);
  if (os) {
    expect(os.focused, 'a real click lands in the field').toBe(true);
    expect(String(os.value)).toMatch(/x/);
    expect(String(os.value).replace('x', '')).toBe('http://100.64.0.7:9119');
  }
});

test('sign in: a cookie gateway asks for it, takes it, and forgets it on sign out', async () => {
  await gatewayField().fill(gateway.url);
  await pickAuth('OAuth');
  await row('Status').getByRole('button', { name: 'save', exact: true }).click();
  await expect(row('Status').getByRole('button', { name: 'save', exact: true })).toBeDisabled();
  const before = await testConnection();
  const formShown = await page.getByPlaceholder('password').isVisible();

  await page.getByPlaceholder('user', { exact: true }).fill(USER);
  await page.getByPlaceholder('password').fill('wrong');
  await row('Sign in').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(statusHint()).toContainText('Invalid username or password', { timeout: 15_000 });
  const refused = (await statusHint().textContent())?.trim();

  await page.getByPlaceholder('password').fill(PASSWORD);
  await row('Sign in').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(row('Sign in').getByRole('button', { name: 'sign out', exact: true })).toBeVisible({ timeout: 15_000 });
  const signedIn = (await statusHint().textContent())?.trim();
  const jar = JSON.parse(fs.readFileSync(path.join(home, '.dorothy', 'hermes-session.json'), 'utf-8'));
  const after = await testConnection();
  await stepShot(page, '03-signed-in');

  await row('Sign in').getByRole('button', { name: 'sign out', exact: true }).click();
  await expect(page.getByPlaceholder('password')).toBeVisible();
  const afterSignOut = await testConnection();
  journey.signIn = { before, formShown, refused, signedIn, jarKeys: Object.keys(jar), after, afterSignOut };

  expect(before.hint).toContain('sign-in required (basic)');
  expect(formShown).toBe(true);
  expect(refused).toContain('Invalid username or password');
  expect(signedIn).toBe(`Signed in - Hermes ${VERSION} running`);
  expect(Object.keys(jar)).toEqual([gateway.url]);
  expect(after).toEqual({ badge: 'connected', hint: `${gateway.url} · Hermes ${VERSION} · running · signed in` });
  expect(afterSignOut.hint).toContain('sign-in required');
});

test('token: the URL and the token are saved, and a reload shows them again', async () => {
  await pickAuth('Token');
  await tokenField().fill(TOKEN);
  await row('Status').getByRole('button', { name: 'save', exact: true }).click();
  await expect(row('Status').getByRole('button', { name: 'save', exact: true })).toBeDisabled();
  const saved = readConnectionFile();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConnection();
  const shown = {
    mode: await page.locator('[aria-label="Hermes connection mode"] [aria-checked="true"]').textContent(),
    auth: await page.locator('[aria-label="Hermes auth mode"] [aria-checked="true"]').textContent(),
    url: await gatewayField().inputValue(),
    token: await tokenField().inputValue(),
    // The mount probe runs with what was saved: signed in by the token.
    signOutShown: await row('Sign in').getByRole('button', { name: 'sign out', exact: true }).isVisible(),
  };
  await stepShot(page, '04-reloaded');
  journey.saveAndReload = { saved: { ...saved, token: saved.token === TOKEN ? '(the token typed)' : saved.token }, shown: { ...shown, token: shown.token === TOKEN ? '(the token typed)' : shown.token } };

  expect(saved).toEqual({ mode: 'remote', localPort: 9, authMode: 'token', url: gateway.url, token: TOKEN });
  expect(shown).toEqual({ mode: 'Remote', auth: 'Token', url: gateway.url, token: TOKEN, signOutShown: true });
});

test('test: success, a refused token, and a gateway that is not there', async () => {
  const ok = await testConnection();
  await stepShot(page, '05-test-ok');

  await tokenField().fill('not-the-token');
  const badToken = await testConnection();
  await stepShot(page, '05-test-bad-token');

  await tokenField().fill(TOKEN);
  await gatewayField().fill('http://127.0.0.1:9');
  const dead = await testConnection();
  await stepShot(page, '05-test-unreachable');

  await gatewayField().fill('not a url');
  const garbage = await testConnection();

  // Nothing of that was saved: the file still names the fake.
  const file = readConnectionFile();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openConnection();
  journey.test = { ok, badToken, dead, garbage, fileUrlAfter: file.url };

  expect(ok).toEqual({ badge: 'connected', hint: `${gateway.url} · Hermes ${VERSION} · running · signed in` });
  expect(badToken.hint).toContain('sign-in required');
  expect(dead.badge).toBe('unreachable');
  expect(dead.hint).toMatch(/^http:\/\/127\.0\.0\.1:9 - .*(ECONNREFUSED|connect)/);
  expect(garbage.badge).toBe('unreachable');
  expect(garbage.hint).toContain('Invalid gateway URL');
  expect(file.url).toBe(gateway.url);
});

test('webhook: the secret Settings hands out opens the route and nothing else does', async () => {
  const webhookRow = row('Incoming webhook');
  // Filled once the main process has asked Tailscale, which takes a moment.
  await expect(webhookRow.locator('input')).toHaveValue(/\/api\/webhooks\/hermes$/, { timeout: 20_000 });
  const shownUrl = await webhookRow.locator('input').inputValue();
  const tailscaleLine = (await webhookRow.locator('[data-settings-hint]').textContent())?.trim();
  // Read-only like the Local gateway URL (frame XFApe, row B85KKr), and still
  // selected whole on focus, for copying.
  const webhookIdle = await fieldLook(webhookRow.locator('input'));
  await webhookRow.locator('input').click();
  const webhookFocused = await fieldLook(webhookRow.locator('input'));
  const webhookSelected = await webhookRow.locator('input').evaluate((el: HTMLInputElement) => el.selectionEnd! - el.selectionStart! === el.value.length);
  const webhookFocus = await keyboardThenPointer(webhookRow.locator('input'), webhookRow.getByRole('button', { name: 'copy secret' }));
  // What the main process found, read through the same bridge the page uses.
  // On a machine with Tailscale installed it is that machine's tailnet (the
  // CLI is only asked `status` and `serve status`): the line and the URL must
  // say what was found, whatever it is.
  const info = await page.evaluate(() => window.electronAPI!.hermes!.getConnectionInfo());
  const ts = info.tailscale;
  const expectedLine = ts.serveConfigured
    ? `tailscale serve active${ts.dnsName ? ` · ${ts.dnsName}` : ''}`
    : ts.running
      ? 'tailscale running · the API still only listens on localhost'
      : ts.installed ? 'tailscale installed but not running' : 'no tailscale · a VPS cannot reach this machine';
  const expectedUrl = info.webhookTailnetUrl ?? `http://127.0.0.1:${API_PORT}/api/webhooks/hermes`;
  const hide = (s: string | undefined) => (ts.dnsName && s ? s.split(ts.dnsName).join('<tailnet>') : s);

  // Restored after: text only, so an image or files on the clipboard are lost.
  const saved = await app.evaluate(({ clipboard }) => clipboard.readText());
  let copied = '';
  try {
    await webhookRow.getByRole('button', { name: 'copy secret' }).click();
    await expect(webhookRow.getByRole('button', { name: 'copied' })).toBeVisible();
    copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved);
  }
  const secretFile = path.join(home, '.tars-private', 'hermes-webhook-secret');
  const onDisk = fs.readFileSync(secretFile, 'utf-8').trim();
  const sharedToken = fs.readFileSync(path.join(home, '.dorothy', 'api-token'), 'utf-8').trim();

  const post = async (bearer: string, payload: unknown) => {
    const r = await fetch(`http://127.0.0.1:${API_PORT}/api/webhooks/hermes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const dryRun = await post(copied, { agent_id: 'a4', message: 'Run the nightly checks.', dry_run: true });
  const byName = await post(copied, { agent_name: 'qa', message: 'Run the nightly checks.', dry_run: true });
  const noMessage = await post(copied, { agent_id: 'a4', message: ' ', dry_run: true });
  const wrong = await post('not-the-secret', { agent_id: 'a4', message: 'x', dry_run: true });
  const shared = await post(sharedToken, { agent_id: 'a4', message: 'x', dry_run: true });
  // Masked as the win32 references mask them (tailscale-state, webhook-url):
  // on a machine with Tailscale they name its tailnet, and artefacts are shared.
  await page.screenshot({
    path: test.info().outputPath('06-webhook.png'),
    mask: [webhookRow.locator('input'), webhookRow.locator('[data-settings-hint]')],
  });
  journey.webhook = {
    shownUrl: hide(shownUrl), tailscaleLine: hide(tailscaleLine),
    tailscale: { installed: ts.installed, running: ts.running, serveConfigured: ts.serveConfigured, dnsName: ts.dnsName ? '(found)' : null },
    copiedIsSecret: copied === onDisk, secretLength: onDisk.length,
    inDataDir: fs.existsSync(path.join(home, '.dorothy', 'hermes-webhook-secret')),
    dryRun, byName: byName.status, noMessage, wrong, shared: { status: shared.status },
    look: { idle: webhookIdle, focused: webhookFocused, selectedOnFocus: webhookSelected, focus: webhookFocus },
  };

  expect(webhookIdle.background, 'the webhook field has the read-only fill').toBe(webhookIdle.tokens.surface);
  expect(webhookIdle.color).toBe(webhookIdle.tokens.textSecondary);
  expect(webhookIdle.border).toBe(webhookIdle.tokens.border);
  expect(webhookIdle.cursor).toBe('default');
  expect(webhookFocused.focused).toBe(true);
  expect(webhookFocused.border, 'the webhook field clicked turns its border').not.toBe(webhookIdle.border);
  expect(webhookSelected).toBe(true);
  expect(accentFocusBorder, 'the Local step measured the accent focus border').not.toBeNull();
  expect(webhookFocus.keyboard.focused, 'Shift+Tab lands on the webhook field').toBe(true);
  expect(webhookFocused.border, 'a click shows the accent focus border').toBe(accentFocusBorder);
  expect(webhookFocus.keyboard.border, 'Tab shows the accent focus border').toBe(accentFocusBorder);
  expect(webhookFocus.pointer.focused).toBe(true);
  expect(webhookFocus.pointer.border, 'a click after Tab shows it too').toBe(accentFocusBorder);
  expect(shownUrl).toBe(expectedUrl);
  expect(tailscaleLine).toBe(expectedLine);
  expect(copied).toBe(onDisk);
  expect(onDisk).toMatch(/^[0-9a-f]{64}$/);
  expect(fs.existsSync(path.join(home, '.dorothy', 'hermes-webhook-secret'))).toBe(false);
  expect(dryRun).toEqual({ status: 200, body: { success: true, dry_run: true, agent: expect.objectContaining({ id: 'a4', name: 'QA' }) } });
  expect(byName.status).toBe(200);
  expect(noMessage.status).toBe(400);
  expect(wrong.status).toBe(401);
  expect(shared.status).toBe(403);
});

test('Chat: the Hermes room reaches the gateway, sends, and shows the answer', async () => {
  test.setTimeout(120_000);
  await page.goto(`${DEV_URL}/chat`, { waitUntil: 'domcontentloaded' });
  await splashGone(page);
  const composer = page.getByPlaceholder('Ask about any project, or tell Hermes what to do.');
  await expect(composer).toBeEditable({ timeout: 20_000 });
  // The gateway banner, not Next's empty route announcer, which is an alert too.
  const banner = await page.getByRole('alert').filter({ hasText: 'Hermes' }).count();
  const question = 'What is the fleet doing right now?';
  await composer.fill(question);
  await composer.press('Enter');
  await expect(page.getByText(REPLY)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(question)).toBeVisible();
  await stepShot(page, '07-chat-hermes');
  const created = gateway.log.find(l => l.method === 'POST' && l.url === '/api/cron/jobs');
  const updated = gateway.log.filter(l => l.method === 'PUT' && l.url.startsWith('/api/cron/jobs/overseer-e2e'));
  const prompt = String((updated.at(-1)?.body as { updates?: { prompt?: string } })?.updates?.prompt ?? (created?.body as { prompt?: string })?.prompt ?? '');
  journey.chat = {
    banner, created: !!created, triggered: gateway.log.some(l => l.url === '/api/cron/jobs/overseer-e2e/trigger'),
    promptCarriesQuestion: prompt.includes(question),
  };

  expect(banner).toBe(0);
  expect(created).toBeTruthy();
  expect(prompt).toContain(question);
});

test('Brain: the Hermes backend is reachable, with its MCP servers and its memory provider', async () => {
  await page.goto(`${DEV_URL}/memory`, { waitUntil: 'domcontentloaded' });
  await splashGone(page);
  await page.getByRole('radiogroup', { name: 'Brain section' }).getByRole('radio', { name: 'Backends' }).click();
  const hermesRow = page.locator('div.flex.items-start.justify-between').filter({ has: page.getByText('Hermes memory', { exact: true }) }).first();
  await expect(hermesRow).toContainText('reachable', { timeout: 20_000 });
  const detail = (await hermesRow.textContent())?.trim();
  await expect(page.getByText('gbrain-e2e', { exact: true })).toBeVisible();
  await expect(page.getByText('Active provider:')).toContainText('holographic');
  const mem0 = page.locator('div.flex.items-start.justify-between').filter({ has: page.getByText('mem0', { exact: true }) }).first();
  await mem0.getByRole('button', { name: 'activate' }).click();
  await expect(page.getByText('Active provider:')).toContainText('mem0', { timeout: 15_000 });
  await stepShot(page, '08-brain-backends');
  journey.brain = { hermesRow: detail, activated: 'mem0' };

  expect(detail).toContain('provider holographic, 2 files readable');
});

test('Schedules, which the connection page links to, lists the gateway\'s jobs', async () => {
  await page.goto(`${DEV_URL}/crons`, { waitUntil: 'domcontentloaded' });
  await splashGone(page);
  await expect(page.getByText('nightly e2e digest').first()).toBeVisible({ timeout: 20_000 });
  await stepShot(page, '09-schedules');
  journey.schedules = { listed: true };
});

test('import: Hermes Desktop\'s own connection is offered where that app keeps it', async () => {
  // Where Hermes Desktop keeps its connection on this platform. Measured on
  // Nicolas's machine: %APPDATA%\Hermes\connection.json on Windows.
  const desktopDir = process.platform === 'win32'
    ? path.join(home, 'AppData', 'Roaming', 'Hermes')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Hermes')
      : null;
  test.skip(!desktopDir, 'Hermes Desktop has no known location on this platform');
  // Local first, as a fresh install is: the import is the way out of it.
  fs.writeFileSync(connectionFile(), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.mkdirSync(desktopDir!, { recursive: true });
  fs.writeFileSync(path.join(desktopDir!, 'connection.json'), JSON.stringify({
    mode: 'remote',
    remote: { url: gateway.url, authMode: 'token', token: { encoding: 'plain', value: TOKEN } },
  }));
  await openConnection();
  const before = await fieldReport(gatewayField());
  const importButton = row('Gateway URL').getByRole('button', { name: 'import' });
  const offered = await importButton.isVisible();
  journey.import = { before: { mode: before.mode, readOnly: before.readOnly }, offered };
  await stepShot(page, '10-import-offered');
  // Until 9caf31d8 Tars looked for it under ~/Library/Application Support on
  // every platform, and Windows never saw the button.
  expect(offered, 'the import is offered when Hermes Desktop keeps a connection here').toBe(true);

  await importButton.click();
  // The import asks the gateway, as Test does, and says what it answered: the
  // token came with the import, so signed in (e2e/hermes-bugs.spec.ts, a4).
  await expect(statusHint()).toHaveText(`Imported from Hermes Desktop · ${gateway.url} · Hermes ${VERSION} · running · signed in`, { timeout: 15_000 });
  const after = await fieldReport(gatewayField());
  await gatewayField().fill(`${gateway.url}/`);
  const editable = await gatewayField().inputValue();
  const saved = readConnectionFile();
  await stepShot(page, '10-imported');
  journey.import = { ...journey.import as object, after: { mode: after.mode, readOnly: after.readOnly, value: after.value }, editable, savedMode: saved.mode, savedUrl: saved.url, tokenImported: saved.token === TOKEN };

  expect(before).toMatchObject({ mode: 'Local', readOnly: true });
  expect(after).toMatchObject({ mode: 'Remote', readOnly: false, value: gateway.url });
  expect(editable).toBe(`${gateway.url}/`);
  expect(saved).toMatchObject({ mode: 'remote', url: gateway.url, token: TOKEN });
});

test('no page error on the way', async () => {
  journey.pageErrors = errors;
  expect(errors).toEqual([]);
});
