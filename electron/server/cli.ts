/**
 * The tars-server command (plan Task 4):
 *
 *   node electron/dist/server/cli.js serve [--dev]   the server, in the foreground
 *   node electron/dist/server/cli.js start [--json]  start it unless it runs
 *   node electron/dist/server/cli.js status [--json] whether it runs, from its record
 *
 * `start` and `status` write exactly one JSON line on stdout and nothing else
 * (a desktop reads it over SSH); what they have to say goes to stderr.
 */
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const UNIT = 'tars-server.service';

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function hasUnit(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('systemctl', ['--user', 'cat', UNIT], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function run(command: string | undefined, args: string[]): Promise<number> {
  if (command === 'serve') {
    const { serve } = await import('./main');
    await serve({ dev: args.includes('--dev') });
    return -1;
  }
  const { DATA_DIR, privatePath } = await import('../constants');
  const { serverStatus } = await import('./lock');
  const file = privatePath('server.json');
  if (command === 'status') {
    printJson(serverStatus(file));
    return 0;
  }
  if (command === 'start') {
    const { startServer } = await import('./start');
    try {
      printJson(await startServer({
        status: () => serverStatus(file),
        hasUnit,
        startUnit: () => execFileSync('systemctl', ['--user', 'start', UNIT], { stdio: 'ignore' }),
        spawnDetached: () => {
          const logs = path.join(DATA_DIR, 'logs');
          fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
          const log = fs.openSync(path.join(logs, 'server.log'), 'a', 0o600);
          spawn(process.execPath, [path.join(__dirname, 'main.js')], {
            detached: true,
            stdio: ['ignore', log, log],
            env: { ...process.env, TARS_SERVER_STARTED_BY: 'cli' },
          }).unref();
        },
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      }));
      return 0;
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return 1;
    }
  }
  process.stderr.write('usage: tars-server serve [--dev] | start [--json] | status [--json]\n');
  return 2;
}

void run(process.argv[2], process.argv.slice(3)).then(code => {
  if (code >= 0) process.exit(code);
});
