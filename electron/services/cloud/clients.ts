import * as crypto from 'crypto';
import * as fs from 'fs';
import { writeSecretFileSync } from '../../utils/secret-file';
import { CLIENT_KINDS, SCOPES, type ClientKind, type ClientView, type CloudClient, type Scope } from './types';

/**
 * The clients of a Tars server (plan Task 5), in PRIVATE_DIR/cloud-clients.json
 * (0600, never handed to a CLI). A credential is 32 random bytes in base64url,
 * shown once at minting and kept only as its sha256; a request presents it,
 * and admit() finds its client by comparing hashes in constant time. The
 * master API token is never one: it is not 43 base64url characters minted
 * here, and nothing here reads it.
 *
 * The file is read again at every admit(), so a revoke from the CLI takes at
 * the next request; watchClients() lets a running server cut what a revoked
 * client holds open (its streams) at once. A file that does not parse admits
 * no one and is never written over.
 */

export const MAX_CLIENTS = 32;
const NAME_MAX = 60;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const ID = /^c_[0-9a-f]{8}$/;

interface ClientsFile { version: 1; clients: CloudClient[] }

type Read = { ok: true; clients: CloudClient[] } | { ok: false; error: string };

function read(file: string): Read {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, clients: [] } : { ok: false, error: String(err) };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ClientsFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.clients)) return { ok: false, error: `${file}: not a clients file` };
    return { ok: true, clients: parsed.clients };
  } catch (err) {
    return { ok: false, error: `${file}: ${(err as Error).message}` };
  }
}

function readOrThrow(file: string): CloudClient[] {
  const result = read(file);
  if (!result.ok) throw new Error(`The clients file cannot be read, so nothing is written over it: ${result.error}`);
  return result.clients;
}

function write(file: string, clients: CloudClient[]): void {
  writeSecretFileSync(file, `${JSON.stringify({ version: 1, clients } satisfies ClientsFile, null, 2)}\n`);
}

function hashOf(credential: string): string {
  return crypto.createHash('sha256').update(credential, 'utf-8').digest('hex');
}

/** Letters, numbers, spaces and punctuation: no controls, no newlines, no format characters (a name is shown and typed into sender lines). */
export function cleanName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('A client needs a name.');
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) throw new Error(`A client's name is 1 to ${NAME_MAX} characters.`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed)) throw new Error('A client\'s name cannot hold control or format characters.');
  return trimmed;
}

function cleanScopes(scopes: unknown): Scope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error(`A client needs at least one scope: ${SCOPES.join(', ')}.`);
  for (const scope of scopes) {
    if (!(SCOPES as readonly unknown[]).includes(scope)) throw new Error(`Unknown scope: ${String(scope)}.`);
  }
  return [...new Set(scopes as Scope[])];
}

export function addClient(
  file: string,
  input: { name: string; kind: ClientKind; scopes: Scope[]; days?: number; via?: string },
  now = Date.now(),
): { client: ClientView; credential: string } {
  const name = cleanName(input.name);
  if (!(CLIENT_KINDS as readonly unknown[]).includes(input.kind)) throw new Error(`Unknown kind of client: ${String(input.kind)}.`);
  const scopes = cleanScopes(input.scopes);
  if (input.days !== undefined && (!Number.isInteger(input.days) || input.days < 1 || input.days > 3650)) {
    throw new Error('A client\'s lifetime is a whole number of days, 1 to 3650.');
  }
  const clients = readOrThrow(file);
  if (clients.length >= MAX_CLIENTS) throw new Error(`A Tars server keeps ${MAX_CLIENTS} clients at most: revoke one first.`);
  const credential = crypto.randomBytes(32).toString('base64url');
  let id: string;
  do id = `c_${crypto.randomBytes(4).toString('hex')}`; while (clients.some(c => c.id === id));
  const client: CloudClient = {
    id,
    name,
    kind: input.kind,
    scopes,
    hash: hashOf(credential),
    createdAt: new Date(now).toISOString(),
    ...(input.days ? { expiresAt: new Date(now + input.days * 86_400_000).toISOString() } : {}),
    ...(input.via ? { mintedVia: cleanName(input.via) } : {}),
  };
  write(file, [...clients, client]);
  const { hash: _hash, ...view } = client;
  void _hash;
  return { client: view, credential };
}

export function listClients(file: string): ClientView[] {
  return readOrThrow(file).map(({ hash: _hash, ...view }) => { void _hash; return view; });
}

export function revokeClient(file: string, id: string): boolean {
  if (!ID.test(id)) return false;
  const clients = readOrThrow(file);
  const kept = clients.filter(c => c.id !== id);
  if (kept.length === clients.length) return false;
  write(file, kept);
  return true;
}

/** The client a credential belongs to, or null: unknown, revoked, expired, malformed, or a file that does not read. */
export function admit(file: string, credential: string | undefined, now = Date.now()): CloudClient | null {
  if (typeof credential !== 'string' || !CREDENTIAL.test(credential)) return null;
  const result = read(file);
  if (!result.ok) {
    console.error(`[cloud] ${result.error}: no client admitted`);
    return null;
  }
  const presented = Buffer.from(hashOf(credential), 'hex');
  let found: CloudClient | null = null;
  for (const client of result.clients) {
    const stored = Buffer.from(String(client.hash), 'hex');
    if (stored.length === presented.length && crypto.timingSafeEqual(stored, presented)) found = client;
  }
  if (!found) return null;
  if (found.expiresAt && Date.parse(found.expiresAt) <= now) return null;
  return found;
}

export function may(client: CloudClient, scope: Scope): boolean {
  return client.scopes.includes(scope);
}

/** Calls onRevoke with each client id that leaves the file, polling every intervalMs. Returns the stop. */
export function watchClients(file: string, onRevoke: (id: string) => void, intervalMs = 1000, onAdd?: (client: ClientView) => void): () => void {
  const clientsNow = (): CloudClient[] | null => {
    const result = read(file);
    return result.ok ? result.clients : null;
  };
  const idsOf = (): Set<string> | null => {
    const clients = clientsNow();
    return clients ? new Set(clients.map(c => c.id)) : null;
  };
  let known = idsOf() ?? new Set<string>();
  const listener = () => {
    const clients = clientsNow();
    if (!clients) return;
    const now = new Set(clients.map(c => c.id));
    for (const id of known) if (!now.has(id)) onRevoke(id);
    for (const { hash: _hash, ...view } of clients) { void _hash; if (!known.has(view.id)) onAdd?.(view); }
    known = now;
  };
  fs.watchFile(file, { interval: intervalMs, persistent: false }, listener);
  return () => fs.unwatchFile(file, listener);
}
