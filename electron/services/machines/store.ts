import * as fs from 'fs';
import * as os from 'os';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { privatePath } from '../../constants';
import { writeSecretFileSync } from '../../utils/secret-file';
import type { MachinesFile, PairedMachine } from './types';

/**
 * This machine's identity and the machines paired with it. In the private
 * directory, which no agent is handed: each entry holds the secret this Tars
 * presents to that machine, and the hash of the one that machine presents
 * here (a copy of the file does not let anyone call this bridge).
 */
export const MACHINES_FILE = privatePath('machines.json');

const ID = /^m-[0-9a-f]{16}$/;
const HASH = /^[0-9a-f]{64}$/;
/** What hides or rearranges text, or breaks a line, as src/lib/stop-line.ts flattens it. */
const HIDDEN_OR_LINE_BREAKING = /[\p{Zl}\p{Zp}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

/** A machine name as the other machine will show it, or an Error whose message the page shows. */
export function cleanName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new Error('A machine needs a name.');
  if ([...n].length > 40) throw new Error('A machine name is 40 characters at most.');
  if (HIDDEN_OR_LINE_BREAKING.test(n)) throw new Error('A machine name is one line of plain text.');
  return n;
}

export const newSecret = (): string => randomBytes(32).toString('base64url');
export const hashSecret = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex');

/** Whether `presented` is the secret whose hash is kept, in a time that does not depend on where they differ. */
export function secretMatches(presented: string, hash: string): boolean {
  if (!presented || !HASH.test(hash)) return false;
  return timingSafeEqual(Buffer.from(hashSecret(presented), 'hex'), Buffer.from(hash, 'hex'));
}

const isPeer = (p: unknown): p is PairedMachine => {
  const x = p as Record<string, unknown> | null;
  return !!x && typeof x === 'object'
    && typeof x.id === 'string' && ID.test(x.id)
    && typeof x.name === 'string' && typeof x.address === 'string'
    && Number.isInteger(x.port) && (x.port as number) > 0 && (x.port as number) < 65536
    && typeof x.inboundSecretHash === 'string' && HASH.test(x.inboundSecretHash)
    && typeof x.outboundSecret === 'string' && x.outboundSecret.length > 0
    && (x.mayOnMe === 'see' || x.mayOnMe === 'drive') && typeof x.pairedAt === 'string';
};

/** The file, or a fresh identity (written at once, so it is the same at the next read) and no peers. */
export function readMachines(): MachinesFile {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(MACHINES_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
  } catch { /* none yet, or unreadable: a fresh identity below */ }
  const self = raw.self as Record<string, unknown> | undefined;
  const hasSelf = !!self && typeof self.id === 'string' && ID.test(self.id) && typeof self.name === 'string';
  const file: MachinesFile = {
    version: 1,
    self: hasSelf ? { id: self!.id as string, name: self!.name as string } : { id: `m-${randomBytes(8).toString('hex')}`, name: os.hostname() },
    peers: Array.isArray(raw.peers) ? raw.peers.filter(isPeer) : [],
  };
  if (!hasSelf) writeMachines(file);
  return file;
}

export function writeMachines(file: MachinesFile): void {
  writeSecretFileSync(MACHINES_FILE, `${JSON.stringify(file, null, 2)}\n`);
}
