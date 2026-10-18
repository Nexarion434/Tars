import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The real codex in Tars, once (2.0.4): an agent created on codex, in auto at low effort on gpt-6-luna, is handed a
 * task with delegate_task, so Tars starts its codex with it in a project folder codex has never seen; it sends a
 * message to a claude agent through the Tars MCP server inside codex, with its own identity, and delegate_task
 * returns its answer, read from codex's session log. Then Tars quits and starts again on the same home, the window
 * starts Cody as Start does, and his codex resumes his own session (`codex resume`): a task delegated then is
 * answered from the conversation before the restart.
 *
 * codex is the user's own install (E2E_CODEX), signed in with the user's ChatGPT account through a link to
 * ~/.codex/auth.json in the sandbox's CODEX_HOME: never a copy, so a token codex refreshes is the one file, and the
 * link is checked to still be one at the end. Nothing else of ~/.codex is read or written. Lead, the project's
 * orchestrator, works through the real mcp-orchestrator over stdio; Claire is a claude worker whose terminal
 * records what is typed into it. codex-works.spec.ts proves each point with a stand-in; this is the real binary.
 *
 * Live: E2E_LIVE=1 and E2E_CODEX, a codex signed in with a ChatGPT account. Costs two or three turns on gpt-6-luna
 * at low effort. The artefact: values.json (the tools' answers, codex's own session log of the turns, Claire's bytes).
 */

const LEAD = 'dddd4444-0000-4000-8000-0000000000d4';
const CLAIRE = 'cccc3333-0000-4000-8000-0000000000c1';
const CODEX = process.env.E2E_CODEX ?? '';
const AUTH = path.join(os.homedir(), '.codex', 'auth.json');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Array<{ id: string; cliRunning?: boolean }>> } } };

