/**
 * tars-server: Tars without a window, under plain Node (no Electron, no
 * display), for a machine that keeps the agents running while the desktops
 * come and go (docs/superpowers/plans/2026-11-02-tars-cloud.md).
 *
 * It answers `require('electron')` with the headless module before anything
 * else is loaded, then runs main.ts itself: the same boot as the desktop's,
 * which skips its window steps here (host/headless.ts). The install root is
 * the checkout this file was compiled in: electron/dist/server/main.js.
 *
 *   node electron/dist/server/main.js [--dev]
 */
import * as path from 'path';
import { createHeadlessElectron } from '../host/headless-electron';
import { installHeadlessElectron } from '../host/install-headless';

const root = path.resolve(__dirname, '..', '..', '..');
const dev = process.argv.includes('--dev');

const electron = createHeadlessElectron({
  root,
  dev,
  log: line => console.log(line),
  exit: code => process.exit(code),
});
installHeadlessElectron(electron);

// A packaged Tars finds its bundled MCP servers under Electron's
// process.resourcesPath; a server's are in the checkout, laid out the same way.
const withResources = process as NodeJS.Process & { resourcesPath?: string };
withResources.resourcesPath ??= root;

// systemd stops a service with SIGTERM: the desktop's quit, before-quit steps included.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => electron.app.quit());
}

void import('../main');
