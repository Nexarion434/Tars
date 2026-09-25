// E2E on the real app (win/hooks-node): the sandboxed Electron main process writes the win32 hook
// wiring, and a fake CLI runs the configured commands through Git Bash and PowerShell against the
// app's own API. Writes values.json and command.txt into the run directory.
//
// Usage (from the repo root, in the safe shell of .claude/win-port/CONVENTIONS.md, after
// `npx tsc -p electron/tsconfig.json`): node __tests__/hooks/app-hooks-e2e.mjs <runDir>
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const WORKTREE = process.cwd();
const runDir = path.resolve(process.argv[2]);
fs.mkdirSync(runDir, { recursive: true });
const sb = process.env.USERPROFILE; // the safe shell's sandbox
if (!sb || !sb.includes('tars-sb-')) throw new Error(`refusing to run outside a sandbox USERPROFILE: ${sb}`);
const PORT = 31517;
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const AGENT = 'e2e-hook-agent';
const S = '0e2e0000-1111-4222-8333-444444444444';
const project = path.join(sb, 'Claude Project', 'proj');
const values = { sandbox: sb, port: PORT, startedAt: new Date().toISOString() };

// Seed: one idle claude agent, no autostart (its PTY cannot spawn on win32 yet: /bin/bash, audit A1),
// the status line on.
fs.mkdirSync(path.join(sb, '.dorothy'), { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(sb, '.dorothy', 'agents.json'), JSON.stringify([{
  id: AGENT, name: 'E2E Hooks', status: 'idle', provider: 'claude', projectPath: project, skills: [], output: [],
  lastActivity: new Date().toISOString(),
}], null, 2));
fs.writeFileSync(path.join(sb, '.dorothy', 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, statusLineEnabled: true }, null, 2));

const electronExe = path.join(WORKTREE, 'node_modules', 'electron', 'dist', 'electron.exe');
const appEnv = { ...process.env, DOROTHY_API_PORT: String(PORT), DOROTHY_E2E: '1', DOROTHY_DEV_URL: 'http://127.0.0.1:1' };
for (const k of Object.keys(appEnv)) if (/^(CLAUDE_|ANTHROPIC_)/.test(k)) delete appEnv[k];
const app = spawn(electronExe, ['.', `--user-data-dir=${path.join(sb, 'profile')}`], { cwd: WORKTREE, env: appEnv, windowsHide: true });
let appLog = '';
app.stdout.on('data', d => { appLog += d; });
app.stderr.on('data', d => { appLog += d; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitHealth() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(500);
  }
  return false;
}

function run(exe, args, env, stdin) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(exe, args, { env, windowsHide: true });
    let out = ''; let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, stdout: out, stderr: err, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}
const viaGitBash = (cmd, env, stdin) => run(GIT_BASH, ['-c', cmd], env, stdin);
const viaPowerShell = (cmd, env, stdin) => run('powershell.exe', ['-NoProfile', '-Command', `${cmd}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`], env, stdin);

