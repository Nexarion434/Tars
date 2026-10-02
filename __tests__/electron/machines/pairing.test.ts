import { describe, it, expect } from 'vitest';
import { openOffer, codeProof, answerProof, checkProof, formatCode, OFFER_MS, MAX_ATTEMPTS } from '../../../electron/services/machines/pairing';

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
 * 8. The machine that answers is not made to prove the code back, so any
 *    machine answering hello pairs (final review, Critical 1); or its proof
 *    is one the caller sent, replayed.
 * 9. A proof is cheap to compute, so a machine that answered hello in the
 *    offering one's place tries all 10^6 codes against the proof it was
 *    sent in under a second, and proves the code back within the same
 *    exchange (final review, Critical 1).
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

  it('makes the answering machine prove the code back, a proof no caller sends (8)', () => {
    const o = openOffer(0);
    const back = answerProof(o.code, o.nonce, PC, SELF);
    expect(back).toMatch(/^[0-9a-f]{64}$/);
    expect(back).not.toBe(codeProof(o.code, o.nonce, PC));
    expect(back).not.toBe(answerProof(o.code, o.nonce, PC, 'm-cccccccccccccccc'));
    expect(back).not.toBe(answerProof('000000', o.nonce, PC, SELF));
  });

  it('costs enough per code that 10^6 codes cannot be tried within a pairing (9)', () => {
    // A plain HMAC takes microseconds: ten take well under a millisecond. Ten
    // stretched proofs past 100 ms put 10^6 codes past 10^4 seconds, against
    // the five seconds the typing machine waits for the answer.
    const started = performance.now();
    for (let i = 0; i < 10; i++) codeProof(String(i).padStart(6, '0'), 'a'.repeat(32), PC);
    expect(performance.now() - started).toBeGreaterThan(100);
  });

  it('writes the code as the page shows it', () => {
    expect(formatCode('482913')).toBe('482 913');
  });
});
