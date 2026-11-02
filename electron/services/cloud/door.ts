import * as http from 'http';
import type { AddressInfo } from 'net';
import { admit, may, watchClients } from './clients';
import type { CloudClient, Scope } from './types';

/**
 * The door of a Tars server (docs/superpowers/plans/2026-11-02-tars-cloud.md,
 * Task 6): a second node:http listener beside the local API, on 127.0.0.1 only.
 * A desktop reaches it through its SSH forward, Hermes from the server itself;
 * nothing on any network does. It admits client credentials alone (never the
 * master API token, which no route reads or returns), each within its scopes,
 * read from the clients file at every request.
 *
 * Every request goes through the same gates, in this order, and the first
 * that fails answers: a caller whose address is not loopback (403); a path
 * that is not a route (404, before any credential is looked at, so no answer
 * tells whether one is good); an Origin header, which only a web page sends
 * (403); a Host other than this loopback port, which is what a page rebinding a
 * name to the forward would send (403); a body over 64 KB (413, unread); then,
 * for every route but hello, the credential (401) and the route's scope (403).
 * Only then is an agent looked up, with one sentence for any it does not know.
 *
 * A stream (one agent's live output, server-sent events) is held by its
 * client: 32 at most each; ended at once when the client is revoked (the
 * clients file is watched), at the next re-check once it expires, and when its
 * reader falls 4 MB behind.
 */

export const MAX_BODY = 64 * 1024;
export const MAX_STREAMS_PER_CLIENT = 32;
export const MAX_BEHIND = 4 * 1024 * 1024;

export interface AgentScreen { screen: string; cliRunning: boolean; cols: number; rows: number }

export interface DoorDeps {
  /** CLOUD_DOOR_PORT; 0 for an ephemeral port (tests). */
  port: number;
  clientsFile: string;
  identity(): { id: string; name: string; version: string };
  fleet(client: CloudClient): unknown;
  /** One agent's terminal as it shows now, or null for an agent the server does not have. */
  screenOf?(agentId: string): AgentScreen | null;
  onOutput?(listener: (agentId: string, chunk: string) => void): () => void;
  /** How often an open stream's credential is admitted again (default 15 s). */
  recheckMs?: number;
  /** How often the clients file is polled for a revoke (default 500 ms). */
  revokePollMs?: number;
  now?: () => number;
}

export interface Door {
  port: number;
  address: string;
  /** Open streams, all clients: for tests and logs. */
  streamCount(): number;
  close(): Promise<void>;
}

interface Request { client: CloudClient | null; credential: string | null; agentId?: string; req: http.IncomingMessage; res: http.ServerResponse }
interface Route { method: string; pattern: RegExp; scope: Scope | null; handle(r: Request): void }

const AGENT_PATH = '([A-Za-z0-9_-]{1,64})';

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return v4 === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

const SCOPE_WORDS: Record<Scope, string> = {
  see: 'see its agents',
  drive: 'drive its agents',
  create: 'create projects and agents',
  files: 'reach its files',
};

const NO_SUCH_AGENT = 'No such agent on this Tars server.';

