import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { Agent as UndiciAgent } from 'undici';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * delegate_task outlives the cut of a request held too long (2.0.4).
 *
 * The defect: delegate_task held one POST /api/agents/:id/run-task open for the whole run over ACP, and Node's fetch
 * (undici) cuts a request that has had no response headers for 300 s as "fetch failed". The tool read that as "no run
 * started" and sent the task to /dispatch: typed into the terminal as a second copy before receipts, and since them
 * refused as a clientRequestId conflict, the caller told "nothing was sent" while the run kept working. And the
 * tool's `model` never reached a run over ACP.
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server (mcp-orchestrator/dist/bundle.js) run with the
 * identity Tars hands agent `lead`, spoken to over stdio as Claude Code speaks to it. Between the two, a proxy that
 * forwards every request through undici itself with a headersTimeout of CUT_S, and cuts the caller's connection when
 * undici gives up: the 300 s cut, brought down to CUT_S, which stays above the tool's 120 s segment as 300 s does.
 * Agent `oc` is an opencode agent whose CLI is a fake ACP agent: its one turn lasts RUN_S, longer than CUT_S, and it
 * records every message it gets and every launch.
 *
 * Asserted, once with the classic shell and once with the new interface:
 * 1. the caller gets the run's real answer, its stop reason, tokens, cost and task, and no error;
 * 2. one run: one launch of the fake agent, one prompt, one task over ACP in the ledger;
 * 3. nothing for the terminal: no /dispatch and no /message went through, and `oc` has no terminal;
 * 4. no request was cut, and none was held longer than the 120 s segment plus its margin;
 * 5. the model given to delegate_task reached the run (session/set_config_option), and `oc`'s saved model is unchanged.
 * Red on 5be221a2 (2.0.3): run-task is held for the whole run, cut at CUT_S, and the tool goes to /dispatch, refused.
 * The artefact: values.json (the tool's answer, every request through the proxy, the fake agent's log, the ledger's
 * tasks, agents.json's record of oc), a screenshot of the Usage page, the app's trace with E2E_TRACE=on.
 */

const CUT_S = 130;
const RUN_S = 140;
const SEGMENT_S = 120;

/** A fake ACP agent, launched as `opencode acp`: offers a model option, and its one turn lasts RUN_S. */
const FAKE_ACP = String.raw`
const fs = require('fs');
const log = (entry) => fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
log({ launched: process.argv.slice(2) });
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(msg) {
  if (msg.method) log({ method: msg.method, params: msg.method === 'session/prompt' ? { text: msg.params.prompt?.[0]?.text } : msg.params });
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-1', configOptions: [{ id: 'model', name: 'Model' }] } });
  }
  if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the real answer: release notes reviewed' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'usage_update', inputTokens: 500, outputTokens: 100, used: 600, cost: { amount: 0.75, currency: 'USD' } } } });
    return setTimeout(() => {
      log({ answered: 'session/prompt' });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 100 } } });
    }, ${RUN_S} * 1000);
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
}
process.stdin.resume();
`;

type Seen = { method: string; path: string; startedAt: string; heldMs: number; status?: number; cut?: string; body?: unknown };

/** Forwards to Tars through undici with a headersTimeout of CUT_S, and cuts the caller when undici gives up. */
function cuttingProxy(upstream: string) {
  const dispatcher = new UndiciAgent({ headersTimeout: CUT_S * 1000, bodyTimeout: 0 });
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const started = Date.now();
      const raw = Buffer.concat(chunks);
      const entry: Seen = { method: req.method ?? '', path: req.url ?? '', startedAt: new Date(started).toISOString(), heldMs: 0 };
      if (raw.length) {
        try { entry.body = JSON.parse(raw.toString('utf8')); } catch { entry.body = raw.toString('utf8').slice(0, 300); }
      }
      seen.push(entry);
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))) as Record<string, string>;
      try {
        const answer = await fetch(upstream + req.url, { method: req.method, headers, body: raw.length ? raw : undefined, dispatcher } as RequestInit);
        const body = Buffer.from(await answer.arrayBuffer());
        entry.heldMs = Date.now() - started;
        entry.status = answer.status;
        res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
        res.end(body);
      } catch (err) {
        entry.heldMs = Date.now() - started;
        entry.cut = `${(err as Error).message} (${((err as { cause?: { code?: string } }).cause?.code) ?? 'no code'})`;
        req.socket.destroy();
      }
    });
  });
  return { server, seen, dispatcher };
}

type Api = { electronAPI: {
  agent: { list(): Promise<Array<{ id: string; cliRunning?: boolean; ptyId?: string }>> };
  usage: { tasks(q?: { sinceDays?: number }): Promise<{ tasks: Array<{ id: string; agentId: string; source: string; outcome: string; text: string; costUSD: number | null }> }> };
} };

