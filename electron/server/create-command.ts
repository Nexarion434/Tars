import * as http from 'http';
import { addClient, revokeClient } from '../services/cloud/clients';

/**
 * tars-server projects add --json | agents add --json
 * (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md, Task 5), for the
 * operator, over SSH or on the server: what the real test of 2026-11-03 had
 * to do by hand, the server stopped and agents.json written.
 *
 * The running server makes them, never this process: the CLI holds the
 * authority that mints (SSH access, as `clients add`), so it mints itself a
 * client for this one call, sends the input to the door's create route over
 * the door's socket (the same checks, the running server's fleet and
 * agents.json), prints the door's answer, and revokes the client whatever
 * happened. The input is a JSON object on stdin, never on the command line.
 *
 * One JSON line on `out`; errors on stderr. Exit codes: 0 done, 1 refused,
 * 2 usage.
 */

export interface CreateCommandDeps {
  clientsFile: string;
  /** The door's socket (server.json's `door`). */
  socketPath: string;
  serverRunning(): boolean;
}

const ROUTES = { projects: '/cloud/v1/projects', agents: '/cloud/v1/agents' } as const;

function post(socketPath: string, urlPath: string, body: string, credential: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath, path: urlPath, method: 'POST', timeout: 15 * 60_000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${credential}` },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text.slice(0, 200) }; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('The server took too long to answer.')));
    req.on('error', reject);
    req.end(body);
  });
}

export async function runCreateCommand(
  what: keyof typeof ROUTES,
  args: string[],
  stdin: string,
  deps: CreateCommandDeps,
  out: (line: string) => void,
): Promise<number> {
  const [verb, ...rest] = args;
  if (verb !== 'add') {
    process.stderr.write(`usage: tars-server ${what} add --json < input\n`);
    return 2;
  }
  if (rest.some(a => !a.startsWith('--'))) {
    process.stderr.write(`The input goes on stdin: tars-server ${what} add --json < input\n`);
    return 1;
  }
  let input: unknown;
  try { input = JSON.parse(stdin); } catch { input = null; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    process.stderr.write('The input is a JSON object, on stdin.\n');
    return 1;
  }
  // A clone only on the operator's own flag (security review 1, B1): a `trusted` in the input is not taken for it.
  const from = (input as { from?: unknown }).from;
  if (what === 'projects' && from && typeof from === 'object' && (from as { kind?: unknown }).kind === 'git') {
    if (!rest.includes('--trust-code')) {
      process.stderr.write('A repository is cloned only once you trust its code: its settings can run code on this server as soon as an agent starts in it. Add --trust-code if you do.\n');
      return 1;
    }
    input = { ...(input as object), from: { ...(from as object), trusted: true } };
  }
  if (!deps.serverRunning()) {
    process.stderr.write('The Tars server is not running: start it first (tars-server start). Nothing was made.\n');
    return 1;
  }

  const { client, credential } = addClient(deps.clientsFile, { name: 'tars-server cli', kind: 'desktop', scopes: ['see', 'drive', 'create'], via: 'on the server (cli)' });
  try {
    const answer = await post(deps.socketPath, ROUTES[what], JSON.stringify(input), credential);
    if (answer.status >= 200 && answer.status < 300) {
      out(JSON.stringify(answer.body));
      return 0;
    }
    process.stderr.write(`${String(answer.body.error ?? `The server answered ${answer.status}.`)}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  } finally {
    revokeClient(deps.clientsFile, client.id);
  }
}
