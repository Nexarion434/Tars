/**
 * The tars-server command (plan Task 4):
 *
 *   node electron/dist/server/cli.js serve [--dev]   the server, in the foreground
 *   node electron/dist/server/cli.js start [--json]  start it unless it runs
 *   node electron/dist/server/cli.js status [--json] whether it runs, from its record
 *   node electron/dist/server/cli.js clients add --json < { name, kind, scopes, days? }
 *   node electron/dist/server/cli.js clients list --json | clients revoke <id>
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

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
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
  const { privatePath } = await import('../constants');
  const { serverStatus } = await import('./lock');
  const file = privatePath('server.json');
  const { serverIdentity } = await import('../services/cloud/server-identity');
  const serverFile = privatePath('cloud-server.json');
  if (command === 'status') {
    const identity = serverIdentity(serverFile);
    printJson({ ...serverStatus(file), serverId: identity.id, name: identity.name });
    return 0;
  }
  if (command === 'clients') {
    const { runClientsCommand } = await import('./clients-command');
    const stdin = args[0] === 'add' ? await readStdin() : '';
    return runClientsCommand(args, stdin, { clientsFile: privatePath('cloud-clients.json'), serverFile }, line => process.stdout.write(`${line}\n`));
  }
  if (command === 'projects' || command === 'agents') {
    const { runCreateCommand } = await import('./create-command');
    const { doorSocketPath } = await import('../services/cloud/door-socket');
    const { PRIVATE_DIR } = await import('../constants');
    const stdin = args[0] === 'add' ? await readStdin() : '';
    const status = serverStatus(file);
    return runCreateCommand(command, args, stdin, {
      clientsFile: privatePath('cloud-clients.json'),
      socketPath: (status.running && status.door) || doorSocketPath(PRIVATE_DIR),
      serverRunning: () => status.running,
    }, line => process.stdout.write(`${line}\n`));
  }
  if (command === 'git') {
    const { runGitCommand } = await import('./git-command');
    const stdin = args[0] === 'known-host' ? await readStdin() : '';
    return runGitCommand(args, stdin, { dir: privatePath('git'), serverId: serverIdentity(serverFile).id }, line => process.stdout.write(`${line}\n`));
  }
  if (command === 'start') {
    const { detachedEnv, startServer } = await import('./start');
    try {
      printJson(await startServer({
        status: () => serverStatus(file),
        hasUnit,
        startUnit: () => execFileSync('systemctl', ['--user', 'start', UNIT], { stdio: 'ignore' }),
        spawnDetached: () => {
          // In the private folder: the agents are handed ~/.tars, and must not write the server's log.
          const logs = privatePath('logs');
          fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
          const log = fs.openSync(path.join(logs, 'server.log'), 'a', 0o600);
          spawn(process.execPath, [path.join(__dirname, 'main.js')], {
            detached: true,
            stdio: ['ignore', log, log],
            env: detachedEnv(process.env),
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
  process.stderr.write('usage: tars-server serve [--dev] | start [--json] | status [--json] | clients add|list|revoke\n');
  return 2;
}

void run(process.argv[2], process.argv.slice(3)).then(code => {
  if (code >= 0) process.exit(code);
});