for (const newInterface of [false, true]) {
  test(`delegate_task outlives a request cut and returns the one run's real result${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout((RUN_S + 180) * 1000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-delegate-drop-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.dorothy');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const acpLog = path.join(home, 'fake-acp.jsonl');
    fs.writeFileSync(path.join(bin, 'opencode'), `#!${process.execPath}\nprocess.env.FAKE_ACP_LOG = ${JSON.stringify(acpLog)};\n${FAKE_ACP}`, { mode: 0o755 });
    const agent = (id: string, name: string, role: string, provider: string, model?: string) => ({
      id, name, character: 'robot', provider, status: 'idle', role, projectPath: project, skills: [], permissionMode: 'normal',
      ...(model ? { model } : {}), createdAt: '2026-10-17T08:00:00.000Z', lastActivity: '2026-10-17T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('lead', 'Project Lead', 'orchestrator', 'claude'), agent('oc', 'Review Agent', 'worker', 'opencode', 'saved-model'),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    // The fake `opencode` first on every launch's PATH, and the ACP table fresh, so nothing is fetched or run from npm.
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [bin] }, newInterface,
    }));
    fs.writeFileSync(path.join(dir, 'acp-registry.json'), JSON.stringify({ fetchedAt: Date.now(), agents: { opencode: { id: 'opencode', name: 'opencode', version: 'local', command: 'opencode', args: ['acp'] } } }));
    const port = apiPort(newInterface ? 31433 : 31447);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface, cutSeconds: CUT_S, runSeconds: RUN_S, segmentSeconds: SEGMENT_S };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const proxy = cuttingProxy(`http://127.0.0.1:${port}`);
    await new Promise<void>((r) => proxy.server.listen(0, '127.0.0.1', r));
    const proxyPort = (proxy.server.address() as { port: number }).port;

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    let mcp: ChildProcessWithoutNullStreams | undefined;
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      // The shell this run is in: the new one has its main menu.
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      // What Tars hands lead's tools: a token naming lead, and the instance they check before sending it.
      const identity = await app.evaluate((_e, { dist }) => {
        const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
        return { token: tokens.mintRunToken('lead').token as string, instance: tokens.tarsInstanceId() as string };
      }, { dist });
      mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
        env: {
          PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${proxyPort}`, CLAUDE_MGR_API_TOKEN: identity.token,
          CLAUDE_AGENT_ID: 'lead', CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance,
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
        mcp!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      const askedAt = Date.now();
      const reply = await rpc('tools/call', {
        name: 'delegate_task',
        arguments: { id: 'oc', prompt: 'review the release notes', model: 'task-model-x', timeoutSeconds: 600, clientRequestId: 'e2e-delegate-drop-1' },
      });
      const answer = { text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
      const tookS = Math.round((Date.now() - askedAt) / 1000);

      const acp = fs.existsSync(acpLog) ? fs.readFileSync(acpLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      const report = await page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 1 }));
      const oc = (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find((a) => a.id === 'oc');
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')) as { agents?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
      const ocRecord = (Array.isArray(saved) ? saved : saved.agents ?? []).find((a) => a.id === 'oc');
      keep({ answer, tookS, requests: proxy.seen, fakeAcp: acp, tasks: report.tasks, ocInList: oc, ocRecord });
      await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await stepShot(page, newInterface ? 'usage-new-interface' : 'usage');

      // 1. The run's real result, as a direct answer gives it.
      expect.soft(answer.isError, 'the caller got an error, not the run').toBe(false);
      expect.soft(answer.text).toContain('the real answer: release notes reviewed');
      expect.soft(answer.text).toContain('ended: end_turn');
      expect.soft(answer.text).toContain('600 tokens');
      expect.soft(answer.text).toContain('$0.7500');
      expect.soft(tookS, 'answered before the run ended').toBeGreaterThanOrEqual(RUN_S - 5);
      // 2. One run.
      expect.soft(acp.filter((e) => e.launched).length, 'launches of the fake agent').toBe(1);
      expect.soft(acp.filter((e) => e.method === 'session/prompt').length, 'prompts').toBe(1);
      const runs = report.tasks.filter((t) => t.source === 'acp' && t.agentId === 'oc');
      expect.soft(runs.map((t) => ({ outcome: t.outcome, text: t.text, costUSD: t.costUSD }))).toEqual([{ outcome: 'completed', text: 'review the release notes', costUSD: 0.75 }]);
      expect.soft(answer.text).toContain(`task ${runs[0]?.id}`);
      // 3. Nothing for the terminal.
      expect.soft(proxy.seen.filter((r) => /\/(dispatch|message)$/.test(r.path)).map((r) => r.path), 'sent to the terminal').toEqual([]);
      expect.soft(oc?.cliRunning ?? false, 'oc has a terminal').toBe(false);
      // 4. No request cut, none held past a segment.
      expect.soft(proxy.seen.filter((r) => r.cut).map((r) => `${r.method} ${r.path}: ${r.cut}`), 'cut by undici').toEqual([]);
      expect.soft(Math.max(...proxy.seen.map((r) => r.heldMs)), 'longest request (ms)').toBeLessThan((SEGMENT_S + 5) * 1000);
      expect.soft(proxy.seen.filter((r) => r.path.endsWith('/run-task')).map((r) => (r.body as { clientRequestId?: string }).clientRequestId)).toEqual(['e2e-delegate-drop-1']);
      // 5. The model of this task reached the run, and the agent's own is unchanged.
      expect.soft(acp.filter((e) => e.method === 'session/set_config_option').map((e) => e.params), 'models set on the run')
        .toEqual([{ sessionId: 'acp-1', configId: 'model', value: 'task-model-x' }]);
      expect.soft(ocRecord?.model).toBe('saved-model');
    } finally {
      mcp?.kill();
      await app.close();
      await proxy.dispatcher.close().catch(() => {});
      proxy.server.closeAllConnections();
      await new Promise((r) => proxy.server.close(r));
      if (fs.existsSync(acpLog)) fs.copyFileSync(acpLog, test.info().outputPath('fake-acp.jsonl'));
      await removeHome(home);
    }
  });
}
