import { describe, it, expect } from 'vitest';
import { openOffer, codeProof, checkProof, formatCode, OFFER_MS, MAX_ATTEMPTS } from '../../../electron/services/machines/pairing';

/**
 * The one-time offer a machine shows under Add a machine. How it can fail,
 * written before the code:
 * 1. The code is guessable: fewer than six digits, or not uniformly drawn.
 * 2. The code itself travels: a proof that contains it, or can be checked
 *    without the nonce of this offer.
 * 3. A proof made for another caller id, or another offer's nonce, passes.
 * 4. Unlimited tries: 10^6 codes are tried in minutes.
 * 5. An offer is used twice, or after its five minutes, or after it was
 *    closed.
 * 6. The machine pairs with itself (the code typed where it is shown).
 * 7. Expiry is decided from a time the caller sent (clocks differ).
 */
const SELF = 'm-aaaaaaaaaaaaaaaa';
const PC = 'm-bbbbbbbbbbbbbbbb';

describe('the pairing offer', () => {
  it('draws six digits and a nonce, and expires five minutes later (1)', () => {
    const o = openOffer(1_000);
    expect(o.code).toMatch(/^\d{6}$/);
    expect(o.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(o.expiresAt).toBe(1_000 + OFFER_MS);
  });

  it('proves the code without containing it, bound to the nonce and the caller (2, 3)', () => {
    const o = openOffer(0);
    const proof = codeProof(o.code, o.nonce, PC);
    expect(proof).not.toContain(o.code);
    expect(checkProof({ ...openOffer(0), code: o.code }, proof, PC, SELF, 1)).toBe('wrong');
    expect(checkProof(o, codeProof(o.code, o.nonce, 'm-cccccccccccccccc'), PC, SELF, 1)).toBe('wrong');
    expect(checkProof(o, proof, PC, SELF, 1)).toBe('ok');
  });

  it('closes after five wrong proofs (4)', () => {
    const o = openOffer(0);
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(checkProof(o, 'x', PC, SELF, 1)).toBe('wrong');
    expect(checkProof(o, codeProof(o.code, o.nonce, PC), PC, SELF, 1)).toBe('closed');
  });

  it('works once, not after its five minutes (5, 7)', () => {
    const o = openOffer(0);
    expect(checkProof(o, codeProof(o.code, o.nonce, PC), PC, SELF, OFFER_MS + 1)).toBe('expired');
    const p = openOffer(0);
    expect(checkProof(p, codeProof(p.code, p.nonce, PC), PC, SELF, 1)).toBe('ok');
    expect(checkProof(p, codeProof(p.code, p.nonce, PC), PC, SELF, 2)).toBe('closed');
  });

  it('refuses to pair a machine with itself (6)', () => {
    const o = openOffer(0);
    expect(checkProof(o, codeProof(o.code, o.nonce, SELF), SELF, SELF, 1)).toBe('self');
  });

  it('writes the code as the page shows it', () => {
    expect(formatCode('482913')).toBe('482 913');
  });
});
