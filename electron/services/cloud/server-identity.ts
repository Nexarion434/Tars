import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { writeSecretFileSync } from '../../utils/secret-file';

/**
 * Who this Tars server is, in PRIVATE_DIR/cloud-server.json: an id made once
 * (16 hex), which a desktop checks through its forward before it sends its
 * credential, and a name, the host's to start with.
 */
export interface ServerIdentity { id: string; name: string }

export function serverIdentity(file: string): ServerIdentity {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ServerIdentity>;
    if (typeof parsed.id === 'string' && /^[0-9a-f]{16}$/.test(parsed.id) && typeof parsed.name === 'string') {
      return { id: parsed.id, name: parsed.name };
    }
  } catch { /* made below */ }
  const identity = {
    id: crypto.randomBytes(8).toString('hex'),
    name: os.hostname().replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 60) || 'Tars server',
  };
  writeSecretFileSync(file, `${JSON.stringify(identity)}\n`);
  return identity;
}
