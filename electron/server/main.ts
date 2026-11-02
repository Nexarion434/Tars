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

function startedBy(): ServerRecord['startedBy'] {
  if (process.env.TARS_SERVER_STARTED_BY === 'cli') return 'cli';
  // systemd sets INVOCATION_ID in every unit it starts.
  if (process.env.INVOCATION_ID) return 'systemd';
  return 'shell';
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
}

if (require.main === module) void serve({ dev: process.argv.includes('--dev') });
