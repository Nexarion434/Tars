import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Tars's health, reported (2.0.3, Noah's go of 2026-10-15 on monitoring options 1 and 2), in the real app, against a
 * stand-in of Sentry that records every envelope.
 *
 * With "Send error reports" on: Tars samples its health (every second here, DOROTHY_HEALTH_EVERY_MS); it is killed
 * (SIGKILL, as a crash leaves it) while the Usage page is open; at the next launch exactly one report of the abrupt end
 * reaches Sentry, with its version, uptime and last sample (page /usage) and nothing of the machine. "Send a diagnostic"
 * (diagnostic:send): refused while Sentry answers 503, without spending the budget; then sent, its samples in it; then
 * refused for 24 hours. A clean quit, then a launch: no report. With the switch off: a kill and a launch send nothing,
 * and the diagnostic is refused with the reason. On Windows error reports are not offered: nothing is sent, and the
 * diagnostic says why.
 * The artefact: values.json with every event the stand-in received and every answer.
 */

type Event = { tags?: { kind?: string }; contexts?: { tars?: Record<string, unknown> }; exception?: { values?: Array<{ type?: string }> } };
type Answer = { sent: boolean; reason?: string; samples?: number };
const onWindows = process.platform === 'win32';

/** Sentry's ingest, as the SDK posts to it: envelopes, maybe gzipped; `status` is what it answers. */
async function startFakeSentry() {
  const events: Event[] = [];
  const raw: string[] = [];
  const state = { status: 200 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      const text = body.toString('utf8');
      if (state.status === 200) {
        raw.push(text);
        const lines = text.split('\n').filter(Boolean);
        for (let i = 1; i + 1 < lines.length; i += 2) {
          try {
            if (JSON.parse(lines[i]).type === 'event') events.push(JSON.parse(lines[i + 1]));
          } catch { /* not an event item */ }
        }
      }
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    dsn: `http://e2epublickey@127.0.0.1:${port}/1`,
    events, raw, state,
    ofKind: (kind: string) => events.filter((e) => e.tags?.kind === kind),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function seed(home: string, reportsOn: boolean) {
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  const agent = (id: string) => ({
    id, name: id, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal',
    projectPath: project, skills: [], createdAt: '2026-10-15T08:00:00.000Z', lastActivity: '2026-10-15T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('a1'), agent('a2')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', errorReportsEnabled: reportsOn }));
  return { samplesFile: path.join(dir, 'health-samples.jsonl') };
}

type Sample = { at: number; page: string | null; slowest: Array<{ channel: string; ms: number }> } & Record<string, unknown>;
const samplesIn = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Sample) : []);

async function boot(home: string, dsn: string, port: number): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: String(port), DOROTHY_E2E: '1', DOROTHY_ERROR_REPORTS_DSN: dsn, DOROTHY_HEALTH_EVERY_MS: '1000' },
  });
  const page = await app.firstWindow();
  await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
  return { app, page };
}
const diagnostic = (page: Page) => page.evaluate(() => (window as unknown as { electronAPI: { diagnostic: { send(): Promise<Answer> } } }).electronAPI.diagnostic.send());
const kill = async (app: ElectronApplication) => {
  process.kill(app.process().pid!, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 2_000));
};

