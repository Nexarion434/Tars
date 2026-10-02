import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'crypto';

/**
 * The one-time offer a machine shows under Add a machine: six digits, drawn
 * uniformly, good for five minutes and five tries, and for one pairing. The
 * code never travels: the machine that types it sends an HMAC of it, keyed by
 * the code, over this offer's nonce and its own id, so a proof is worth
 * nothing to another offer or another caller. The offering machine proves the
 * code back in its answer (answerProof), so the one that typed it pairs only
 * with the machine that shows it, not with whichever answered first. Both
 * proofs are keyed by the code stretched with scrypt over the nonce (about
 * 100 ms), so a machine that answered hello in the offering one's place cannot
 * try the 10^6 codes against the proof it was sent before the typing machine
 * stops waiting (five seconds), nor before the offer expires. Only the
 * offering machine's clock decides expiry.
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

/** 32 MiB and about 100 ms per code (110 ms measured on a desktop PC): what makes trying them all slow. */
const codeKey = (code: string, nonce: string): Buffer =>
  scryptSync(code, `tars-machines:${nonce}`, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export const codeProof = (code: string, nonce: string, callerId: string): string =>
  createHmac('sha256', codeKey(code, nonce)).update(`${nonce}:${callerId}`).digest('hex');

/** The offering machine's proof that it knows the code: over another message than the caller's, so a caller's proof sent back is not one. */
export const answerProof = (code: string, nonce: string, callerId: string, answererId: string): string =>
  createHmac('sha256', codeKey(code, nonce)).update(`answer:${nonce}:${callerId}:${answererId}`).digest('hex');

/** Whether an answer carries the offering machine's proof, in a time that does not depend on where it differs. */
export function answerMatches(proof: unknown, code: string, nonce: string, callerId: string, answererId: string): boolean {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return timingSafeEqual(Buffer.from(answerProof(code, nonce, callerId, answererId), 'hex'), Buffer.from(proof, 'hex'));
}

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
