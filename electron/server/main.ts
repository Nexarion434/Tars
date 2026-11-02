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

  const { API_PORT, DATA_DIR, privatePath } = await import('../constants');
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

  // systemd and docker stop a service with SIGTERM: the desktop's quit, before-quit steps included.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => electron.app.quit());
  }

  await import('../main');

  // The door for the server's clients, beside the boot: it reads the fleet at
  // each request, so a request before the agents are loaded sees fewer.
  const { CLOUD_DOOR_PORT } = await import('../constants');
  const { agents } = await import('../core/agent-manager');
  const { startDoor } = await import('../services/cloud/door');
  const { fleetAnswer } = await import('../services/cloud/fleet-source');
  const { serverIdentity } = await import('../services/cloud/server-identity');
  const identity = serverIdentity(privatePath('cloud-server.json'));
  try {
    const door = await startDoor({
      port: CLOUD_DOOR_PORT,
      clientsFile: privatePath('cloud-clients.json'),
      identity: () => ({ ...identity, version: electron.app.getVersion() }),
      fleet: client => fleetAnswer(client, identity, agents.values()),
    });
    console.log(`[cloud] door on 127.0.0.1:${door.port}`);
  } catch (err) {
    // The agents keep running; only the clients cannot reach them, which status says.
    console.error(`[cloud] the door could not open on 127.0.0.1:${CLOUD_DOOR_PORT}: ${(err as Error).message}`);
  }
}

if (require.main === module) void serve({ dev: process.argv.includes('--dev') });
