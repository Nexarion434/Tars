import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * FAILING BY DESIGN. Reported defect: opening the terminal of an agent that
 * is still working shows its output over and over.
 *
 * A PTY is spawned at a fixed 120x30 (`initAgentPty`, `agent:create`) or
 * 120x40 (`spawnAgentSession`), and every byte it produces is stored in
 * `agent.output`. When a panel mounts, `useMultiTerminal.initTerminal` fits
 * the xterm to the panel, pushes that size onto the PTY (`safeFit` ->
 * `agent.resize`), and only then replays the stored bytes into it.
 *
 * Those bytes are not a log. Claude Code, like every Ink program, repaints by
 * erasing exactly as many physical rows as its last frame occupied
 * (`ESC[<n>A ESC[0J`), and that count was computed against the width the PTY
 * had at the time. Replay them into a narrower terminal and every line that
 * now wraps makes the erase one row short, so each stored frame deposits a
 * leftover copy. A transcript holding a few hundred frames therefore paints
 * the same transcript a few hundred times.
 *
 * It only shows on a working agent because only a working agent's transcript
 * is a stream of repaint frames. And it only shows when the panel is
 * NARROWER than 120 columns, which on a board with several agents it always
 * is (a 3x2 grid at 1440px is roughly 60 columns per panel).
 *
 * Three controls, run while diagnosing, place the cause precisely:
 *   - panel opened BEFORE the CLI starts (no resize, no replay): clean
 *   - panel left and re-entered so the transcript IS replayed, but at the
 *     width it was recorded at: clean
 *   - panel opened mid-run so the transcript is replayed at a new width:
 *     the assertion below, ~50 copies
 *
 * The fix belongs in the renderer: the size handed to the PTY and to xterm
 * must not silently reinterpret bytes that were recorded at another width.
 */

const DEV_URL = process.env.DOROTHY_DEV_URL || 'http://localhost:3100';

let app: ElectronApplication;
let page: Page;
let sandboxHome: string;
let projectPath: string;

/**
 * A stand-in for Claude Code's renderer: erase the rows the last frame took,
 * print the frame, remember how many physical rows that was at the current
 * width. Nothing about it is exotic - it is what Ink does.
 */
const FAKE_CLI = `
const lines = [];
let printed = 0;
let n = 0;
const width = () => process.stdout.columns || 80;
function render() {
  if (printed > 0) process.stdout.write('\\x1b[' + printed + 'A\\x1b[0J');
  const body = lines.concat(['STATUS ' + n + ' ' + width() + 'x' + process.stdout.rows]);
  printed = body.reduce((a, l) => a + Math.max(1, Math.ceil(l.length / width())), 0);
  process.stdout.write(body.join('\\n') + '\\n');
}
setInterval(() => { n++; render(); }, 120);
setInterval(() => {
  // Wide enough to occupy one row at the PTY's 120 columns and two in a panel.
  if (lines.length < 6) lines.push('TX' + lines.length + ' ' + 'x'.repeat(104));
}, 300);
setTimeout(() => process.exit(0), 60000);
`;

function seed(home: string) {
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(dir, { recursive: true });
  projectPath = path.join(home, 'projects', 'replay');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'tui.js'), FAKE_CLI);
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([]));
  fs.writeFileSync(
    path.join(dir, 'projects.json'),
    JSON.stringify([{ path: projectPath, name: 'replay' }]),
  );
  // A large font stands in for a board with several panels: it makes the one
  // panel narrower than the 120 columns the PTY is spawned with, which is the
  // condition on a real multi-agent board.
  fs.writeFileSync(
    path.join(dir, 'app-settings.json'),
    JSON.stringify({ autoStartOnLaunch: false, terminalFontSize: 20 }),
  );
}

test.beforeAll(async () => {
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-dup-'));
  seed(sandboxHome);
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      HOME: sandboxHome,
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      DOROTHY_API_PORT: '31496',
      DOROTHY_E2E: '1',
    },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

/**
 * The whole xterm buffer, not just the viewport: the copies pile up above the
 * fold. xterm's DOM renderer only materialises visible rows, so scroll
 * through and collect them by absolute row index.
 */
async function readBuffer(p: Page): Promise<string[]> {
  return p.evaluate(async () => {
    const vp = document.querySelector('.xterm-viewport') as HTMLElement | null;
    const rowsEl = document.querySelector('.xterm-rows') as HTMLElement | null;
    if (!vp || !rowsEl || !rowsEl.children.length) return [];
    const rowH = rowsEl.children[0].getBoundingClientRect().height || 16;
    const step = Math.max(1, rowsEl.children.length - 1);
    const collected = new Map<number, string>();
    for (let top = 0; top <= vp.scrollHeight; top += rowH * step) {
      vp.scrollTop = top;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const base = Math.round(vp.scrollTop / rowH);
      Array.from(rowsEl.children).forEach((d, i) => collected.set(base + i, d.textContent || ''));
    }
    return [...collected.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  });
}

test('opening the panel of a working agent shows its output once', async () => {
  // Anywhere without terminal panels, so creating the agent does not mount
  // one: the point is to open the panel later, mid-run.
  await page.goto(DEV_URL + '/agents', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const agentId = await page.evaluate(async (cwd) => {
    const agent = await window.electronAPI!.agent.create({
      projectPath: cwd,
      skills: [],
      name: 'Replay',
      character: 'robot',
    });
    return agent.id;
  }, projectPath);
  expect(agentId).toBeTruthy();

  await page.waitForTimeout(1200);
  await page.evaluate(
    async ({ id, node }) => {
      await window.electronAPI!.agent.sendInput({ id, input: `'${node}' tui.js\n` });
    },
    { id: agentId, node: process.execPath },
  );

  // Let the CLI paint a few hundred frames at the PTY's own width while
  // nothing is watching. This is the stored transcript.
  await page.waitForTimeout(6000);

  // Open the terminal. This is the reported gesture.
  await page.goto(DEV_URL + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm-rows', { timeout: 15_000 });
  await page.waitForTimeout(6000);

  const lines = await readBuffer(page);
  const rendered = lines.filter(l => l.trim()).join('\n');

  const seen = new Map<string, number>();
  for (const line of lines) {
    for (const m of line.matchAll(/\bTX(\d+)\b/g)) {
      seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
    }
  }
  expect(seen.size, `the CLI never rendered; buffer was:\n${rendered}`).toBeGreaterThan(2);

  const duplicated = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([id, count]) => `TX${id} rendered ${count}x`);

  expect(
    duplicated,
    'the stored transcript was replayed at a width it was not recorded at, ' +
      'so every frame in it left a copy behind',
  ).toEqual([]);
});
