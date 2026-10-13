import * as fs from 'fs';
import { createHash } from 'crypto';
import { ensureSecretFileMode, writeSecretFileSync } from '../utils/secret-file';
import { privatePath } from '../constants';

/**
 * Receipts for requests sent with a clientRequestId (ORCHESTRATOR-PER-CHAT.md
 * v2.2, 4.4 item 1; DESIGN-REVIEW-CHATS.md L1).
 *
 * An MCP tool call that Tars did not answer within 30 s was called again, and
 * the worker got the same work typed in twice. A send that carries an id now
 * leaves a receipt, keyed by who sent it and that id: a retry with the same
 * payload is answered with the first outcome and sends nothing; the same id
 * with another payload is refused as a conflict (an agent that sent a
 * constant id would otherwise turn its own sends into silent no-ops for 24 h).
 *
 * Kept in ~/.tars-private/request-receipts.jsonl, which no agent is handed
 * (~/.dorothy is in every agent's --add-dir): the key, a SHA-256 of the
 * payload, the outcome's ids and states, and the time. Never the message
 * text: outcomes are cut to the fields in OUTCOME_FIELDS. Rewritten whole at
 * each write (0600, atomic), receipts older than 24 h dropped.
 */

export const RECEIPT_TTL_MS = 24 * 60 * 60_000;

/** Who sent it: an agent's id, or `tars` for Tars's own pass. */
export interface ReceiptKey { caller: string; id: string }

export interface ReceiptOutcome { status: number; body: Record<string, unknown> }

export interface Receipt { caller: string; id: string; hash: string; at: number; outcome: ReceiptOutcome }

export type Begin =
  | { kind: 'new'; settle: (outcome: ReceiptOutcome | null) => void }
  | { kind: 'duplicate'; outcome: ReceiptOutcome }
  | { kind: 'pending'; outcome: Promise<ReceiptOutcome | null> }
  | { kind: 'conflict' };

/** What an outcome may hold: ids and states, never a text someone wrote. */
const OUTCOME_FIELDS = new Set([
  'success', 'mode', 'previousStatus', 'held', 'queued', 'interrupted', 'taskRef', 'taskId',
  'started', 'ok', 'stopReason', 'outcome', 'code', 'restartedAfterStop',
]);
const AGENT_FIELDS = ['id', 'name', 'status'];

function outcomeOf(outcome: ReceiptOutcome): ReceiptOutcome {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outcome.body ?? {})) {
    if (OUTCOME_FIELDS.has(key) && (value === null || ['string', 'number', 'boolean'].includes(typeof value))) body[key] = value;
  }
  const agent = outcome.body?.agent as Record<string, unknown> | undefined;
  if (agent && typeof agent === 'object') {
    body.agent = Object.fromEntries(AGENT_FIELDS.filter((k) => typeof agent[k] === 'string').map((k) => [k, agent[k]]));
  }
  return { status: outcome.status, body };
}

const ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** The id a request carries: null when it has none, 'invalid' when it is not one. */
export function clientRequestIdOf(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && ID.test(value) ? value : 'invalid';
}

/** A SHA-256 of what was asked, its keys in a fixed order. */
export function payloadHash(parts: Record<string, unknown>): string {
  const ordered = Object.keys(parts).sort().map((k) => [k, parts[k] ?? null]);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

const keyOf = (key: ReceiptKey) => `${key.caller}\u0000${key.id}`;

function receiptOf(v: unknown): Receipt | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const o = r.outcome as Record<string, unknown> | undefined;
  if (typeof r.caller !== 'string' || typeof r.id !== 'string' || r.id.length > 128 || typeof r.hash !== 'string'
    || typeof r.at !== 'number' || !o || typeof o.status !== 'number' || !o.body || typeof o.body !== 'object') return null;
  return { caller: r.caller, id: r.id, hash: r.hash, at: r.at, outcome: outcomeOf(o as unknown as ReceiptOutcome) };
}

export function createReceiptStore(opts: { file: string; now?: () => number }) {
  const { file } = opts;
  const now = opts.now ?? Date.now;
  const receipts = new Map<string, Receipt>();
  const inFlight = new Map<string, { hash: string; outcome: Promise<ReceiptOutcome | null> }>();

  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf-8');
    ensureSecretFileMode(file);
  } catch { /* none yet */ }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const receipt = receiptOf(JSON.parse(line));
      if (receipt) receipts.set(keyOf(receipt), receipt);
    } catch { /* damaged: skipped */ }
  }

  const prune = () => {
    for (const [k, r] of receipts) if (now() - r.at > RECEIPT_TTL_MS) receipts.delete(k);
  };

  const save = () => {
    prune();
    try {
      writeSecretFileSync(file, [...receipts.values()].map((r) => JSON.stringify(r) + '\n').join(''));
    } catch (err) {
      console.warn('[receipts] could not write:', (err as Error).message);
    }
  };

  const find = (key: ReceiptKey): Receipt | undefined => {
    const receipt = receipts.get(keyOf(key));
    return receipt && now() - receipt.at <= RECEIPT_TTL_MS ? receipt : undefined;
  };

  return {
    begin(key: ReceiptKey, hash: string): Begin {
      const k = keyOf(key);
      const flying = inFlight.get(k);
      if (flying) return flying.hash === hash ? { kind: 'pending', outcome: flying.outcome } : { kind: 'conflict' };
      const done = find(key);
      if (done) return done.hash === hash ? { kind: 'duplicate', outcome: done.outcome } : { kind: 'conflict' };

      let resolve!: (outcome: ReceiptOutcome | null) => void;
      const outcome = new Promise<ReceiptOutcome | null>((r) => { resolve = r; });
      inFlight.set(k, { hash, outcome });
      return {
        kind: 'new',
        settle: (result) => {
          inFlight.delete(k);
          // Nothing was done (refused before anything was typed): forgotten,
          // so that a retry is tried rather than answered with the refusal.
          if (result) {
            const kept = outcomeOf(result);
            receipts.set(k, { caller: key.caller, id: key.id, hash, at: now(), outcome: kept });
            save();
            resolve(kept);
          } else {
            resolve(null);
          }
        },
      };
    },

    /** More of an outcome, learnt later: a delegated run that ends. */
    update(key: ReceiptKey, more: Record<string, unknown>): void {
      const receipt = find(key);
      if (!receipt) return;
      receipt.outcome = outcomeOf({ status: receipt.outcome.status, body: { ...receipt.outcome.body, ...more } });
      save();
    },

    find,
  };
}

export type ReceiptStore = ReturnType<typeof createReceiptStore>;

let live: ReceiptStore | null = null;

/** The app's receipts, in ~/.tars-private, opened at the first send that carries an id. */
export function liveReceipts(): ReceiptStore {
  live ??= createReceiptStore({ file: privatePath('request-receipts.jsonl') });
  return live;
}