try {
  values.healthy = await waitHealth();
  if (!values.healthy) throw new Error('the app never answered /api/health');
  await sleep(3000); // configureStatusHooks runs after the server is up

  const claude = JSON.parse(fs.readFileSync(path.join(sb, '.claude', 'settings.json'), 'utf8'));
  const gemini = JSON.parse(fs.readFileSync(path.join(sb, '.gemini', 'settings.json'), 'utf8'));
  values.claudeHooks = Object.fromEntries(Object.entries(claude.hooks).map(([k, v]) => [k, v.map(e => e.hooks.map(h => h.command))]));
  values.claudeStatusLine = claude.statusLine;
  values.geminiHooks = Object.fromEntries(Object.entries(gemini.hooks).map(([k, v]) => [k, v.map(e => e.hooks.map(h => h.command))]));
  values.geminiSecurity = gemini.security;
  values.noShInSettings = !JSON.stringify(claude.hooks).includes('.sh') && !JSON.stringify(gemini.hooks).includes('.sh');
  values.statuslineShInstalled = fs.existsSync(path.join(sb, '.dorothy', 'statusline.sh'));

  const hookEnv = {
    ...process.env, HOME: sb, USERPROFILE: sb, CLAUDE_MGR_API_URL: `http://127.0.0.1:${PORT}`,
    CLAUDE_AGENT_ID: AGENT, CLAUDE_PROJECT_PATH: project,
    // No terminal token can exist: the agent's PTY cannot spawn on win32 until win/platform-launch.
    CLAUDE_MGR_API_TOKEN: 'no-terminal-token-on-win32-yet',
  };
  const cmd = type => claude.hooks[type][0].hooks[0].command;
  values.runs = [];
  for (const [shell, via] of [['git-bash', viaGitBash], ['powershell', viaPowerShell]]) {
    for (const [type, payload] of [
      ['SessionStart', { session_id: S, cwd: project, source: 'startup', hook_event_name: 'SessionStart' }],
      ['UserPromptSubmit', { session_id: S, prompt: 'hello from the fake CLI', hook_event_name: 'UserPromptSubmit' }],
      ['Stop', { session_id: S, last_assistant_message: 'done', hook_event_name: 'Stop' }],
    ]) {
      const r = await via(cmd(type), hookEnv, JSON.stringify(payload));
      values.runs.push({ shell, type, code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim(), ms: r.ms });
    }
  }
  const hooksLog = fs.readFileSync(path.join(sb, '.dorothy', 'logs', 'hooks.log'), 'utf8');
  values.hooksLogResults = hooksLog.split('\n').filter(l => l.includes('curl result'));

  const shared = fs.readFileSync(path.join(sb, '.dorothy', 'api-token'), 'utf8').trim();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/api/agents?all=true`, { headers: { Authorization: `Bearer ${shared}` } })).json();
  values.agentAfter = (list.agents ?? list).find(a => a.id === AGENT);

  const payload = JSON.stringify({
    session_id: S, model: { model_id: 'claude-opus-4', display_name: 'Opus' },
    context_window: { total_input_tokens: 1500, total_output_tokens: 250, used_percentage: 12, context_window_size: 200000 },
    cost: { total_cost_usd: 0.01, total_duration_ms: 5000, total_lines_added: 1, total_lines_removed: 0 },
    rate_limits: { five_hour: { used_percentage: 3 } },
  });
  values.statusline = [];
  for (const [shell, via] of [['git-bash', viaGitBash], ['powershell', viaPowerShell]]) {
    const r = await via(claude.statusLine.command, { ...hookEnv }, payload);
    values.statusline.push({ shell, code: r.code, line: r.stdout.replace(/\x1b\[[0-9;]*m/g, ''), stderr: r.stderr.trim() });
  }
  values.tokenStats = JSON.parse(fs.readFileSync(path.join(sb, '.dorothy', 'token-stats.json'), 'utf8'));
  values.rateLimits = fs.readFileSync(path.join(sb, '.dorothy', 'rate-limits.json'), 'utf8');
} catch (error) {
  values.error = String(error?.stack ?? error);
} finally {
  app.kill();
  await sleep(1000);
  values.appLogTail = appLog.split('\n').filter(l => /hooks|statusline|Gemini|Claude hooks/i.test(l)).slice(-20);
  fs.writeFileSync(path.join(runDir, 'values.json'), JSON.stringify(values, null, 2));
  fs.writeFileSync(path.join(runDir, 'command.txt'),
    `commit ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WORKTREE }).toString().trim()} (branch win/hooks-node), ${WORKTREE}\n`
    + 'safe shell (CONVENTIONS.md), then: npx tsc -p electron/tsconfig.json; node __tests__/hooks/app-hooks-e2e.mjs <runDir>\n'
    + `windows ${os.release()}, node ${process.version}\n`);
  console.log(JSON.stringify(values, null, 2));
}
