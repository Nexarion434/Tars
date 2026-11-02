import * as http from 'http';
import type { AddressInfo } from 'net';
import { admit, may } from './clients';
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
 */

export const MAX_BODY = 64 * 1024;

export interface DoorDeps {
  /** CLOUD_DOOR_PORT; 0 for an ephemeral port (tests). */
  port: number;
  clientsFile: string;
  identity(): { id: string; name: string; version: string };
  fleet(client: CloudClient): unknown;
  now?: () => number;
}

export interface Door { port: number; address: string; close(): Promise<void> }

interface Route { scope: Scope | null; handle(client: CloudClient | null, res: http.ServerResponse): void }

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

export function startDoor(deps: DoorDeps): Promise<Door> {
  const now = deps.now ?? Date.now;
  const routes = new Map<string, Route>([
    ['GET /cloud/v1/hello', {
      scope: null,
      handle: (_client, res) => {
        const { id, name, version } = deps.identity();
        json(res, 200, { v: 1, serverId: id, name, version });
      },
    }],
    ['GET /cloud/v1/fleet', {
      scope: 'see',
      handle: (client, res) => json(res, 200, deps.fleet(client!)),
    }],
  ]);

  const server = http.createServer((req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      json(res, 403, { error: 'This door answers this machine alone.' });
      return;
    }
    const pathname = (req.url ?? '').split('?')[0];
    const route = routes.get(`${req.method} ${pathname}`);
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
      route.handle(null, res);
      return;
    }
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
    const client = match ? admit(deps.clientsFile, match[1], now()) : null;
    if (!client) {
      json(res, 401, { error: 'Not a client of this Tars server, or no longer one.' });
      return;
    }
    if (!may(client, route.scope)) {
      json(res, 403, { error: `${deps.identity().name} does not let ${client.name} ${SCOPE_WORDS[route.scope]}.` });
      return;
    }
    route.handle(client, res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        address: address.address,
        close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}