test('an abrupt end is reported once at the next launch, a diagnostic sends the last samples, and nothing leaves with the switch off', async () => {
  test.setTimeout(300_000);
  const sentry = await startFakeSentry();
  const values: Record<string, unknown> = {};
  const keep = () => { values.events = sentry.events; recordValues(values); };
  const port = Number(apiPort(31434));

  // ── With "Send error reports" on ──
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-health-'));
  const { samplesFile } = seed(home, true);
  try {
    let { app, page } = await boot(home, sentry.dsn, port);
    // Samples with IPC calls in them: the page polls, so some window has a slowest handler.
    await expect.poll(() => samplesIn(samplesFile).filter((s) => s.page === '/usage' && s.slowest.length > 0).length, { timeout: 30_000, message: 'samples taken on /usage, with their slowest handlers' }).toBeGreaterThanOrEqual(2);
    await kill(app);
    // What that run left on disk, before the next run samples.
    const leftByThatRun = samplesIn(samplesFile);

    ({ app, page } = await boot(home, sentry.dsn, port));
    if (onWindows) {
      await page.waitForTimeout(5_000);
      expect(sentry.events).toEqual([]);
    } else {
      await expect.poll(() => sentry.ofKind('abrupt-end').length, { timeout: 30_000, message: 'the abrupt end reported' }).toBe(1);
      const report = sentry.ofKind('abrupt-end')[0];
      values.abruptEnd = report;
      const tars = report.contexts!.tars!;
      const version = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version as string;
      expect(report.exception!.values![0].type).toBe('TarsEndedAbruptly');
      expect(tars.previousVersion).toBe(version);
      expect(typeof tars.uptimeMinutes).toBe('number');
      // The last sample of that run, whole, its slowest handlers included, as it is on disk: nothing lost on the wire.
      expect(tars.lastSample).toEqual(leftByThatRun.at(-1));
      expect(tars.lastSample).toMatchObject({ page: '/usage', agents: 2, running: 0 });
      expect(Object.keys(tars).sort()).toEqual(['crashType', 'lastSample', 'previousVersion', 'uptimeMinutes']);
      // Nothing of this machine in what left.
      for (const text of sentry.raw) {
        expect(text).not.toContain(home);
        expect(text).not.toContain(os.hostname());
        expect(text).not.toContain(os.userInfo().username);
      }
    }
    keep();

    // ── Send a diagnostic ──
    await expect.poll(() => samplesIn(samplesFile).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    if (onWindows) {
      values.diagnosticWindows = await diagnostic(page);
      expect(values.diagnosticWindows).toEqual({ sent: false, reason: expect.stringContaining('Windows') });
    } else {
      sentry.state.status = 503;
      values.diagnosticUnreachable = await diagnostic(page);
      expect(values.diagnosticUnreachable).toEqual({ sent: false, reason: expect.stringContaining('could not be reached') });
      sentry.state.status = 200;
      values.diagnosticSent = await diagnostic(page);
      expect(values.diagnosticSent).toMatchObject({ sent: true, samples: expect.any(Number) });
      expect((values.diagnosticSent as Answer).samples).toBeGreaterThanOrEqual(3);
      const sent = sentry.ofKind('diagnostic');
      expect(sent.length).toBe(1);
      // As many samples as the window was told, each whole, as it is on disk.
      const received = sent[0].contexts!.tars!.samples as Sample[];
      expect(received.length).toBe((values.diagnosticSent as Answer).samples);
      const onDisk = new Map(samplesIn(samplesFile).map((s) => [s.at, s]));
      for (const s of received) expect(s, `the sample of ${new Date(s.at).toISOString()} as on disk`).toEqual(onDisk.get(s.at));
      expect(received.some((s) => s.slowest.length > 0), 'a sample with its slowest handlers').toBe(true);
      values.diagnosticAgain = await diagnostic(page);
      expect(values.diagnosticAgain).toEqual({ sent: false, reason: expect.stringContaining('already sent') });
      expect(sentry.ofKind('diagnostic').length).toBe(1);
    }
    keep();

    // ── A clean quit, then a launch: nothing ──
    await app.close();
    ({ app, page } = await boot(home, sentry.dsn, port));
    await page.waitForTimeout(5_000);
    expect(sentry.ofKind('abrupt-end').length).toBe(onWindows ? 0 : 1);
    await app.close();
    expect(fs.statSync(samplesFile).size).toBeLessThanOrEqual(256 * 1024);
    keep();
  } finally {
    await removeHome(home);
  }

  // ── With the switch off: nothing leaves ──
  const before = sentry.events.length;
  const off = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-health-off-'));
  const offSeed = seed(off, false);
  try {
    let { app, page } = await boot(off, sentry.dsn, port);
    await expect.poll(() => samplesIn(offSeed.samplesFile).length, { timeout: 30_000, message: 'samples are kept with the switch off too' }).toBeGreaterThanOrEqual(1);
    await kill(app);
    ({ app, page } = await boot(off, sentry.dsn, port));
    await page.waitForTimeout(5_000);
    values.diagnosticOff = await diagnostic(page);
    expect(values.diagnosticOff).toEqual({ sent: false, reason: expect.stringContaining(onWindows ? 'Windows' : 'Turn on Send error reports') });
    expect(sentry.events.length).toBe(before);
    await app.close();
    keep();
  } finally {
    await removeHome(off);
    await sentry.close();
  }
});
