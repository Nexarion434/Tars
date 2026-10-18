import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A Qwen Code agent does what a claude agent does (2.0.4), in the real app.
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server spoken to over stdio with the identity of the
 * orchestrator `lead`. Agent `qw` is a qwen-code worker whose CLI is a stand-in named `qwen` that does what qwen
 * 0.25.2 was measured doing on 2026-10-18: it reads the settings file QWEN_CODE_SYSTEM_SETTINGS_PATH names, runs the
 * hooks found there with Claude Code's fields (SessionStart, UserPromptSubmit, Stop, Notification, PermissionRequest),
 * takes its first prompt from -i and stays, takes a typed line as its next turn, writes its transcript where qwen
 * does (~/.qwen/projects/<cwd>/chats/<session>.jsonl, parts and usageMetadata), continues a session --resume names,
 * and starts the MCP servers its settings name with its whole environment and their own env, as qwen does.
 * Its terminal records its argv, the names of its key variables (a sha256 of each value) and its settings file.
 *
 * Asserted, once with the classic shell and once with the new interface:
 * 1. qw's models, as the window reads them (models.ofCli), are the sandbox's ~/.qwen/settings.json modelProviders,
 *    and that file is never written;
 * 2. lead's delegate_task to qw starts its session with the task as -i, on its model, its approval mode (bypass:
 *    yolo), its effort (high, in its settings file, not on the command line), and its key under its model's envKey,
 *    in its environment only; its settings file carries every hook and Tars's MCP servers, no token and no key;
 * 3. the task's answer is qw's final message, read from its transcript, with its end reason, tokens and cost;
 * 4. a second task goes into the same session, and qw reports back with send_message through Tars's MCP server,
 *    started with qw's own environment: lead's terminal receives it from "Qwen Worker" ("qw");
 * 5. a permission qw asks for reads `waiting` / `permission` in the window, as a claude agent's does;
 * 6. Tars restarted, qw started again continues its conversation (--resume with the session it had);
 * 7. Usage by task holds qw's tasks with their tokens and cost.
 * Tars's MCP servers are the entry a packaged Tars registers for Qwen Code (~/.dorothy/qwen-code/mcp-servers.json),
 * seeded on this checkout's bundle: a dev run finds no bundle under its resources and registers none, for any CLI.
 * Red on feat/cli-api-keys (24469620), before the provider: qwen-code is Claude, and none of this holds.
 * The artefact: values.json (every answer, the stand-in's records, the settings file, the usage), E2E_TRACE=on.
 */

const QWEN_STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const argv = process.argv.slice(2);
if (['mcp', '--version', '-v', 'update', 'hooks'].includes(argv[0])) { process.stdout.write('ok\n'); process.exit(0); }
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const LOG = path.join(process.env.HOME, 'qwen-stand-in.jsonl');
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), pid: process.pid, agent: process.env.CLAUDE_AGENT_ID || null, ...o }) + '\n');
const settingsFile = process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
const settings = settingsFile && fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
const keys = Object.keys(process.env).filter((k) => /_(API_KEY|KEY)$/.test(k)).sort();
const hashes = Object.fromEntries(keys.map((k) => [k, crypto.createHash('sha256').update(process.env[k]).digest('hex')]));
const resume = flag('--resume');
const sid = resume || crypto.randomUUID();
const cwd = process.cwd();
const transcript = path.join(process.env.HOME, '.qwen', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'chats', sid + '.jsonl');
fs.mkdirSync(path.dirname(transcript), { recursive: true });
log({ launched: argv, keys, hashes, settingsFile, settings, sid });
const hook = (event, payload) => {
  for (const entry of settings.hooks?.[event] ?? []) for (const h of entry.hooks ?? []) {
    const r = spawnSync('/bin/sh', ['-c', h.command], { input: JSON.stringify({ session_id: sid, cwd, transcript_path: transcript, hook_event_name: event, timestamp: new Date().toISOString(), ...payload }), env: process.env, timeout: 20000 });
    log({ hook: event, exit: r.status });
  }
};
const write = (o) => fs.appendFileSync(transcript, JSON.stringify({ sessionId: sid, cwd, timestamp: new Date().toISOString(), uuid: crypto.randomUUID(), ...o }) + '\n');
/** An MCP server of its settings, started as qwen starts one: qwen's environment, then the server's own. */
function callTool(server, tool, args) {
  return new Promise((resolve) => {
    const cfg = settings.mcpServers?.[server];
    if (!cfg) return resolve({ error: 'no server ' + server });
    const p = spawn(cfg.command, cfg.args ?? [], { env: { ...process.env, ...(cfg.env ?? {}) }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }); }
        if (m.id === 2) { p.kill(); resolve(m.result ?? { error: m.error }); }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'qwen', version: '0.25.2' } } });
    setTimeout(() => { p.kill(); resolve({ error: 'timeout' }); }, 30000);
  });
}
async function turn(prompt) {
  const task = (prompt.match(/TASK-[A-Z]+/) ?? ['?'])[0];
  hook('UserPromptSubmit', { prompt, prompt_id: crypto.randomUUID() });
  write({ type: 'user', message: { role: 'user', parts: [{ text: prompt }] } });
  log({ turn: task, prompt });
  let answer = 'answer for ' + task + ': ' + 'qwen read it all. '.repeat(10);
  if (task === 'TASK-SENDBACK') {
    const sent = await callTool('claude-mgr-orchestrator', 'send_message', { id: 'requester', message: 'REPORT-FROM-QWEN the review is done' });
    log({ sent });
    answer = 'answer for TASK-SENDBACK: reported';
  }
  if (task === 'TASK-PERM') {
    hook('PermissionRequest', { tool_name: 'run_shell_command', tool_input: { command: 'touch x' } });
    hook('Notification', { notification_type: 'permission_prompt', message: 'Qwen Code needs your permission to use run_shell_command', title: 'Qwen Code' });
    await new Promise((r) => setTimeout(r, 8000));
    answer = 'answer for TASK-PERM: not allowed';
  }
  write({ type: 'assistant', model: flag('-m') || 'deepseek-v4-flash', message: { role: 'model', parts: [{ text: 'thinking about ' + task, thought: true }, { text: answer }] },
    usageMetadata: { promptTokenCount: 20000, candidatesTokenCount: 400, thoughtsTokenCount: 100, cachedContentTokenCount: 18000, totalTokenCount: 20500 } });
  hook('Stop', { stop_hook_active: false, last_assistant_message: answer, prompt_id: crypto.randomUUID() });
  hook('Notification', { notification_type: 'idle_prompt', message: 'Qwen Code is waiting for your input', title: 'Qwen Code' });
}
hook('SessionStart', { source: resume ? 'resume' : 'startup', model: flag('-m'), permission_mode: flag('--approval-mode') });
process.stdout.write('qwen stand-in ready\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let queue = Promise.resolve();
const first = flag('-i');
if (first) queue = queue.then(() => turn(first));
let buffer = '';
process.stdin.on('data', (d) => {
  buffer += d.toString();
  let end;
  while ((end = buffer.search(/[\r\n]/)) !== -1) {
    const line = buffer.slice(0, end).replace(/\x1b\[20[01]~/g, '');
    buffer = buffer.slice(end + 1);
    if (line.trim()) queue = queue.then(() => turn(line));
  }
});
process.stdin.resume();
`;

/** lead's terminal: a stand-in that records every byte typed into it. */
const LEAD_STAND_IN = (file: string) => [
  `#!${process.execPath}`,
  "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
  `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(file)}, d));`,
  "process.stdout.write('lead stand-in ready\\n');",
  '',
].join('\n');

const KEY = 'sk-e2e-qwen-deepseek-7777';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const QWEN_SETTINGS = {
  model: { name: 'deepseek-v4-pro' },
  modelProviders: { openai: [
    { id: 'deepseek-v4-pro', name: '[DeepSeek] deepseek-v4-pro', baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY' },
    { id: 'deepseek-v4-flash', name: '[DeepSeek] deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY' },
  ] },
};

type ToolAnswer = { text: string; isError: boolean };
type Rec = { at: number; agent: string | null; launched?: string[]; keys?: string[]; hashes?: Record<string, string>; settingsFile?: string; settings?: Record<string, unknown>; sid?: string; hook?: string; turn?: string; sent?: unknown };
type Agent = { id: string; status: string; waitingReason?: string; cliRunning?: boolean; currentSessionId?: string };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> };
  cliKeys: { set(id: string, patch: { key?: string }): Promise<{ success: boolean }> };
  usage: { tasks(q?: { sinceDays?: number }): Promise<{ tasks: Array<{ id: string; agentId: string; outcome: string; costUSD: number | null; tokens?: { input: number; output: number } | null }> }> };
} };

