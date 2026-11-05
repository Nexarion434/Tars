import * as http from 'http';
import { closeDoorSocket, prepareDoorSocket } from './door-socket';
import { admit, may, watchClients } from './clients';
import type { DriveCaller, DriveOutcome, DriveRequest } from './drive';
import type { CloudClient, Scope } from './types';
import { UNTRUSTED, type ProjectFrom, type ProjectResult } from './projects';
import type { AgentCharacter } from '../../types';

/**
 * The door of a Tars server (docs/superpowers/plans/2026-11-02-tars-cloud.md,
 * Task 6): a second node:http listener beside the local API, on a Unix socket in
 * the private folder (door-socket.ts), which no other account or container can
 * take while the server is down. A desktop reaches it through its SSH forward
 * (ssh -L 127.0.0.1:<local>:<socket>); nothing on any network does. It admits
 * client credentials alone (never the master API token, which no route reads or
 * returns), each within its scopes, read from the clients file at every request.
 *
 * Every request goes through the same gates, in this order, and the first that
 * fails answers: a path that is not a route (404, before any credential is
 * looked at, so no answer tells whether one is good); an Origin header, which
 * only a web page sends (403); a Host other than localhost or 127.0.0.1, which is
 * what a page rebinding a name to a desktop's forward would send (403); a body
 * over 64 KB (413, unread); then, for every route but hello, the credential
 * (401) and the route's scope (403). Only then is an agent looked up, with one
 * sentence for any it does not know. 128 connections at most, headers within
 * 10 s, a request within 30 s.
 *
 * A stream (one agent's live output, server-sent events) is held by its client:
 * 32 at most each and 64 in all; ended at once when the client is revoked (the
 * clients file is watched), at the next re-check (15 s) once it expires or loses
 * see, and when its reader falls 1 MB behind.
 */

export const MAX_BODY = 64 * 1024;
export const MAX_STREAMS_PER_CLIENT = 32;
/** All clients together: what one server holds open at most. */
export const MAX_STREAMS = 64;
export const MAX_BEHIND = 1024 * 1024;
export const MAX_CONNECTIONS = 128;

export interface AgentScreen { screen: string; cliRunning: boolean; cols: number; rows: number }

/** What the create routes call (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md, Task 4). */
export interface DoorCreate {
  /** The server's projects (projects.ts listProjects). */
  projects(): Array<{ name: string; path: string }>;
  project(name: string, from: ProjectFrom): Promise<ProjectResult>;
  /** agent-create.ts's createAgentRecord, the fields already narrowed to a client's. */
  agent(fields: Record<string, unknown>): Promise<{ ok: true; agent: { id: string; name: string } } | { ok: false; status: number; error: string }>;
  gitKey(): Promise<{ ok: true; publicKey: string; fingerprint: string } | { ok: false; error: string }>;
  /** One of the server's agents, as a removal reads it, or null for one it does not have. */
  agentOf(agentId: string): { name: string; status: string } | null;
  /** core/agent-remove.ts's removeAgent: what the window's Delete does, its worktree saved or kept as there. */
  remove(agentId: string): Promise<{ savedTo?: string; worktreeKept?: string }>;
}

export interface DoorDeps {
  /** The Unix socket the door listens on (door-socket.ts): PRIVATE_DIR/door.sock on a server. */
  socketPath: string;
  clientsFile: string;
  identity(): { id: string; name: string; version: string };
  fleet(client: CloudClient): unknown;
  /** One agent's terminal as it shows now, or null for an agent the server does not have. */
  screenOf?(agentId: string): AgentScreen | null;
  onOutput?(listener: (agentId: string, chunk: string) => void): () => void;
  /** executeDrive over the server's terminals (drive.ts). */
  drive?(request: DriveRequest, caller: DriveCaller): Promise<DriveOutcome>;
  /** Projects and agents made on the server, and its git key (M3); without it, the create routes answer 404. */
  create?: DoorCreate;
  /** How often an open stream's credential is admitted again (default 15 s). */
  recheckMs?: number;
  /** How often the clients file is polled for a revoke (default 500 ms). */
  revokePollMs?: number;
  now?: () => number;
}

