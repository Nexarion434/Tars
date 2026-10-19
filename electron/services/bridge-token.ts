import * as crypto from 'crypto';
import * as fs from 'fs';
import type * as http from 'http';
import { BRIDGE_TOKEN_FILE } from '../constants';
import { writeSecretFileEvenIfHeldSync } from '../utils/secret-file';

/**
 * The token Tars's OpenAI bridge (services/openai-bridge.ts) takes, and the
 * only thing it opens: the agents on Venice or a custom endpoint, and their
 * scheduled tasks, present it as their key. They were handed Tars's shared
 * API token, which every other path keeps from the agents since 2.0.4: an
 * agent in bypass read it in its own environment and could call every route
 * that token opens (the Audit's L3 on #466). Kept in ~/.tars-private, 0600,
 * the same across starts, since a scheduled task reads it as it runs and a
 * running agent keeps the one it was started with.
 */
let token: string | undefined;

export function getBridgeToken(): string {
  if (token) return token;
  try {
    const kept = fs.readFileSync(BRIDGE_TOKEN_FILE, 'utf-8').trim();
    if (/^[0-9a-f]{64}$/.test(kept)) return (token = kept);
  } catch { /* none yet */ }
  const minted = crypto.randomBytes(32).toString('hex');
  writeSecretFileEvenIfHeldSync(BRIDGE_TOKEN_FILE, minted);
  return (token = minted);
}

/** Whether a request to the bridge presents its token, as a Bearer or as x-api-key. */
export function bridgeAuthorized(headers: http.IncomingHttpHeaders): boolean {
  const expected = getBridgeToken();
  const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1];
  return headers['x-api-key'] === expected || bearer === expected;
}
