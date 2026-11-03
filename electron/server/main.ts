/**
 * tars-server: Tars without a window, under plain Node (no Electron, no
 * display), for a machine that keeps the agents running while the desktops
 * come and go (docs/superpowers/plans/2026-11-02-tars-cloud.md).
 *
 * It answers `require('electron')` with the headless module before anything
 * else is loaded, claims the data folder (lock.ts), then runs main.ts itself:
 * the same boot as the desktop's, which skips its window steps here
 * (host/headless.ts). The install root is the checkout this file was compiled
 * in: electron/dist/server/main.js.
 *
 *   node electron/dist/server/main.js [--dev]      (or cli.js serve)
 *
 * It stays in the foreground and ends on SIGTERM, which is what a systemd unit
 * and a container's entry both expect.
 */
import * as path from 'path';
import { createHeadlessElectron } from '../host/headless-electron';
import { installHeadlessElectron } from '../host/install-headless';
import type { ServerRecord } from './lock';
import type { NewAgentFields } from '../core/agent-create';
import type { AppSettings } from '../types';

export const INSTALL_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Said by whoever starts the server: `start` (cli) and the unit (systemd) set
 * TARS_SERVER_STARTED_BY. Not INVOCATION_ID, which systemd hands down to
 * everything a unit starts (a CI runner's jobs, a shell under a service).
 */
function startedBy(): ServerRecord['startedBy'] {
  const said = process.env.TARS_SERVER_STARTED_BY;
  return said === 'cli' || said === 'systemd' ? said : 'shell';
}

export async function serve(opts: { dev: boolean }): Promise<void> {
  // A Tars server is for Linux (SECURITY.md section 8): its door is a Unix socket only its user can open. On
  // Windows only a development run serves, for the tests on a developer's machine.
  if (process.platform === 'win32' && !opts.dev) {
    console.error('tars-server runs on Linux; on Windows only a development run (--dev) serves.');
    process.exit(1);
  }
  const electron = createHeadlessElectron({
    root: INSTALL_ROOT,
    dev: opts.dev,
    log: line => console.log(line),
    exit: code => process.exit(code),
  });
  installHeadlessElectron(electron);

  // A packaged Tars finds its bundled MCP servers under Electron's
  // process.resourcesPath; a server's are in the checkout, laid out the same way.
  const withResources = process as NodeJS.Process & { resourcesPath?: string };
  withResources.resourcesPath ??= INSTALL_ROOT;

  const { API_PORT, DATA_DIR, PRIVATE_DIR, privatePath } = await import('../constants');
  const { claimDataFolder, refusal } = await import('./lock');
  const claim = await claimDataFolder({
    file: privatePath('server.json'),
    apiPort: API_PORT,
    record: { version: electron.app.getVersion(), startedAt: new Date().toISOString(), startedBy: startedBy() },
  });
  if (!claim.ok) {
    console.error(refusal(claim, DATA_DIR));
    process.exit(1);
  }
  process.on('exit', () => claim.release());

  // The door's place checked before main.ts loads: a door that can never open (a file or a link at its path, a
  // folder others can enter) ends the server before it restarts any agent, so a restart loop restarts none.
  const { doorSocketPath, prepareDoorSocket } = await import('../services/cloud/door-socket');
  const socketPath = doorSocketPath(PRIVATE_DIR);
  try {
    await prepareDoorSocket(socketPath);
  } catch (err) {
    console.error(`[cloud] the door cannot open on ${socketPath}: ${(err as Error).message}`);
    process.exit(1);
  }

  // systemd and docker stop a service with SIGTERM: the desktop's quit, before-quit steps included.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => electron.app.quit());
  }

  await import('../main');

  // The door for the server's clients, beside the boot: it reads the fleet at
  // each request, so a request before the agents are loaded sees fewer.
  const { recordDoor } = await import('./lock');
  const { agents } = await import('../core/agent-manager');
  const { ptyProcesses } = await import('../core/pty-manager');
  const { cliRunningIn } = await import('../core/agent-pty');
  const { terminalSnapshot } = await import('../core/terminal-mirror');
  const { onAgentOutput } = await import('../core/agent-output');
  const { writeHumanInput, writeProgrammaticInput } = await import('../core/pty-manager');
  const { launchAgent } = await import('../core/agent-launch');
  const { stopAgent } = await import('../core/agent-stop');
  const { saveAgents } = await import('../core/agent-manager');
  const { scheduleTick } = await import('../utils/agents-tick');
  const { rememberPanelSize, resizeTerminalMirror } = await import('../core/terminal-mirror');
  const { executeDrive } = await import('../services/cloud/drive');
  const { memoryHeadroom, DEFAULT_FLOOR_MB } = await import('../platform/memory-headroom');
  const { createProject, listProjects } = await import('../services/cloud/projects');
  const { gitKey } = await import('../services/cloud/git-access');
  const { createAgentRecord } = await import('../core/agent-create');
  const { readAppSettingsFromDisk } = await import('../providers/cli-provider');
  const minFreeMb = () => {
    const set = Number((readAppSettingsFromDisk() as { cloudMinFreeMb?: unknown }).cloudMinFreeMb);
    return Number.isInteger(set) && set > 0 ? set : DEFAULT_FLOOR_MB;
  };
  const { startDoor } = await import('../services/cloud/door');
  const { fleetAnswer } = await import('../services/cloud/fleet-source');
  const { serverIdentity } = await import('../services/cloud/server-identity');
  const identity = serverIdentity(privatePath('cloud-server.json'));
  const terminalOf = (agent: { ptyId?: string }) => (agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined);
  try {
    const door = await startDoor({
      socketPath,
      clientsFile: privatePath('cloud-clients.json'),
      identity: () => ({ ...identity, version: electron.app.getVersion() }),
      fleet: client => fleetAnswer(client, identity, agents.values(), agent => {
        const pty = terminalOf(agent);
        return pty ? { cliRunning: cliRunningIn(pty), cols: pty.cols, rows: pty.rows } : { cliRunning: false };
      }),
      // What agent:get replays to a window: the terminal's screen as it shows now.
      screenOf: agentId => {
        const agent = agents.get(agentId);
        if (!agent) return null;
        const pty = terminalOf(agent);
        return { screen: terminalSnapshot(pty) ?? '', cliRunning: cliRunningIn(pty), cols: pty?.cols ?? 80, rows: pty?.rows ?? 24 };
      },
      onOutput: onAgentOutput,
      // Projects and agents made from a client with `create` (M3): the same functions the server's CLI calls.
      create: {
        projects: () => listProjects(),
        project: (name, from) => createProject(name, from, { gitAccess: { dir: privatePath('git'), serverId: identity.id } }),
        agent: async fields => {
          const made = createAgentRecord(fields as unknown as NewAgentFields, {
            agents, saveAgents, appSettings: () => readAppSettingsFromDisk() as unknown as AppSettings, announce: () => scheduleTick(),
          });
          return made.ok ? { ok: true as const, agent: { id: made.agent.id, name: made.agent.name ?? made.agent.id } } : made;
        },
        gitKey: () => gitKey({ dir: privatePath('git'), serverId: identity.id }),
      },
      // The window's own path: agent:input (writeHumanInput) and agent:resize.
      drive: (request, caller) => executeDrive(request, caller, {
        hasAgent: agentId => agents.has(agentId),
        typeKeys: (agentId, data) => {
          const pty = terminalOf(agents.get(agentId) ?? {});
          if (!pty) return 'no-terminal';
          writeHumanInput(pty, data);
          return 'ok';
        },
        resize: (agentId, cols, rows) => {
          rememberPanelSize(agentId, cols, rows);
          const pty = terminalOf(agents.get(agentId) ?? {});
          if (!pty) return 'no-terminal';
          pty.resize(cols, rows);
          resizeTerminalMirror(pty, cols, rows);
          return 'ok';
        },
        // agent:start, with no first prompt.
        start: async agentId => {
          try {
            const launched = await launchAgent(agentId, '');
            return launched.success ? { ok: true as const } : { ok: false as const, error: launched.error ?? 'The agent did not start.' };
          } catch (err) {
            // launchAgent throws a LaunchError for a CLI it cannot start: its sentence says why.
            return { ok: false as const, error: (err as Error).message };
          }
        },
        // agent:stop, filed under the client.
        stop: async (agentId, by, reason) => {
          const agent = agents.get(agentId);
          if (agent) await stopAgent(agent, { by, reason }, { save: saveAgents, announce: () => scheduleTick() });
        },
        // A message as Tars types one, after the client's own sender line.
        message: (agentId, text, sender) => {
          const pty = terminalOf(agents.get(agentId) ?? {});
          if (!pty) return 'no-terminal';
          if (!cliRunningIn(pty)) return 'not-running';
          writeProgrammaticInput(pty, text, true, { agentId, from: sender.kind === 'machine' || sender.kind === 'outside-agent' ? sender.name : 'Tars', sender });
          return 'ok';
        },
        // Every start leaves the floor free (M3 Task 3): read now, the floor from the server's settings.
        memory: { headroom: () => memoryHeadroom(), floorMb: minFreeMb() },
      }),
    });
    recordDoor(privatePath('server.json'), door.path);
    // A credential minted while the server runs, by SSH or by anything running as its user (its own agents
    // included), is said in its log: the clients list says where it came from.
    const { watchClients } = await import('../services/cloud/clients');
    watchClients(privatePath('cloud-clients.json'), () => {}, 1000, client => {
      console.log(`[cloud] a client was minted: ${client.name} (${client.id}, ${client.kind}, ${client.scopes.join(' ')}), ${client.mintedVia ?? 'from an unknown place'}`);
    });
    console.log(`[cloud] door on ${door.path}`);
  } catch (err) {
    // Fatal: a server without its door serves no client, and a door that did not open may be one another
    // process holds. A non-zero exit lets systemd (or the container) try again.
    console.error(`[cloud] the door could not open on ${socketPath}: ${(err as Error).message}`);
    electron.app.exit(1);
  }
}

if (require.main === module) void serve({ dev: process.argv.includes('--dev') });
