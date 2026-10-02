import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';

/**
 * The one-time offer a machine shows under Add a machine: six digits, drawn
 * uniformly, good for five minutes and five tries, and for one pairing. The
 * code never travels: the machine that types it sends an HMAC of it, keyed by
 * the code, over this offer's nonce and its own id, so a proof is worth
 * nothing to another offer or another caller. Only the offering machine's
 * clock decides expiry.
 */
export interface Offer { code: string; nonce: string; expiresAt: number; attempts: number; closed: boolean }

export const OFFER_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 5;
export type ProofVerdict = 'ok' | 'expired' | 'wrong' | 'closed' | 'self';

export function openOffer(now: number, random: (n: number) => Buffer = randomBytes): Offer {
  return {
    code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
    nonce: random(16).toString('hex'),
    expiresAt: now + OFFER_MS,
    attempts: 0,
    closed: false,
  };
}

export const codeProof = (code: string, nonce: string, callerId: string): string =>
  createHmac('sha256', code).update(`${nonce}:${callerId}`).digest('hex');

/** Checks a caller's proof against the offer, and closes it on success or on the fifth wrong try. */
export function checkProof(offer: Offer, proof: string, callerId: string, selfId: string, now: number): ProofVerdict {
  if (offer.closed) return 'closed';
  if (now > offer.expiresAt) { offer.closed = true; return 'expired'; }
  if (callerId === selfId) return 'self';
  const expected = Buffer.from(codeProof(offer.code, offer.nonce, callerId), 'hex');
  const given = /^[0-9a-f]{64}$/.test(proof) ? Buffer.from(proof, 'hex') : Buffer.alloc(32);
  if (timingSafeEqual(expected, given)) { offer.closed = true; return 'ok'; }
  offer.attempts += 1;
  if (offer.attempts >= MAX_ATTEMPTS) offer.closed = true;
  return 'wrong';
}

/** "482913" as the page shows it: "482 913". */
export const formatCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;