export function startDoor(deps: DoorDeps): Promise<Door> {
  const now = deps.now ?? Date.now;
  const streams = new Map<string, Set<(reason: string) => void>>();
  const streamCount = () => [...streams.values()].reduce((n, set) => n + set.size, 0);
  const endStreamsOf = (clientId: string, reason: string) => {
    for (const end of [...(streams.get(clientId) ?? [])]) end(reason);
  };
  const stopWatching = watchClients(deps.clientsFile, id => endStreamsOf(id, 'revoked'), deps.revokePollMs ?? 500);

  const openStream = ({ client, credential, agentId, req, res }: Request) => {
    const own = streams.get(client!.id) ?? new Set();
    if (own.size >= MAX_STREAMS_PER_CLIENT) {
      json(res, 429, { error: `${MAX_STREAMS_PER_CLIENT} streams at most for one client.` });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write(': open\n\n');
    let ended = false;
    const end = (reason: string) => {
      if (ended) return;
      ended = true;
      unsubscribe();
      clearInterval(recheck);
      own.delete(end);
      if (own.size === 0) streams.delete(client!.id);
      if (reason === 'slow' || reason === 'closed') {
        res.destroy();
        return;
      }
      res.end(`event: end\ndata: ${JSON.stringify(reason)}\n\n`);
    };
    const unsubscribe = deps.onOutput
      ? deps.onOutput((id, chunk) => {
        if (id !== agentId || ended) return;
        if (res.writableLength > MAX_BEHIND) {
          end('slow');
          return;
        }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      })
      : () => {};
    const recheck = setInterval(() => {
      if (!admit(deps.clientsFile, credential ?? undefined, now())) end('revoked');
      else res.write(': keepalive\n\n');
    }, deps.recheckMs ?? 15_000);
    own.add(end);
    streams.set(client!.id, own);
    req.on('close', () => end('closed'));
  };

  const routes: Route[] = [
    {
      method: 'GET', pattern: /^\/cloud\/v1\/hello$/, scope: null,
      handle: ({ res }) => {
        const { id, name, version } = deps.identity();
        json(res, 200, { v: 1, serverId: id, name, version });
      },
    },
    {
      method: 'GET', pattern: /^\/cloud\/v1\/fleet$/, scope: 'see',
      handle: ({ client, res }) => json(res, 200, deps.fleet(client!)),
    },
    {
      method: 'GET', pattern: new RegExp(`^/cloud/v1/agents/${AGENT_PATH}/screen$`), scope: 'see',
      handle: ({ agentId, res }) => {
        const screen = deps.screenOf?.(agentId!) ?? null;
        if (!screen) json(res, 404, { error: NO_SUCH_AGENT });
        else json(res, 200, screen);
      },
    },
    {
      method: 'GET', pattern: new RegExp(`^/cloud/v1/agents/${AGENT_PATH}/stream$`), scope: 'see',
      handle: request => {
        if (!(deps.screenOf?.(request.agentId!) ?? null)) json(request.res, 404, { error: NO_SUCH_AGENT });
        else openStream(request);
      },
    },
  ];

  const server = http.createServer((req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      json(res, 403, { error: 'This door answers this machine alone.' });
      return;
    }
    const pathname = (req.url ?? '').split('?')[0];
    let route: Route | undefined;
    let agentId: string | undefined;
    for (const candidate of routes) {
      const match = candidate.method === req.method ? candidate.pattern.exec(pathname) : null;
      if (match) {
        route = candidate;
        agentId = match[1];
        break;
      }
    }
    if (!route) {
      json(res, 404, { error: 'Not found.' });
      return;
    }
    if (req.headers.origin !== undefined) {
      json(res, 403, { error: 'No web page may call this door.' });
      return;
    }
    const { port } = server.address() as AddressInfo;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      json(res, 403, { error: 'Wrong host for this door.' });
      return;
    }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) {
      res.setHeader('Connection', 'close');
      json(res, 413, { error: `A request carries ${MAX_BODY / 1024} KB at most.` });
      return;
    }
    if (route.scope === null) {
      route.handle({ client: null, credential: null, agentId, req, res });
      return;
    }
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
    const credential = match ? match[1] : null;
    const client = credential ? admit(deps.clientsFile, credential, now()) : null;
    if (!client) {
      json(res, 401, { error: 'Not a client of this Tars server, or no longer one.' });
      return;
    }
    if (!may(client, route.scope)) {
      json(res, 403, { error: `${deps.identity().name} does not let ${client.name} ${SCOPE_WORDS[route.scope]}.` });
      return;
    }
    route.handle({ client, credential, agentId, req, res });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        address: address.address,
        streamCount,
        close: () => new Promise(done => {
          stopWatching();
          for (const clientId of [...streams.keys()]) endStreamsOf(clientId, 'closed');
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}