test('the real codex starts in a new folder, answers, and messages a claude agent with its own identity', async () => {
  test.skip(process.env.E2E_LIVE !== '1' || !CODEX || !fs.existsSync(AUTH), 'live: E2E_LIVE=1, E2E_CODEX and a signed-in codex');
  test.setTimeout(9 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-codex-real-');
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  const codexHome = path.join(home, '.codex');
  for (const d of [project, dir, bin, codexHome]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  fs.symlinkSync(AUTH, path.join(codexHome, 'auth.json'));

  const claireTyped = path.join(home, 'claire.typed');
  const claude = path.join(bin, 'claude');
  fs.writeFileSync(claude, [
    `#!${process.execPath}`,
    "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
    `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(claireTyped)}, d));`,
    "process.stdout.write('claude stand-in ready\\n');",
    '',
  ].join('\n'), { mode: 0o755 });
  const typedIntoClaire = () => (fs.existsSync(claireTyped) ? fs.readFileSync(claireTyped, 'utf8') : '');
  const rollout = () => {
    const events: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
    const walk = (d: string) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/^rollout-.*\.jsonl$/.test(e.name)) for (const l of fs.readFileSync(p, 'utf8').split('\n')) { try { if (l.trim()) events.push(JSON.parse(l)); } catch { /* mid-write */ } }
    } };
    walk(path.join(codexHome, 'sessions'));
    return events;
  };

  const agent = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal', projectPath: project, skills: [],
    createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent(LEAD, 'Lead', 'orchestrator'), agent(CLAIRE, 'Claire', 'worker', { cliPath: claude })], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { codex: CODEX } }, null, 2));

  const port = apiPort(31312);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = { codex: fs.realpathSync(CODEX) };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const servers: ChildProcessWithoutNullStreams[] = [];
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', CODEX_HOME: codexHome } });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();

    await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), CLAIRE);
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find(a => a.id === CLAIRE)?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    const identity = await app.evaluate((_e, { dist, lead, claire }) => {
      const req = process.mainModule!.require;
      const c = req(`${dist}/core/agent-manager.js`).agents.get(claire);
      c.status = 'idle';
      const tokens = req(`${dist}/core/agent-tokens.js`);
      return { token: tokens.mintRunToken(lead).token as string, instance: tokens.tarsInstanceId() as string, claire: tokens.mintAgentToken(claire) as string };
    }, { dist, lead: LEAD, claire: CLAIRE });
    await fetch(`http://127.0.0.1:${port}/api/hooks/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.claire}` },
      body: JSON.stringify({ agent_id: CLAIRE, session_id: 'e2e00000-0000-4000-8000-0000000000c1', status: 'idle', source: 'startup' }),
    });

    // Tars's servers in codex's config, as a packaged Tars registers them at its start.
    const resources = path.join(home, 'resources');
    fs.mkdirSync(path.join(resources, 'mcp-orchestrator', 'dist'), { recursive: true });
    fs.copyFileSync(path.resolve('mcp-orchestrator', 'dist', 'bundle.js'), path.join(resources, 'mcp-orchestrator', 'dist', 'bundle.js'));
    fs.copyFileSync(path.resolve('mcp-orchestrator', 'package.json'), path.join(resources, 'mcp-orchestrator', 'package.json'));
    await app.evaluate(async (_e, { dist, resources }) => {
      const was = process.resourcesPath;
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
      try { await process.mainModule!.require(`${dist}/services/mcp-orchestrator.js`).setupMcpOrchestrator({}); }
      finally { Object.defineProperty(process, 'resourcesPath', { value: was, configurable: true, writable: true }); }
    }, { dist, resources });

    const calls: Array<{ tool: string; text: string; isError: boolean }> = [];
    /** Lead's tools through the real mcp-orchestrator, with the identity this run of Tars gave it. */
    const connectLead = async (identity: { token: string; instance: string }) => {
      const mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
        env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.token, CLAUDE_AGENT_ID: LEAD, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance },
      });
      servers.push(mcp);
      const replies = new Map<number, (msg: Reply) => void>();
      let buffered = '';
      mcp.stdout.on('data', (chunk) => {
        buffered += chunk;
        for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
          const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (typeof msg.id === 'number' && !msg.method) replies.get(msg.id)?.(msg);
        }
      });
      let nextId = 1;
      const rpc = (method: string, params: unknown) => new Promise<Reply>((resolve) => { const id = nextId++; replies.set(id, resolve); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return async (tool: string, args: Record<string, unknown>) => {
        const reply = await Promise.race([rpc('tools/call', { name: tool, arguments: args }), sleep(300_000).then(() => ({ error: `${tool} gave no answer in 300 s` }) as Reply)]);
        const answer = { tool, text: reply.result?.content?.map(c => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
        calls.push(answer);
        keep({ calls });
        return answer;
      };
    };
    const lead = await connectLead(identity);

    const nonce = randomBytes(4).toString('hex');
    const made = await lead('create_agent', { name: 'Cody', provider: 'codex', projectPath: project, model: 'gpt-6-luna', effort: 'low', permissionMode: 'auto' });
    const cody = made.text.match(/with ID: ([0-9a-f-]{36})/)?.[1] ?? '';
    expect(cody, made.text).toBeTruthy();
    const done = await lead('delegate_task', {
      id: cody,
      prompt: `Use the send_message tool of the claude-mgr-orchestrator MCP server once: id "${CLAIRE}", message "hello from real codex ${nonce}". Then reply with exactly: DONE ${nonce}`,
      timeoutSeconds: 240,
    });
    await expect.poll(typedIntoClaire, { timeout: 20_000 }).toContain(nonce).catch(() => {});
    const events = rollout();
    const context = events.find(e => e.type === 'turn_context')?.payload as { model?: string; collaboration_mode?: { settings?: { reasoning_effort?: string } }; approvals_reviewer?: string } | undefined;
    const config = fs.existsSync(path.join(codexHome, 'config.toml')) ? fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8') : '';
    keep({
      done, claireTyped: typedIntoClaire().slice(-1500), trusted: config.includes(`[projects.${JSON.stringify(fs.realpathSync(project))}]`),
      envVars: /env_vars = \[[^\]]*CLAUDE_MGR_API_TOKEN/.test(config),
      model: context?.model, effort: context?.collaboration_mode?.settings?.reasoning_effort, reviewer: context?.approvals_reviewer,
      turns: events.filter(e => e.type === 'event_msg' && e.payload?.type === 'task_complete').map(e => ({ answer: e.payload?.last_agent_message, error: e.payload?.error ?? null })),
      authStillALink: fs.lstatSync(path.join(codexHome, 'auth.json')).isSymbolicLink(),
    });
    await stepShot(page, 'real-codex');

    expect.soft(done.text, "Cody's answer never came back").toContain(`DONE ${nonce}`);
    expect.soft(typedIntoClaire(), "Claire never got Cody's message").toContain(`hello from real codex ${nonce}`);
    expect.soft(typedIntoClaire(), 'the message is not from Cody').toContain('"Cody"');
    expect.soft(context?.model).toBe('gpt-6-luna');
    expect.soft(context?.collaboration_mode?.settings?.reasoning_effort, "the effort codex's own log shows").toBe('low');

    // Tars quits and starts again on the same home; the window starts Cody, and his own codex session goes on.
    const sessionOf = (id: string) => app!.evaluate((_e, { dist, id }) => {
      const a = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get(id);
      return { current: a?.currentSessionId as string | undefined, resumable: a?.resumableSessionId as string | undefined };
    }, { dist, id });
    const kept = (await sessionOf(cody)).resumable;
    for (const server of servers.splice(0)) server.kill();
    await app.close();
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', CODEX_HOME: codexHome } });
    const appLog2 = test.info().outputPath('app-2.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog2, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog2, d));
    const page2: Page = await app.firstWindow();
    const identity2 = await app.evaluate((_e, { dist, lead }) => {
      const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
      return { token: tokens.mintRunToken(lead).token as string, instance: tokens.tarsInstanceId() as string };
    }, { dist, lead: LEAD });
    const lead2 = await connectLead(identity2);
    await page2.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), cody);
    await expect.poll(async () => (await page2.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find(a => a.id === cody)?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await sessionOf(cody)).current, { timeout: 30_000 }).toBe(kept).catch(() => {});
    const resumedAs = await sessionOf(cody);
    const again = await lead2('delegate_task', {
      id: cody,
      prompt: 'What exact text did you reply with to my previous task? Reply with exactly that text, then a space, then AGAIN',
      timeoutSeconds: 240,
    });
    keep({ kept, resumedAs, again, authStillALink: fs.lstatSync(path.join(codexHome, 'auth.json')).isSymbolicLink() });
    await stepShot(page2, 'real-codex-resumed');
    expect.soft(resumedAs.current, 'Tars follows the session codex resumed').toBe(kept);
    expect.soft(again.text, "Cody after the restart, in his own conversation").toContain(`DONE ${nonce} AGAIN`);
    expect(fs.lstatSync(path.join(codexHome, 'auth.json')).isSymbolicLink(), 'the sign-in link was replaced by a file').toBe(true);
  } finally {
    for (const server of servers) server.kill();
    await app?.close();
    await sleep(500);
    await removeHome(home);
  }
});