function mcpAs(home: string, project: string, port: string, agentId: string, token: string, instance: string) {
  const mcp: ChildProcessWithoutNullStreams = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
    env: {
      PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: token,
      CLAUDE_AGENT_ID: agentId, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: instance,
    },
  });
  const replies = new Map<number, (msg: { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown }) => void>();
  let buffered = '';
  mcp.stdout.on('data', (chunk) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (typeof msg.id === 'number') replies.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const rpc = (method: string, params: unknown) => new Promise<Parameters<NonNullable<ReturnType<typeof replies.get>>>[0]>((resolve) => {
    const id = nextId++;
    replies.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const ready = (async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  })();
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolAnswer> => {
    await ready;
    const reply = await rpc('tools/call', { name, arguments: args });
    return { text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
  };
  return { call, kill: () => mcp.kill() };
}

for (const newInterface of [false, true]) {
  test(`a qwen code agent does what a claude agent does${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(420_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-qwen-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.dorothy');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin, path.join(home, '.qwen')]) fs.mkdirSync(d, { recursive: true });
    const qwenSettingsFile = path.join(home, '.qwen', 'settings.json');
    fs.writeFileSync(qwenSettingsFile, JSON.stringify(QWEN_SETTINGS));
    const qwenSettingsBefore = fs.readFileSync(qwenSettingsFile, 'utf8');
    const qwen = path.join(bin, 'qwen');
    fs.writeFileSync(qwen, `#!${process.execPath}\n${QWEN_STAND_IN}`, { mode: 0o755 });
    const leadReceived = path.join(home, 'lead.received');
    const leadCli = path.join(home, 'lead-cli.cjs');
    fs.writeFileSync(leadCli, LEAD_STAND_IN(leadReceived), { mode: 0o755 });
    const agent = (id: string, name: string, role: string, provider: string, extra: Record<string, unknown> = {}) => ({
      id, name, character: 'robot', provider, status: 'idle', role, projectPath: project, skills: [], permissionMode: 'bypass',
      createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z', ...extra,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('lead', 'Project Lead', 'orchestrator', 'claude', { cliPath: leadCli }),
      agent('qw', 'Qwen Worker', 'worker', 'qwen-code', { cliPath: qwen, model: 'deepseek-v4-flash', effort: 'high' }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    // What a packaged Tars registers for Qwen Code at its start (mcp-orchestrator.ts), the bundles being under its
    // resources there: in a dev run they are not, so the entry is the one it would write, on this checkout's bundle.
    fs.mkdirSync(path.join(dir, 'qwen-code'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'qwen-code', 'mcp-servers.json'), JSON.stringify({
      'claude-mgr-orchestrator': { command: process.execPath, args: [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')] },
    }));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { qwencode: qwen, additionalPaths: [bin] }, newInterface,
    }));
    const port = apiPort(newInterface ? 31412 : 31411);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface, home };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const records = () => (fs.existsSync(path.join(home, 'qwen-stand-in.jsonl'))
      ? fs.readFileSync(path.join(home, 'qwen-stand-in.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec) : []);
    const launches = () => records().filter((r) => r.launched);

    const launch = () => launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
    const open = async (app: ElectronApplication) => {
      const page: Page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      return page;
    };
    let app: ElectronApplication = await launch();
    const servers: Array<{ kill(): void }> = [];
    try {
      let page = await open(app);
      const qwNow = async () => (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find((a) => a.id === 'qw')!;

      // 1. Its models, as the window reads them (models:cli).
      const models = await page.evaluate(() => (window as unknown as { electronAPI: { models: { ofCli(p: string): Promise<{ models: Array<{ id: string }> }> } } }).electronAPI.models.ofCli('qwen-code')).then((r) => r.models);
      keep({ models });
      expect.soft(models.map((m: { id: string }) => m.id)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash']);

      // lead's terminal, and its identity for the MCP server.
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'lead', prompt: '' }));
      await expect.poll(async () => (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find((a) => a.id === 'lead')?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
      const ids = await app.evaluate((_e, { dist }) => {
        const req = process.mainModule!.require;
        const { agents } = req(`${dist}/core/agent-manager.js`);
        const lead = agents.get('lead');
        lead.sessionRegisteredAt = new Date().toISOString();
        lead.status = 'idle';
        const tokens = req(`${dist}/core/agent-tokens.js`);
        return { lead: tokens.mintRunToken('lead').token as string, instance: tokens.tarsInstanceId() as string };
      }, { dist });
      const lead = mcpAs(home, project, port, 'lead', ids.lead, ids.instance);
      servers.push(lead);
      const keySet = await page.evaluate((key) => (window as unknown as Api).electronAPI.cliKeys.set('qwen-code', { key }), KEY);
      expect.soft(keySet).toMatchObject({ success: true });

      // 2, 3. A task delegated to qw.
      const one = await lead.call('delegate_task', { id: 'qw', prompt: 'TASK-ONE review the notes', timeoutSeconds: 120 });
      const first = launches()[0];
      keep({ one, first });
      expect.soft(one.isError, one.text).toBe(false);
      expect.soft(one.text).toContain('answer for TASK-ONE');
      expect.soft(one.text).toContain('ended: end_turn');
      expect.soft(one.text).toMatch(/\d+ tokens/);
      expect.soft(one.text).toMatch(/\$\d/);
      expect.soft(first?.launched ?? [], 'its first prompt with -i').toContain('-i');
      expect.soft(first?.launched?.[first.launched.indexOf('-i') + 1] ?? '').toContain('TASK-ONE');
      expect.soft(first?.launched?.join(' ') ?? '').toContain('--approval-mode yolo');
      expect.soft(first?.launched?.join(' ') ?? '').toContain('-m deepseek-v4-flash');
      expect.soft(first?.launched?.join(' ') ?? '', 'the effort on the command line').not.toContain('high');
      expect.soft(first?.hashes?.DEEPSEEK_API_KEY, 'its key under its model\'s envKey').toBe(sha(KEY));
      expect.soft(first?.launched?.join(' ') ?? '').not.toContain(KEY);
      const s = (first?.settings ?? {}) as { hooks?: Record<string, unknown>; mcpServers?: Record<string, unknown>; model?: unknown; general?: unknown };
      expect.soft(Object.keys(s.hooks ?? {}).sort()).toEqual(expect.arrayContaining(['Notification', 'PermissionRequest', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit']));
      expect.soft(Object.keys(s.mcpServers ?? {})).toContain('claude-mgr-orchestrator');
      expect.soft(s.model).toEqual({ reasoningEffort: 'high' });
      expect.soft(s.general).toEqual({ enableAutoUpdate: false });
      expect.soft(JSON.stringify(s)).not.toMatch(new RegExp(`${KEY}|TOKEN`));

      // 4. A second task, into the same session, and a report back through Tars's MCP server.
      const two = await lead.call('delegate_task', { id: 'qw', prompt: 'TASK-SENDBACK report to me when done', timeoutSeconds: 120 });
      await expect.poll(() => (fs.existsSync(leadReceived) ? fs.readFileSync(leadReceived, 'utf8') : ''), { timeout: 30_000 }).toContain('REPORT-FROM-QWEN');
      const leadLine = fs.readFileSync(leadReceived, 'utf8').split(/\r|\n|\x1b\[20[01]~/).find((l) => l.includes('REPORT-FROM-QWEN')) ?? '';
      keep({ two, leadLine, sent: records().find((r) => r.sent)?.sent });
      expect.soft(two.isError, two.text).toBe(false);
      expect.soft(launches(), 'one session for both tasks').toHaveLength(1);
      expect.soft(leadLine).toContain('Message from agent "Qwen Worker" ("qw")');

      // 5. A permission it asks for, as the window reads it.
      const perm = lead.call('delegate_task', { id: 'qw', prompt: 'TASK-PERM run the shell command', timeoutSeconds: 120 });
      await expect.poll(async () => { const a = await qwNow(); return `${a.status}/${a.waitingReason ?? ''}`; }, { timeout: 30_000 }).toBe('waiting/permission');
      const permAnswer = await perm;
      keep({ permAnswer });
      expect.soft(permAnswer.text).toContain('answer for TASK-PERM');

      // 7. Usage by task.
      const report = await page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 1 }));
      const qwTasks = report.tasks.filter((t) => t.agentId === 'qw');
      keep({ qwTasks });
      expect.soft(qwTasks.length).toBeGreaterThanOrEqual(3);
      expect.soft(qwTasks.every((t) => (t.costUSD ?? 0) > 0), 'a task of qw\'s with no cost').toBe(true);

      // 6. Tars restarted: qw continues its conversation.
      const sid = launches()[0].sid!;
      for (const s2 of servers) s2.kill();
      servers.length = 0;
      await app.close();
      app = await launch();
      page = await open(app);
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'qw', prompt: '' }));
      await expect.poll(() => launches().length, { timeout: 60_000 }).toBe(2);
      const again = launches()[1];
      keep({ sid, again: again.launched });
      expect.soft(again.launched?.join(' ') ?? '').toContain(`--resume ${sid}`);

      // 1, again: the user's file was never written.
      expect.soft(fs.readFileSync(qwenSettingsFile, 'utf8')).toBe(qwenSettingsBefore);
      expect.soft(fs.readdirSync(path.join(home, '.qwen')).sort()).toEqual(['projects', 'settings.json']);
    } finally {
      for (const s of servers) s.kill();
      await app.close().catch(() => undefined);
      if (fs.existsSync(path.join(home, 'qwen-stand-in.jsonl'))) fs.copyFileSync(path.join(home, 'qwen-stand-in.jsonl'), test.info().outputPath('qwen-stand-in.jsonl'));
      await removeHome(home);
    }
  });
}