export interface Door {
  /** The socket it listens on. */
  path: string;
  /** Open streams, all clients: for tests and logs. */
  streamCount(): number;
  close(): Promise<void>;
}

interface Request { client: CloudClient | null; credential: string | null; agentId?: string; req: http.IncomingMessage; res: http.ServerResponse }
interface Route { method: string; pattern: RegExp; scope: Scope | null; handle(r: Request): void }

const AGENT_PATH = '([A-Za-z0-9_-]{1,64})';

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
    if (streamCount() >= MAX_STREAMS) {
      json(res, 429, { error: `This server holds ${MAX_STREAMS} streams at most.` });
      return;
    }
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
      const still = admit(deps.clientsFile, credential ?? undefined, now());
      if (!still || !may(still, 'see')) end('revoked');
      else res.write(': keepalive\n\n');
    }, deps.recheckMs ?? 15_000);
    own.add(end);
    streams.set(client!.id, own);
    req.on('close', () => end('closed'));
  };

  /**
   * A route with a body: the body read up to 64 KB (counted, chunked or not),
   * then the client admitted again, so one revoked or stripped of the route's
   * scope while its body was on the way does nothing; then `then`.
   */
  const bodyRoute = (scope: Scope, then: (body: Record<string, unknown>, again: CloudClient, request: Request) => void) => (request: Request) => {
    const { client, credential, req, res } = request;
    let size = 0;
    const chunks: Buffer[] = [];
    let refused = false;
    req.on('data', (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        refused = true;
        res.setHeader('Connection', 'close');
        json(res, 413, { error: `A request carries ${MAX_BODY / 1024} KB at most.` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (refused) return;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
        if (!body || typeof body !== 'object') throw new Error('not an object');
      } catch {
        json(res, 400, { error: 'The body is a JSON object.' });
        return;
      }
      const again = admit(deps.clientsFile, credential ?? undefined, now());
      if (!again || again.id !== client!.id) {
        json(res, 401, { error: 'Not a client of this Tars server, or no longer one.' });
        return;
      }
      if (!may(again, scope)) {
        json(res, 403, { error: `${deps.identity().name} does not let ${again.name} ${SCOPE_WORDS[scope]}.` });
        return;
      }
      then(body, again, request);
    });
  };

  /** A drive route: the executor, once the body is in and the client admitted again. */
  const driveRoute = (action: DriveRequest['action']) => bodyRoute('drive', (body, again, { agentId, res }) => {
    if (!deps.drive) {
      json(res, 404, { error: 'Not found.' });
      return;
    }
    const id = agentId!;
    const request: DriveRequest =
      action === 'keys' ? { action, agentId: id, data: body.data as string }
        : action === 'size' ? { action, agentId: id, cols: body.cols as number, rows: body.rows as number }
          : action === 'stop' ? { action, agentId: id, reason: body.reason as string }
            : action === 'message' ? { action, agentId: id, text: body.text as string }
              : { action, agentId: id };
    deps.drive(request, { name: again.name, kind: again.kind }).then(
      outcome => (outcome.ok ? json(res, 200, { ok: true }) : json(res, outcome.status, { error: outcome.error })),
      err => {
        console.error('[cloud] a drive failed:', err);
        json(res, 500, { error: 'The server could not do it.' });
      },
    );
  });

  // Hermes and every outside agent create and delete nothing on a server, whatever their scopes (decision 4, M3).
  const outsideRefused = (client: CloudClient, res: http.ServerResponse): boolean => {
    if (client.kind !== 'outside-agent') return false;
    json(res, 403, { error: `${client.name} is an outside agent: it creates and deletes nothing on this server.` });
    return true;
  };
  const failed = (res: http.ServerResponse) => (err: unknown) => {
    console.error('[cloud] a create failed:', err);
    json(res, 500, { error: 'The server could not do it.' });
  };

  /** POST /cloud/v1/projects { name, from }: projects.ts's createProject. */
  const projectRoute = bodyRoute('create', (body, again, { res }) => {
    const create = deps.create;
    if (!create) { json(res, 404, { error: 'Not found.' }); return; }
    if (outsideRefused(again, res)) return;
    const from = body.from as { kind?: unknown; url?: unknown; trusted?: unknown } | undefined;
    // A clone only with the client's word that it trusts the repository's code (security review 1, B1),
    // kept with the client's own name, never one the body gives.
    if (from && from.kind === 'git' && from.trusted !== true) { json(res, 400, { error: UNTRUSTED }); return; }
    const shape: ProjectFrom | null = from && from.kind === 'empty' ? { kind: 'empty' }
      : from && from.kind === 'git' && typeof from.url === 'string' ? { kind: 'git', url: from.url, trusted: true, by: again.name } : null;
    if (typeof body.name !== 'string' || !shape) {
      json(res, 400, { error: 'A project is a name, made empty or from a git address.' });
      return;
    }
    const name = body.name;
    create.project(name, shape).then(made => {
      if (made.ok) json(res, 201, { ok: true, project: { name, path: made.path } });
      else json(res, made.status, { error: made.error });
    }, failed(res));
  });

  /** What a client may set on an agent it creates: the New agent form's fields, never a binary, a second folder or a role. */
  const AGENT_FIELDS = ['name', 'provider', 'model', 'effort', 'permissionMode', 'skills', 'character', 'role'] as const;
  const NOT_FROM_A_CLIENT = ['cliPath', 'secondaryProjectPath', 'orchestratorMode'];
  const CHARACTERS: string[] = ['robot', 'ninja', 'wizard', 'astronaut', 'knight', 'pirate', 'alien', 'viking'] satisfies AgentCharacter[];

  /** POST /cloud/v1/agents: agent-create.ts's record in one of the server's projects, started only through the drive executor. */
  const agentRoute = bodyRoute('create', (body, again, { res }) => {
    const create = deps.create;
    if (!create) { json(res, 404, { error: 'Not found.' }); return; }
    if (outsideRefused(again, res)) return;
    if (NOT_FROM_A_CLIENT.some(key => key in body)) {
      json(res, 400, { error: 'A client sets no CLI path or second folder on a server\'s agent.' });
      return;
    }
    // Its project's orchestrator ("l'orchestrateur en cloud", 2026-11-04): a desktop that may create and drive
    // here, never an outside agent (refused above). The server gives it its tools from the role, and it takes
    // the role from its project's current one (core/agent-role.ts), as on a desktop.
    if (body.role !== undefined && body.role !== 'orchestrator' && body.role !== 'worker') {
      json(res, 400, { error: 'An agent\'s role is orchestrator or worker.' });
      return;
    }
    if (body.role === 'orchestrator' && !may(again, 'drive')) {
      json(res, 403, { error: `${deps.identity().name} does not let ${again.name} ${SCOPE_WORDS.drive}: only a computer that may makes an orchestrator there.` });
      return;
    }
    // What a remote client names and draws (security review 1, N8): a short string, a character Tars has.
    if ((body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 80))
      || (body.character !== undefined && !CHARACTERS.includes(body.character as string))) {
      json(res, 400, { error: 'An agent\'s name is up to 80 characters, and its character one of ' + CHARACTERS.join(', ') + '.' });
      return;
    }
    const projects = create.projects();
    const project = typeof body.projectName === 'string' ? projects.find(p => p.name === body.projectName)
      : typeof body.projectPath === 'string' ? projects.find(p => p.path === body.projectPath) : undefined;
    if (!project) {
      json(res, 404, { error: 'No such project on this Tars server.' });
      return;
    }
    const fields: Record<string, unknown> = { projectPath: project.path };
    for (const key of AGENT_FIELDS) if (body[key] !== undefined) fields[key] = body[key];
    create.agent(fields).then(async made => {
      if (!made.ok) { json(res, made.status, { error: made.error }); return; }
      let started = false;
      let startError: string | undefined;
      if (body.start === true) {
        if (!may(again, 'drive') || !deps.drive) {
          startError = `${deps.identity().name} does not let ${again.name} ${SCOPE_WORDS.drive}: the agent is made, not started.`;
        } else {
          const outcome = await deps.drive({ action: 'start', agentId: made.agent.id }, { name: again.name, kind: again.kind });
          started = outcome.ok;
          if (!outcome.ok) startError = outcome.error;
        }
      }
      json(res, 201, { ok: true, agent: made.agent, started, ...(startError ? { startError } : {}) });
    }, failed(res));
  });

  /**
   * DELETE /cloud/v1/agents/:agentId: the window's own Delete, for a client that may create. An agent at work
   * (running, or waiting on its user: what a card offers to stop) is left alone and the client told to stop it
   * first: stopping takes `drive`, which `create` alone does not give, and a turn cut short loses its work.
   */
  const removeRoute = ({ client, agentId, res }: Request) => {
    const create = deps.create;
    if (!create) { json(res, 404, { error: 'Not found.' }); return; }
    if (outsideRefused(client!, res)) return;
    const agent = create.agentOf(agentId!);
    if (!agent) { json(res, 404, { error: NO_SUCH_AGENT }); return; }
    if (agent.status === 'running' || agent.status === 'waiting') {
      json(res, 409, { error: `${agent.name} is at work on ${deps.identity().name}: stop it first, then delete it.` });
      return;
    }
    create.remove(agentId!).then(gone => json(res, 200, { ok: true, ...gone }), failed(res));
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
      handle: ({ client, res }) => {
        const fleet = deps.fleet(client!);
        // The server's projects, by name and path, for a desktop's Projects page and New agent (M3).
        json(res, 200, deps.create ? { ...(fleet as object), projects: deps.create.projects().map(p => ({ name: p.name, path: p.path })) } : fleet);
      },
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
    { method: 'POST', pattern: new RegExp(`^/cloud/v1/agents/${AGENT_PATH}/keys$`), scope: 'drive', handle: driveRoute('keys') },
    { method: 'POST', pattern: new RegExp(`^/cloud/v1/agents/${AGENT_PATH}/size$`), scope: 'drive', handle: driveRoute('size') },
    { method: 'POST', pattern: new RegExp(`^/cloud/v1/agents/${AGENT_PATH}/start$`), scope: 'drive', handle: driveRoute('start') },
    { method: 'POST', pattern: new RegExp(`^/cloud/v1/agents/${AGENT_PATH}/stop$`), scope: 'drive', handle: driveRoute('stop') },
    { method: 'POST', pattern: new RegExp(`^/cloud/v1/agents/${AGENT_PATH}/message$`), scope: 'drive', handle: driveRoute('message') },
    { method: 'POST', pattern: /^\/cloud\/v1\/projects$/, scope: 'create', handle: projectRoute },
    { method: 'POST', pattern: /^\/cloud\/v1\/agents$/, scope: 'create', handle: agentRoute },
    { method: 'DELETE', pattern: new RegExp(`^/cloud/v1/agents/${AGENT_PATH}$`), scope: 'create', handle: removeRoute },
    {
      // The server's own git key, its public half: what the user adds to GitHub (git-access.ts).
      method: 'GET', pattern: /^\/cloud\/v1\/git-key$/, scope: 'create',
      handle: ({ client, res }) => {
        if (!deps.create) { json(res, 404, { error: 'Not found.' }); return; }
        if (outsideRefused(client!, res)) return;
        deps.create.gitKey().then(key => {
          if (key.ok) json(res, 200, { publicKey: key.publicKey, fingerprint: key.fingerprint });
          else json(res, 500, { error: key.error });
        }, failed(res));
      },
    },
  ];

  const server = http.createServer((req, res) => {
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
    // Through the forward, a desktop's client says its own loopback port; a page rebinding a name says the name.
    if (!/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(req.headers.host ?? '')) {
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

  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  return prepareDoorSocket(deps.socketPath).then(() => new Promise<Door>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.socketPath, () => {
      closeDoorSocket(deps.socketPath);
      resolve({
        path: deps.socketPath,
        streamCount,
        close: () => new Promise(done => {
          stopWatching();
          for (const clientId of [...streams.keys()]) endStreamsOf(clientId, 'closed');
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  }), err => {
    stopWatching();
    throw err;
  });
}
