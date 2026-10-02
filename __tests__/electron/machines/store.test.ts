import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MACHINES_FILE, readMachines, writeMachines, newSecret, hashSecret, secretMatches, cleanName } from '../../../electron/services/machines/store';

/**
 * ~/.tars-private/machines.json. How it can fail, written before the code:
 * 1. No file: this machine has no id, or a new id on every read, so a peer
 *    paired yesterday no longer recognises it.
 * 2. A malformed file throws, and Settings > Machines never opens.
 * 3. A peer entry with a missing or wrong field is used anyway (a port that
 *    is not a number, a permission other than see or drive).
 * 4. The secrets a peer presents are kept in clear, so a copy of the file
 *    lets anyone call this bridge as that peer.
 * 5. Two secrets compared with ===, which answers faster on an early
 *    mismatch.
 * 6. A name that is empty, 41 characters long, or holds a line break or a
 *    direction override reaches the other machine's screen.
 */
beforeEach(() => fs.rmSync(MACHINES_FILE, { force: true }));

describe('the machines file', () => {
  it('gives this machine an id and its host name once, and keeps them (1)', () => {
    const first = readMachines();
    expect(first.self.id).toMatch(/^m-[0-9a-f]{16}$/);
    expect(first.self.name).toBe(os.hostname());
    expect(readMachines().self).toEqual(first.self);
  });

  it('sets a malformed file aside before starting a fresh one, so nothing in it is lost (2)', () => {
    fs.mkdirSync(path.dirname(MACHINES_FILE), { recursive: true });
    for (const f of fs.readdirSync(path.dirname(MACHINES_FILE))) if (f.startsWith('machines.json.unreadable-')) fs.rmSync(path.join(path.dirname(MACHINES_FILE), f));
    fs.writeFileSync(MACHINES_FILE, '{nope');
    const file = readMachines();
    expect(file.peers).toEqual([]);
    expect(file.self.id).toMatch(/^m-[0-9a-f]{16}$/);
    const aside = fs.readdirSync(path.dirname(MACHINES_FILE)).filter(f => f.startsWith('machines.json.unreadable-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(MACHINES_FILE), aside[0]), 'utf8')).toBe('{nope');
  });

  it('throws, and writes nothing, when the file is there but cannot be read (2)', () => {
    // A folder where the file should be: readFileSync fails with EISDIR, as a
    // held file fails with EBUSY on Windows. Neither is a reason to start over.
    fs.mkdirSync(MACHINES_FILE, { recursive: true });
    try {
      expect(() => readMachines()).toThrow(/machines\.json cannot be read \(EISDIR\)/);
      expect(fs.statSync(MACHINES_FILE).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(MACHINES_FILE, { recursive: true, force: true });
    }
  });

  it('drops a peer whose fields are not what pairing writes (3)', () => {
    const self = readMachines().self;
    writeMachines({ version: 1, self, peers: [
      { id: 'm-0000000000000001', name: 'PC', address: '100.64.0.2', port: 31416, inboundSecretHash: hashSecret('a'), outboundSecret: 'b', mayOnMe: 'see', pairedAt: '2026-10-02T00:00:00Z' },
      { id: 'm-0000000000000002', name: 'Bad', address: '100.64.0.3', port: 'x' as unknown as number, inboundSecretHash: hashSecret('a'), outboundSecret: 'b', mayOnMe: 'see', pairedAt: '' },
      { id: 'm-0000000000000003', name: 'Bad', address: '100.64.0.4', port: 31416, inboundSecretHash: hashSecret('a'), outboundSecret: 'b', mayOnMe: 'admin' as 'see', pairedAt: '' },
    ] });
    expect(readMachines().peers.map(p => p.id)).toEqual(['m-0000000000000001']);
  });

  it('stores the hash of what a peer presents, never the secret itself (4)', () => {
    const secret = newSecret();
    expect(secret.length).toBeGreaterThanOrEqual(43);
    expect(hashSecret(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(secret)).not.toContain(secret);
  });

  it('compares a presented secret to its hash, any length, without throwing (5)', () => {
    const h = hashSecret('right');
    expect(secretMatches('right', h)).toBe(true);
    expect(secretMatches('wrong', h)).toBe(false);
    expect(secretMatches('', h)).toBe(false);
    expect(secretMatches('right', 'not-a-hash')).toBe(false);
  });

  it.each([['', 'A machine needs a name.'], ['x'.repeat(41), 'A machine name is 40 characters at most.'], ['PC\nx', 'A machine name is one line of plain text.'], ['PC\u202Ex', 'A machine name is one line of plain text.']])
  ('refuses the name %j with a sentence (6)', (name, sentence) => {
    expect(() => cleanName(name)).toThrow(sentence);
  });

  it('trims a name (6)', () => {
    expect(cleanName('  PC de Nicolas  ')).toBe('PC de Nicolas');
  });
});
