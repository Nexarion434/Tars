# Machines, plan 1: the bridge, pairing and Settings > Machines

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** two Tars on Nicolas's tailnet (a Mac and a PC) pair once with a one-time code, then each knows whether the other is connected, under Settings > Machines.

**Architecture:** a second HTTP server per Tars, the machines bridge, separate from the loopback API: it listens on this machine's Tailscale address only, serves a short allow-list of `/machines/v1/*` routes, and admits a caller by a secret this Tars issued to that one machine at pairing. Pairing is a code shown on one machine and typed on the other; the code itself never travels, only an HMAC of it over a nonce. Main owns all state (`~/.tars-private/machines.json`, written as a secret file); the renderer reads one view over IPC and is told when it changes.

**Tech Stack:** Electron 44 main process (TypeScript, `node:http`, `node:crypto`), Next.js 16 renderer (React 19, the Settings components), vitest for units, Playwright driving two sandboxed Tars for E2E.

**Spec:** decisions and plan page https://claude.ai/artifact/A8eVtt9tfh716zxPXkiX9N (decided 2026-10-02 with Nicolas); frames `Settings · Machines`, `Dashboard · two machines`, `Panel · machine offline`, `Agents · two machines`, `Kanban · two machines` in `design/tars-redesign.pen` (commit 52742226, validated by Nicolas). Plans 2 and 3 (end of this file) build on this one.

## Global Constraints

- Nothing listens on `0.0.0.0` or `::`. The bridge binds the Tailscale IPv4 of this machine, or nothing. A development run (`app.isPackaged === false`) may name the address and port (`TARS_MACHINES_BIND`, `TARS_MACHINES_PORT`) and the peers to try (`TARS_MACHINES_PEERS`); a packaged Tars never reads them (same rule as `DOROTHY_TAILSCALE_BIN`).
- Never Tailscale Funnel, never `tailscale serve` for the bridge: binding the tailnet address is the whole exposure.
- The loopback API's master token (`~/.dorothy/api-token`) and Tars's internal pass never leave the machine and are never accepted by the bridge.
- Secrets live in `~/.tars-private/machines.json`, written with `writeSecretFileSync` (`electron/utils/secret-file.ts`); nothing under `~/.tars-private` is ever handed to a CLI.
- The bridge's routes are listed one by one; an unknown path is 404 before auth is even read for it, and no route reaches the loopback API's routes.
- Default permission of a newly paired machine on this one: `see`. `drive` is set by the machine being driven, never by the caller.
- Upstreamable: new code in new files (`electron/services/machines/`, `electron/handlers/machines-handlers.ts`, `src/components/Settings/MachinesSection.tsx`, `src/hooks/useMachines.ts`, `src/lib/machines.ts`); edits to upstream files are wiring only. No `if (win32)` outside `electron/platform/`.
- Copy: English in the interface (Tars's language), no em dash or en dash anywhere (`node scripts/check-dashes.mjs`). Controls 26 or 32 px, tokens only, `npm run lint:design` clean.
- No changelog entry in the fork (it would conflict at every upstream sync); the entry is written when the feature is proposed upstream.
- Tests: E2E first (two Tars in one spec), units written failures first with the failure list in the test file header, each test shown to bite (CLAUDE.md, Workflow Rule 3).

## Review Focus

1. Tailscale missing or stopped on one machine: Settings > Machines says so in one line, no listener is opened, nothing throws. Pinned in Task 4 (no bind target without an address) and Task 6 (`openOffer` refuses with the sentence, no code shown).
2. A machine paired, then unpaired by the other one while this one was off: its pings get 401; it must read "unpaired by PC" and offer to forget it, not "offline" forever. Pinned in Task 5 (status `unpaired`).
3. The code typed on the machine that shows it, or a second Tars on the same machine: pairing with oneself is refused by id. Pinned in Task 3 (`checkProof` refuses own id) and Task 5.
4. Clocks differ between the two machines: only the offering machine decides expiry, from its own clock; no timestamp crosses the wire. Pinned in Task 3 (expiry uses only the offer's clock).
5. First listen on a non-loopback address raises the OS firewall prompt (Windows Defender "allow on private networks", macOS "accept incoming connections"): the section must say why the prompt appears before it does. Written in Task 7 (the address row's hint, wrapped so it is read whole) and checked by hand on both machines (Task 9, Step 3).

---

## File Structure

| File | Responsibility |
|---|---|
| `electron/services/tailscale-status.ts` (new) | Ask the `tailscale` CLI for this machine's address and its online peers. Moved out of `hermes-handlers.ts`, which imports it. |
| `electron/services/machines/types.ts` (new) | The shapes: `MachinesFile`, `PairedMachine`, `MachinesView`, `PeerPermission`. |
| `electron/services/machines/store.ts` (new) | Read, normalize and write `~/.tars-private/machines.json`; secrets: mint, hash, compare. |
| `electron/services/machines/pairing.ts` (new) | The one-time offer: code, nonce, expiry, attempts, proof check. Pure, clock injected. |
| `electron/services/machines/bridge-server.ts` (new) | The bridge HTTP server: bind, auth, the allow-listed routes. |
| `electron/services/machines/client.ts` (new) | Calls to another bridge: hello, pair, ping, unpair. |
| `electron/services/machines/status.ts` (new) | Ping every paired machine on a timer; connected / offline / unpaired. |
| `electron/handlers/machines-handlers.ts` (new) | IPC for the renderer, and the `machines:changed` broadcast. |
| `electron/preload.ts`, `src/types/electron.d.ts` | The `machines` API, in one commit. |
| `electron/main.ts` | Register the handlers, start the bridge when a machine is paired, stop it on quit. |
| `src/lib/machines.ts` (new) | Pure renderer helpers: the status sentence, "seen 2 min ago". |
| `src/hooks/useMachines.ts` (new) | The view, kept current from `machines:changed`. |
| `src/components/Settings/MachinesSection.tsx` (new) | The section as drawn in `Settings · Machines`. |
| `src/components/Settings/constants.ts`, `types.ts`, `index.ts`, `src/app/settings/page.tsx` | The `Machines` group, its `machines` child, the header's `Add a machine`. |
| `design/UI-INVENTORY.md`, `e2e/surfaces.mjs` | The new surface `settings-machines`. |
| `e2e/machines-pairing.spec.ts` (new) | Two Tars pair, see each other, unpair. |
| `SECURITY.md`, `WINDOWS-PORT.md` | What the bridge is and is not; the lot's journal row. |

---

### Task 1: Tailscale status, shared

**Files:**
- Create: `electron/services/tailscale-status.ts`
- Modify: `electron/handlers/hermes-handlers.ts:250-296` (remove `tailscalePlaces` and `detectTailscale`, import them)
- Test: `__tests__/electron/services/tailscale-status.test.ts`

**Interfaces:**
- Produces:
  - `export interface TailscalePeer { name: string; dnsName?: string; ip: string; online: boolean; os?: string }`
  - `export interface TailscaleInfo { installed: boolean; running: boolean; dnsName?: string; ip?: string; serveConfigured: boolean; peers: TailscalePeer[] }`
  - `export function parseTailscaleStatus(json: unknown): Omit<TailscaleInfo, 'installed' | 'serveConfigured'>`
  - `export async function detectTailscale(): Promise<TailscaleInfo>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseTailscaleStatus } from '../../../electron/services/tailscale-status';

/**
 * What `tailscale status --json` says about this machine and its peers.
 * How it can fail, written before the code:
 * 1. A peer offline is offered as a pairing candidate.
 * 2. A peer with no IPv4 (IPv6 only) yields an empty or IPv6 address the
 *    bridge cannot bind or reach.
 * 3. The trailing dot of a MagicDNS name is kept ("pc.tail.ts.net.").
 * 4. Output that is not the expected shape throws instead of saying
 *    "not running".
 * 5. This machine (Self) is listed among its own peers.
 */
const status = {
  BackendState: 'Running',
  Self: { HostName: 'mac', DNSName: 'mac.example.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a::1'] },
  Peer: {
    k1: { HostName: 'pc', DNSName: 'pc.example.ts.net.', TailscaleIPs: ['100.64.0.2'], Online: true, OS: 'windows' },
    k2: { HostName: 'old', DNSName: 'old.example.ts.net.', TailscaleIPs: ['100.64.0.3'], Online: false, OS: 'macOS' },
    k3: { HostName: 'v6', DNSName: 'v6.example.ts.net.', TailscaleIPs: ['fd7a::9'], Online: true, OS: 'linux' },
  },
};

describe('parseTailscaleStatus', () => {
  it('reads this machine: running, its MagicDNS name without the dot, its IPv4 (2, 3)', () => {
    expect(parseTailscaleStatus(status)).toMatchObject({ running: true, dnsName: 'mac.example.ts.net', ip: '100.64.0.1' });
  });

  it('lists the peers with an IPv4, online or not, never itself (1, 2, 5)', () => {
    const { peers } = parseTailscaleStatus(status);
    expect(peers).toEqual([
      { name: 'pc', dnsName: 'pc.example.ts.net', ip: '100.64.0.2', online: true, os: 'windows' },
      { name: 'old', dnsName: 'old.example.ts.net', ip: '100.64.0.3', online: false, os: 'macOS' },
    ]);
  });

  it.each([null, 42, 'x', {}, { Self: 'nope', Peer: [] }])('reads %j as not running, with no peers (4)', (raw) => {
    expect(parseTailscaleStatus(raw)).toEqual({ running: false, peers: [] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/electron/services/tailscale-status.test.ts`
Expected: FAIL, cannot find module `tailscale-status`.

- [ ] **Step 3: Write the module**

```ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import { tailscaleCandidates } from '../platform';

const execFileAsync = promisify(execFile);

export interface TailscalePeer { name: string; dnsName?: string; ip: string; online: boolean; os?: string }
export interface TailscaleInfo {
  installed: boolean;
  running: boolean;
  dnsName?: string;
  ip?: string;
  serveConfigured: boolean;
  peers: TailscalePeer[];
}

const ipv4 = (ips: unknown): string | undefined =>
  Array.isArray(ips) ? ips.find((ip): ip is string => typeof ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) : undefined;
const bare = (name: unknown): string | undefined => (typeof name === 'string' && name ? name.replace(/\.$/, '') : undefined);

/** This machine and its tailnet peers from `tailscale status --json`; anything else reads as not running. */
export function parseTailscaleStatus(json: unknown): Omit<TailscaleInfo, 'installed' | 'serveConfigured'> {
  const s = json as { BackendState?: unknown; Self?: Record<string, unknown>; Peer?: Record<string, Record<string, unknown>> } | null;
  if (!s || typeof s !== 'object' || !s.Self || typeof s.Self !== 'object') return { running: false, peers: [] };
  const peers: TailscalePeer[] = [];
  if (s.Peer && typeof s.Peer === 'object' && !Array.isArray(s.Peer)) {
    for (const p of Object.values(s.Peer)) {
      const ip = ipv4(p?.TailscaleIPs);
      if (!ip) continue;
      peers.push({
        name: typeof p.HostName === 'string' ? p.HostName : ip,
        dnsName: bare(p.DNSName),
        ip,
        online: p.Online === true,
        os: typeof p.OS === 'string' ? p.OS : undefined,
      });
    }
  }
  return { running: s.BackendState === 'Running', dnsName: bare(s.Self.DNSName), ip: ipv4(s.Self.TailscaleIPs), peers };
}

/**
 * Where to look for `tailscale`: where this platform installs it
 * (tailscaleCandidates). A development run may name the one binary to ask,
 * or none with an empty value (DOROTHY_TAILSCALE_BIN): the e2e fixture
 * does. A packaged Tars never reads it.
 */
function tailscalePlaces(): string[] {
  const named = app?.isPackaged ? undefined : process.env.DOROTHY_TAILSCALE_BIN;
  if (named === undefined) return tailscaleCandidates();
  return named.trim() ? [named] : [];
}

export async function detectTailscale(): Promise<TailscaleInfo> {
  for (const bin of tailscalePlaces()) {
    try {
      const { stdout } = await execFileAsync(bin, ['status', '--json'], { timeout: 4000, windowsHide: true });
      const parsed = parseTailscaleStatus(JSON.parse(stdout));
      let serveConfigured = false;
      try {
        const { stdout: serveOut } = await execFileAsync(bin, ['serve', 'status'], { timeout: 4000, windowsHide: true });
        serveConfigured = !/no serve config/i.test(serveOut) && serveOut.trim().length > 0;
      } catch { /* serve status exits non-zero when unconfigured on some versions */ }
      return { installed: true, serveConfigured, ...parsed };
    } catch { /* try the next candidate */ }
  }
  return { installed: false, running: false, serveConfigured: false, peers: [] };
}
```

In `electron/handlers/hermes-handlers.ts`, delete the local `TailscaleInfo` interface, `tailscalePlaces` and `detectTailscale` (lines 243-296 as of 30d74760), and add `import { detectTailscale } from '../services/tailscale-status';`. The Hermes handler keeps returning `tailscale` with the same fields plus `peers`, which the renderer ignores.

- [ ] **Step 4: Run the new test and the Hermes tests**

Run: `npx vitest run __tests__/electron/services/tailscale-status.test.ts __tests__/electron/handlers/hermes*`
Expected: PASS, and the Hermes tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add electron/services/tailscale-status.ts electron/handlers/hermes-handlers.ts __tests__/electron/services/tailscale-status.test.ts
git commit -m "chore: what tailscale says about this machine and its peers is read in one place, for hermes and for machines"
```

---

### Task 2: The machines file and its secrets

**Files:**
- Create: `electron/services/machines/types.ts`, `electron/services/machines/store.ts`
- Test: `__tests__/electron/machines/store.test.ts`

**Interfaces:**
- Produces (`types.ts`):

```ts
export type PeerPermission = 'see' | 'drive';
export interface MachineSelf { id: string; name: string }
export interface PairedMachine {
  id: string;
  name: string;
  /** Where its bridge answers: its tailnet IPv4 (or 127.0.0.1 in a development run). */
  address: string;
  port: number;
  /** sha256 of the secret this Tars issued to it: what it presents here. */
  inboundSecretHash: string;
  /** The secret it issued to this Tars: what this Tars presents there. */
  outboundSecret: string;
  /** What it may do on this machine. */
  mayOnMe: PeerPermission;
  pairedAt: string;
}
export interface MachinesFile { version: 1; self: MachineSelf; peers: PairedMachine[] }
export type PeerStatus = 'connected' | 'offline' | 'unpaired' | 'unknown';
export interface MachineView {
  id: string; name: string; address: string; mayOnMe: PeerPermission;
  status: PeerStatus; lastSeen?: string; agentsRunning?: number;
}
export interface MachinesView {
  self: MachineSelf & { address?: string };
  tailscale: { installed: boolean; running: boolean };
  bridge: { listening: boolean; reason?: string };
  offer: { code: string; expiresAt: string } | null;
  peers: MachineView[];
}
```

- Produces (`store.ts`):
  - `export const MACHINES_FILE: string` (`privatePath('machines.json')`)
  - `export function readMachines(): MachinesFile`
  - `export function writeMachines(file: MachinesFile): void`
  - `export function newSecret(): string`
  - `export function hashSecret(secret: string): string`
  - `export function secretMatches(presented: string, hash: string): boolean`
  - `export function cleanName(name: unknown): string` (throws an `Error` whose message is the sentence the page shows)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
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
 * 6. A name that is empty, 80 characters long, or holds a line break or a
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

  it('reads a malformed file as no peers, keeping a readable self (2)', () => {
    fs.mkdirSync(require('path').dirname(MACHINES_FILE), { recursive: true });
    fs.writeFileSync(MACHINES_FILE, '{nope');
    expect(readMachines().peers).toEqual([]);
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

  it.each([['', 'A machine needs a name.'], ['x'.repeat(41), 'A machine name is 40 characters at most.'], ['PC\nx', 'A machine name is one line of plain text.'], ['PC‮x', 'A machine name is one line of plain text.']])
  ('refuses the name %j with a sentence (6)', (name, sentence) => {
    expect(() => cleanName(name)).toThrow(sentence);
  });

  it('trims a name (6)', () => {
    expect(cleanName('  PC de Nicolas  ')).toBe('PC de Nicolas');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/electron/machines/store.test.ts`
Expected: FAIL, cannot find module `store`.

- [ ] **Step 3: Write the two modules**

`types.ts`: the block under Interfaces, verbatim.

`store.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { privatePath } from '../../constants';
import { writeSecretFileSync } from '../../utils/secret-file';
import type { MachinesFile, PairedMachine } from './types';

export const MACHINES_FILE = privatePath('machines.json');

const HIDDEN_OR_LINE_BREAKING = /[\p{Zl}\p{Zp}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

export function cleanName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new Error('A machine needs a name.');
  if ([...n].length > 40) throw new Error('A machine name is 40 characters at most.');
  if (HIDDEN_OR_LINE_BREAKING.test(n)) throw new Error('A machine name is one line of plain text.');
  return n;
}

export const newSecret = (): string => randomBytes(32).toString('base64url');
export const hashSecret = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex');

export function secretMatches(presented: string, hash: string): boolean {
  if (!presented || !/^[0-9a-f]{64}$/.test(hash)) return false;
  return timingSafeEqual(Buffer.from(hashSecret(presented), 'hex'), Buffer.from(hash, 'hex'));
}

const isPeer = (p: unknown): p is PairedMachine => {
  const x = p as Record<string, unknown>;
  return !!x && typeof x.id === 'string' && /^m-[0-9a-f]{16}$/.test(x.id)
    && typeof x.name === 'string' && typeof x.address === 'string'
    && Number.isInteger(x.port) && (x.port as number) > 0 && (x.port as number) < 65536
    && typeof x.inboundSecretHash === 'string' && /^[0-9a-f]{64}$/.test(x.inboundSecretHash)
    && typeof x.outboundSecret === 'string' && x.outboundSecret.length > 0
    && (x.mayOnMe === 'see' || x.mayOnMe === 'drive') && typeof x.pairedAt === 'string';
};

export function readMachines(): MachinesFile {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(fs.readFileSync(MACHINES_FILE, 'utf8')); } catch { /* none yet, or unreadable */ }
  const self = raw.self as Record<string, unknown> | undefined;
  const hasSelf = !!self && typeof self.id === 'string' && /^m-[0-9a-f]{16}$/.test(self.id) && typeof self.name === 'string';
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run __tests__/electron/machines/store.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Show it bites, then commit**

Mutants, one at a time: remove the `mayOnMe` check from `isPeer` (case 3 fails); let `readMachines` draw a new id when the file has one (case 1 fails). Restore.

```bash
git add electron/services/machines/types.ts electron/services/machines/store.ts __tests__/electron/machines/store.test.ts
git commit -m "feat: machines.json in the private directory: this machine's id and name, its paired machines, their secrets hashed"
```

---

### Task 3: The pairing offer

**Files:**
- Create: `electron/services/machines/pairing.ts`
- Test: `__tests__/electron/machines/pairing.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Offer { code: string; nonce: string; expiresAt: number; attempts: number; closed: boolean }
export const OFFER_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 5;
export function openOffer(now: number, random?: (n: number) => Buffer): Offer;
export function codeProof(code: string, nonce: string, callerId: string): string;
export type ProofVerdict = 'ok' | 'expired' | 'wrong' | 'closed' | 'self';
export function checkProof(offer: Offer, proof: string, callerId: string, selfId: string, now: number): ProofVerdict;
export function formatCode(code: string): string; // "482913" -> "482 913"
```

- [ ] **Step 1: Write the failing test**

```ts
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
 *    closed by Cancel.
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
    expect(checkProof(o, proof, PC, SELF, 1)).toBe('ok');
    expect(checkProof({ ...openOffer(0), code: o.code }, proof, PC, SELF, 1)).toBe('wrong');
    expect(checkProof(o, codeProof(o.code, o.nonce, 'm-cccccccccccccccc'), PC, SELF, 1)).toBe('wrong');
  });

  it('closes after five wrong proofs (4)', () => {
    const o = openOffer(0);
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(checkProof(o, 'x', PC, SELF, 1)).toBe('wrong');
    expect(checkProof(o, codeProof(o.code, o.nonce, PC), PC, SELF, 1)).toBe('closed');
  });

  it('works once, not after its five minutes, not once closed (5, 7)', () => {
    const o = openOffer(0);
    const proof = codeProof(o.code, o.nonce, PC);
    expect(checkProof(o, proof, PC, SELF, OFFER_MS + 1)).toBe('expired');
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/electron/machines/pairing.test.ts`
Expected: FAIL, cannot find module `pairing`.

- [ ] **Step 3: Write the module**

```ts
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';

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

export const formatCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run __tests__/electron/machines/pairing.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Bite and commit**

Mutant: drop `offer.closed = true` on `'ok'`; case 5 fails. Restore.

```bash
git add electron/services/machines/pairing.ts __tests__/electron/machines/pairing.test.ts
git commit -m "feat: a one-time pairing code: six digits, proved over a nonce, five tries, five minutes"
```

---

### Task 4: The bridge server

**Files:**
- Create: `electron/services/machines/bridge-server.ts`
- Test: `__tests__/electron/machines/bridge-server.test.ts`

**Interfaces:**
- Consumes: `readMachines`, `writeMachines`, `newSecret`, `hashSecret`, `secretMatches`, `cleanName` (Task 2); `Offer`, `openOffer`, `checkProof` (Task 3); `detectTailscale` (Task 1).
- Produces:

```ts
export const MACHINES_PORT_DEFAULT = 31416;
export interface BridgeDeps {
  /** Agents running on this machine, for ping. */
  runningAgents: () => number;
  /** Told after a pairing or an unpairing changed the file. */
  onChanged: () => void;
  now?: () => number;
}
export interface BindTarget { host: string; port: number }
export function resolveBindTarget(env: NodeJS.ProcessEnv, packaged: boolean, tailnetIp: string | undefined): BindTarget | { reason: string };
export async function startBridge(deps: BridgeDeps): Promise<{ listening: boolean; reason?: string }>;
export function stopBridge(): Promise<void>;
export function bridgeState(): { listening: boolean; reason?: string; target?: BindTarget };
export function openPairingOffer(): Offer;   // starts the bridge if needed
export function closePairingOffer(): void;
export function currentOffer(): Offer | null; // null once closed or expired
/** For tests: the request handler without a socket. */
export function handleBridgeRequest(req: import('http').IncomingMessage, res: import('http').ServerResponse, deps: BridgeDeps): Promise<void>;
```

Routes (the whole allow-list):

| Method, path | Auth | Answer |
|---|---|---|
| `GET /machines/v1/hello` | none | 200 `{ id, name, nonce }` while an offer is open; 404 otherwise |
| `POST /machines/v1/pair` | none, the proof | body `{ id, name, port, proof, secret }`; 200 `{ id, name, secret }` on `ok`; 403 `{ error }` otherwise |
| `GET /machines/v1/ping` | peer secret | 200 `{ id, name, agentsRunning }` |
| `POST /machines/v1/unpair` | peer secret | 200 `{ ok: true }`, the caller is forgotten here |

Everything else: 404. A request with an `Origin` header: 403 (no browser ever calls the bridge). Body over 64 KB: 413. A secret that matches no peer: 401 `{ error: 'Unauthorized' }`, the same whatever was wrong.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { AddressInfo } from 'net';
import { handleBridgeRequest, openPairingOffer, closePairingOffer, resolveBindTarget } from '../../../electron/services/machines/bridge-server';
import { MACHINES_FILE, readMachines, writeMachines, hashSecret } from '../../../electron/services/machines/store';
import { codeProof } from '../../../electron/services/machines/pairing';

/**
 * The machines bridge, driven over a real socket on 127.0.0.1. How it can
 * fail, written before the code:
 * 1. It binds 0.0.0.0, or binds anything when Tailscale gives no address.
 * 2. The development overrides (address, port) work in a packaged Tars.
 * 3. A route of the loopback API answers here (/api/agents), or an unknown
 *    path tells whether auth passed.
 * 4. hello answers with no offer open, so a prober learns a Tars is here
 *    and when a code is shown.
 * 5. pair accepts a wrong proof, a second time, or stores the secret the
 *    caller sent in clear in place of its hash.
 * 6. ping or unpair answer with no secret, the master token, or another
 *    peer's secret.
 * 7. A browser page reaches it (an Origin header), or a large body is read
 *    whole.
 * 8. pair answers before the file is written, so a crash in between leaves
 *    one side paired and the other not.
 */
let server: http.Server;
let base: string;
let changed = 0;
const deps = { runningAgents: () => 2, onChanged: () => { changed++; } };
const PC = 'm-bbbbbbbbbbbbbbbb';

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
}

beforeEach(async () => {
  fs.rmSync(MACHINES_FILE, { force: true });
  changed = 0;
  closePairingOffer();
  server = http.createServer((req, res) => { void handleBridgeRequest(req, res, deps); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>(r => server.close(() => r())));

describe('where the bridge listens', () => {
  it('on the tailnet address, never 0.0.0.0, and nowhere without one (1)', () => {
    expect(resolveBindTarget({}, true, '100.64.0.1')).toEqual({ host: '100.64.0.1', port: 31416 });
    expect(resolveBindTarget({}, true, undefined)).toEqual({ reason: expect.stringContaining('Tailscale') });
    expect(resolveBindTarget({ TARS_MACHINES_BIND: '0.0.0.0' }, false, undefined)).toEqual({ reason: expect.any(String) });
  });

  it('takes the development overrides only when not packaged (2)', () => {
    const env = { TARS_MACHINES_BIND: '127.0.0.1', TARS_MACHINES_PORT: '31999' };
    expect(resolveBindTarget(env, false, '100.64.0.1')).toEqual({ host: '127.0.0.1', port: 31999 });
    expect(resolveBindTarget(env, true, '100.64.0.1')).toEqual({ host: '100.64.0.1', port: 31416 });
  });
});

describe('what it answers', () => {
  it('answers nothing of the loopback API, the same 404 with or without a secret (3)', async () => {
    expect((await call('GET', '/api/agents')).status).toBe(404);
    expect((await call('GET', '/api/agents', undefined, { authorization: 'Bearer x' })).status).toBe(404);
  });

  it('says hello only while an offer is open (4)', async () => {
    expect((await call('GET', '/machines/v1/hello')).status).toBe(404);
    const offer = openPairingOffer();
    const hello = await call('GET', '/machines/v1/hello');
    expect(hello.status).toBe(200);
    expect(hello.body).toEqual({ id: readMachines().self.id, name: readMachines().self.name, nonce: offer.nonce });
  });

  it('pairs once on the right proof, keeps the hash of what it issued, writes before answering (5, 8)', async () => {
    const offer = openPairingOffer();
    const wrong = await call('POST', '/machines/v1/pair', { id: PC, name: 'PC', port: 31416, proof: '0'.repeat(64), secret: 'theirs' });
    expect(wrong.status).toBe(403);
    const ok = await call('POST', '/machines/v1/pair', { id: PC, name: 'PC', port: 31416, proof: codeProof(offer.code, offer.nonce, PC), secret: 'theirs' });
    expect(ok.status).toBe(200);
    const issued = ok.body!.secret as string;
    const peer = readMachines().peers.find(p => p.id === PC)!;
    expect(peer).toMatchObject({ name: 'PC', address: '127.0.0.1', port: 31416, outboundSecret: 'theirs', mayOnMe: 'see', inboundSecretHash: hashSecret(issued) });
    expect(JSON.stringify(readMachines())).not.toContain(issued);
    expect(changed).toBe(1);
    expect((await call('POST', '/machines/v1/pair', { id: PC, name: 'PC', port: 31416, proof: codeProof(offer.code, offer.nonce, PC), secret: 'again' })).status).toBe(403);
  });

  it('pings and unpairs for the peer secret only (6)', async () => {
    const self = readMachines().self;
    writeMachines({ version: 1, self, peers: [{ id: PC, name: 'PC', address: '127.0.0.1', port: 1, inboundSecretHash: hashSecret('pc-secret'), outboundSecret: 'x', mayOnMe: 'see', pairedAt: '2026-10-02T00:00:00Z' }] });
    expect((await call('GET', '/machines/v1/ping')).status).toBe(401);
    expect((await call('GET', '/machines/v1/ping', undefined, { authorization: 'Bearer other' })).status).toBe(401);
    expect((await call('GET', '/machines/v1/ping', undefined, { authorization: 'Bearer pc-secret' })).body).toEqual({ id: self.id, name: self.name, agentsRunning: 2 });
    expect((await call('POST', '/machines/v1/unpair', {}, { authorization: 'Bearer pc-secret' })).status).toBe(200);
    expect(readMachines().peers).toEqual([]);
  });

  it('refuses a browser and a large body (7)', async () => {
    expect((await call('GET', '/machines/v1/ping', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    openPairingOffer();
    expect((await call('POST', '/machines/v1/pair', { pad: 'x'.repeat(70_000) })).status).toBe(413);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/electron/machines/bridge-server.test.ts`
Expected: FAIL, cannot find module `bridge-server`.

- [ ] **Step 3: Write the module**

```ts
import * as http from 'http';
import { app } from 'electron';
import { readMachines, writeMachines, newSecret, hashSecret, secretMatches, cleanName } from './store';
import { Offer, openOffer, checkProof } from './pairing';
import { detectTailscale } from '../tailscale-status';
import type { PairedMachine } from './types';

export const MACHINES_PORT_DEFAULT = 31416;
const MAX_BODY = 64 * 1024;

export interface BridgeDeps { runningAgents: () => number; onChanged: () => void; now?: () => number }
export interface BindTarget { host: string; port: number }

let server: http.Server | null = null;
let state: { listening: boolean; reason?: string; target?: BindTarget } = { listening: false, reason: 'Not started.' };
let offer: Offer | null = null;
let activeDeps: BridgeDeps | null = null;

const isIpv4 = (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s) && s !== '0.0.0.0';

export function resolveBindTarget(env: NodeJS.ProcessEnv, packaged: boolean, tailnetIp: string | undefined): BindTarget | { reason: string } {
  if (!packaged && env.TARS_MACHINES_BIND !== undefined) {
    const host = env.TARS_MACHINES_BIND.trim();
    // 0 is a port: the OS picks a free one (the handlers' test uses it).
    const raw = env.TARS_MACHINES_PORT;
    const port = raw !== undefined && raw.trim() !== '' && Number.isInteger(Number(raw)) ? Number(raw) : MACHINES_PORT_DEFAULT;
    return isIpv4(host) ? { host, port } : { reason: `TARS_MACHINES_BIND must be one IPv4 address, not ${host || 'empty'}.` };
  }
  if (!tailnetIp || !isIpv4(tailnetIp)) return { reason: 'Tailscale is not running on this machine, so no other machine can reach it.' };
  return { host: tailnetIp, port: MACHINES_PORT_DEFAULT };
}

const now = () => (activeDeps?.now ?? Date.now)();
export const currentOffer = (): Offer | null => (offer && !offer.closed && now() <= offer.expiresAt ? offer : null);
export const bridgeState = () => ({ ...state });

export function openPairingOffer(): Offer {
  offer = openOffer(now());
  return offer;
}
export function closePairingOffer(): void { if (offer) offer.closed = true; offer = null; }

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown> | 'too-large'> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return 'too-large';
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

const peerFor = (authorization: string | undefined): PairedMachine | undefined => {
  const presented = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  return presented ? readMachines().peers.find(p => secretMatches(presented, p.inboundSecretHash)) : undefined;
};

const ROUTES = new Set(['GET /machines/v1/hello', 'POST /machines/v1/pair', 'GET /machines/v1/ping', 'POST /machines/v1/unpair']);

export async function handleBridgeRequest(req: http.IncomingMessage, res: http.ServerResponse, deps: BridgeDeps): Promise<void> {
  activeDeps = deps;
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.origin) return send(403, { error: 'Forbidden' });
  const path = new URL(req.url || '/', 'http://bridge').pathname;
  const key = `${req.method} ${path}`;
  if (!ROUTES.has(key)) return send(404, { error: 'Not found' });

  if (key === 'GET /machines/v1/hello') {
    const open = currentOffer();
    if (!open) return send(404, { error: 'Not found' });
    const { self } = readMachines();
    return send(200, { id: self.id, name: self.name, nonce: open.nonce });
  }

  if (key === 'POST /machines/v1/pair') {
    const body = await readBody(req);
    if (body === 'too-large') return send(413, { error: 'Too large' });
    const open = currentOffer();
    const file = readMachines();
    const id = typeof body.id === 'string' && /^m-[0-9a-f]{16}$/.test(body.id) ? body.id : '';
    const port = Number(body.port);
    const theirs = typeof body.secret === 'string' && body.secret.length >= 32 ? body.secret : '';
    let name = '';
    try { name = cleanName(body.name); } catch { /* refused below */ }
    const verdict = open && id && theirs && name && Number.isInteger(port) && port > 0 && port < 65536
      ? checkProof(open, typeof body.proof === 'string' ? body.proof : '', id, file.self.id, now())
      : 'wrong';
    if (verdict !== 'ok') return send(403, { error: verdict === 'self' ? 'A machine does not pair with itself.' : 'That code is not the one this machine shows, or it expired.' });
    const issued = newSecret();
    const address = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const peers = file.peers.filter(p => p.id !== id);
    peers.push({ id, name, address, port, inboundSecretHash: hashSecret(issued), outboundSecret: theirs, mayOnMe: 'see', pairedAt: new Date(now()).toISOString() });
    writeMachines({ ...file, peers });
    offer = null;
    deps.onChanged();
    return send(200, { id: file.self.id, name: file.self.name, secret: issued });
  }

  const peer = peerFor(req.headers.authorization);
  if (!peer) return send(401, { error: 'Unauthorized' });

  if (key === 'GET /machines/v1/ping') {
    const { self } = readMachines();
    return send(200, { id: self.id, name: self.name, agentsRunning: deps.runningAgents() });
  }

  // POST /machines/v1/unpair
  const file = readMachines();
  writeMachines({ ...file, peers: file.peers.filter(p => p.id !== peer.id) });
  deps.onChanged();
  return send(200, { ok: true });
}

export async function startBridge(deps: BridgeDeps): Promise<{ listening: boolean; reason?: string }> {
  activeDeps = deps;
  if (server) return bridgeState();
  const tailscale = await detectTailscale();
  const target = resolveBindTarget(process.env, app?.isPackaged ?? true, tailscale.ip);
  if ('reason' in target) { state = { listening: false, reason: target.reason }; return bridgeState(); }
  const created = http.createServer((req, res) => { void handleBridgeRequest(req, res, deps).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } }); });
  await new Promise<void>((resolve) => {
    created.once('error', (err: NodeJS.ErrnoException) => { state = { listening: false, reason: `The bridge could not listen on ${target.host}:${target.port} (${err.code}).` }; resolve(); });
    created.listen(target.port, target.host, () => { server = created; state = { listening: true, target }; resolve(); });
  });
  return bridgeState();
}

export function stopBridge(): Promise<void> {
  const s = server;
  server = null;
  state = { listening: false, reason: 'Stopped.' };
  return new Promise(resolve => (s ? s.close(() => resolve()) : resolve()));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run __tests__/electron/machines/bridge-server.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Bite and commit**

Mutants, one at a time, each turning one case red: answer hello without `currentOffer()` (case 4); store `inboundSecretHash: issued` (case 5); accept `TARS_MACHINES_BIND` when packaged (case 2). Restore.

```bash
git add electron/services/machines/bridge-server.ts __tests__/electron/machines/bridge-server.test.ts
git commit -m "feat: the machines bridge: four routes on the tailnet address, a secret per paired machine, nothing of the local api"
```

---

### Task 5: The client and the status of each machine

**Files:**
- Create: `electron/services/machines/client.ts`, `electron/services/machines/status.ts`
- Test: `__tests__/electron/machines/client.test.ts`

**Interfaces:**
- Consumes: Task 2 store, Task 3 `codeProof`, Task 4 `handleBridgeRequest` (the test runs a real bridge on 127.0.0.1), Task 1 `detectTailscale`.
- Produces:

```ts
// client.ts
export interface Candidate { host: string; port: number }
export function candidatesFrom(env: NodeJS.ProcessEnv, packaged: boolean, peers: { ip: string; online: boolean }[]): Candidate[];
export type PairResult = { ok: true; name: string } | { ok: false; error: string };
export async function pairWithCode(code: string, candidates: Candidate[], myPort: number): Promise<PairResult>;
export type PingResult = { status: 'connected'; agentsRunning: number } | { status: 'offline' } | { status: 'unpaired' };
export async function ping(peer: PairedMachine): Promise<PingResult>;
export async function unpairPeer(peerId: string): Promise<void>; // tells the other side (best effort), forgets it here
// status.ts
export function startStatusPolling(onChanged: () => void, everyMs?: number): void; // default 10_000
export function stopStatusPolling(): void;
export function peerStatus(id: string): { status: PeerStatus; lastSeen?: string; agentsRunning?: number };
```

`pairWithCode` steps: for each candidate, `GET /machines/v1/hello` (2 s timeout); the first that answers 200 gets `POST /machines/v1/pair` with `{ id: self.id, name: self.name, port: myPort, proof: codeProof(code.replace(/\D/g, ''), hello.nonce, self.id), secret: newSecret() }`; on 200 the peer is stored with `inboundSecretHash: hashSecret(thatSecret)`, `outboundSecret: answer.secret`, `mayOnMe: 'see'`. Errors, as sentences the page shows: no candidate answered hello: `No machine on your tailnet shows a pairing code. Click Add a machine on the other machine first.`; 403: the error the other side sent; a code that is not six digits: `A pairing code is six digits.`

`ping`: `GET /machines/v1/ping` with `Authorization: Bearer <outboundSecret>`, 3 s timeout. 200: connected; 401: unpaired (the other side forgot this one); anything else or no answer: offline.

`candidatesFrom`: in a development run `TARS_MACHINES_PEERS="127.0.0.1:31484,127.0.0.1:31486"` replaces the tailnet peers; otherwise every online peer, port `MACHINES_PORT_DEFAULT`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import { AddressInfo } from 'net';
import { handleBridgeRequest, openPairingOffer, closePairingOffer } from '../../../electron/services/machines/bridge-server';
import { pairWithCode, ping, candidatesFrom } from '../../../electron/services/machines/client';
import { MACHINES_FILE } from '../../../electron/services/machines/store';
import { formatCode } from '../../../electron/services/machines/pairing';

/**
 * This Tars calling another one, over 127.0.0.1. One process has one
 * machines file, so a whole pairing (two selves) is proved by the E2E
 * (Task 8), where each Tars has its own home; here, the paths a single side
 * decides. How it can fail, written before the code:
 * 1. A code that is not six digits is sent at all.
 * 2. No machine shows a code and the page says nothing useful.
 * 3. A machine that forgot this one reads as offline forever (Review Focus 2).
 * 4. A machine that does not answer hangs the poll.
 * 5. Offline peers are tried as candidates, or the development peer list
 *    is honoured in a packaged Tars.
 */
let server: http.Server;
let port: number;
beforeEach(async () => {
  fs.rmSync(MACHINES_FILE, { force: true });
  closePairingOffer();
  server = http.createServer((req, res) => { void handleBridgeRequest(req, res, { runningAgents: () => 3, onChanged: () => {} }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => new Promise<void>(r => server.close(() => r())));

describe('candidates', () => {
  it('are the online peers on 31416, or the development list when not packaged (5)', () => {
    const peers = [{ ip: '100.64.0.2', online: true }, { ip: '100.64.0.3', online: false }];
    expect(candidatesFrom({}, true, peers)).toEqual([{ host: '100.64.0.2', port: 31416 }]);
    expect(candidatesFrom({ TARS_MACHINES_PEERS: '127.0.0.1:31484' }, false, peers)).toEqual([{ host: '127.0.0.1', port: 31484 }]);
    expect(candidatesFrom({ TARS_MACHINES_PEERS: '127.0.0.1:31484' }, true, peers)).toEqual([{ host: '100.64.0.2', port: 31416 }]);
  });
});

describe('pairing with a code', () => {
  it('says what to do when no machine shows a code (2)', async () => {
    expect(await pairWithCode('482913', [{ host: '127.0.0.1', port }], 31416)).toEqual({ ok: false, error: 'No machine on your tailnet shows a pairing code. Click Add a machine on the other machine first.' });
  });

  it('sends nothing for a code that is not six digits, and takes one with its space (1)', async () => {
    openPairingOffer();
    expect(await pairWithCode('48291', [{ host: '127.0.0.1', port }], 31416)).toEqual({ ok: false, error: 'A pairing code is six digits.' });
    // Six digits with the page's space reach the other side; here that side is
    // this same machine, which refuses to pair with itself: proof the code was read.
    const offer = openPairingOffer();
    expect(await pairWithCode(formatCode(offer.code), [{ host: '127.0.0.1', port }], 31416)).toEqual({ ok: false, error: 'A machine does not pair with itself.' });
  });
});

describe('ping', () => {
  it('reads 401 as unpaired, no answer as offline, quickly (3, 4)', async () => {
    const peer = { id: 'm-3333333333333333', name: 'PC', address: '127.0.0.1', port, inboundSecretHash: '0'.repeat(64), outboundSecret: 'not-known-there', mayOnMe: 'see' as const, pairedAt: '' };
    expect(await ping(peer)).toEqual({ status: 'unpaired' });
    const started = Date.now();
    expect(await ping({ ...peer, address: '10.255.255.1', port: 9 })).toEqual({ status: 'offline' });
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/electron/machines/client.test.ts`
Expected: FAIL, cannot find module `client`.

- [ ] **Step 3: Write `client.ts` and `status.ts`**

```ts
// client.ts
import * as http from 'http';
import { readMachines, writeMachines, newSecret, hashSecret } from './store';
import { codeProof } from './pairing';
import { MACHINES_PORT_DEFAULT } from './bridge-server';
import type { PairedMachine } from './types';

export interface Candidate { host: string; port: number }
export type PairResult = { ok: true; name: string } | { ok: false; error: string };
export type PingResult = { status: 'connected'; agentsRunning: number } | { status: 'offline' } | { status: 'unpaired' };

function request(c: Candidate, method: string, path: string, opts: { secret?: string; body?: unknown; timeoutMs: number }): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request({ host: c.host, port: c.port, path, method, timeout: opts.timeoutMs, headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(opts.secret ? { Authorization: `Bearer ${opts.secret}` } : {}),
    } }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => { let body = {}; try { body = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, body }); });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, body: {} }));
    if (data) req.write(data);
    req.end();
  });
}

export function candidatesFrom(env: NodeJS.ProcessEnv, packaged: boolean, peers: { ip: string; online: boolean }[]): Candidate[] {
  if (!packaged && env.TARS_MACHINES_PEERS) {
    return env.TARS_MACHINES_PEERS.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const [host, port] = s.split(':');
      return { host, port: Number(port) || MACHINES_PORT_DEFAULT };
    });
  }
  return peers.filter(p => p.online).map(p => ({ host: p.ip, port: MACHINES_PORT_DEFAULT }));
}

export async function pairWithCode(typed: string, candidates: Candidate[], myPort: number): Promise<PairResult> {
  const code = typed.replace(/\D/g, '');
  if (code.length !== 6) return { ok: false, error: 'A pairing code is six digits.' };
  const file = readMachines();
  for (const c of candidates) {
    const hello = await request(c, 'GET', '/machines/v1/hello', { timeoutMs: 2_000 });
    if (hello.status !== 200 || typeof hello.body.nonce !== 'string') continue;
    const mine = newSecret();
    const answer = await request(c, 'POST', '/machines/v1/pair', { timeoutMs: 5_000, body: {
      id: file.self.id, name: file.self.name, port: myPort, proof: codeProof(code, hello.body.nonce, file.self.id), secret: mine,
    } });
    if (answer.status !== 200) return { ok: false, error: typeof answer.body.error === 'string' ? answer.body.error : 'The other machine refused the code.' };
    const id = String(answer.body.id);
    const name = String(answer.body.name);
    const latest = readMachines();
    writeMachines({ ...latest, peers: [...latest.peers.filter(p => p.id !== id), {
      id, name, address: c.host, port: c.port, inboundSecretHash: hashSecret(mine), outboundSecret: String(answer.body.secret), mayOnMe: 'see', pairedAt: new Date().toISOString(),
    }] });
    return { ok: true, name };
  }
  return { ok: false, error: 'No machine on your tailnet shows a pairing code. Click Add a machine on the other machine first.' };
}

export async function ping(peer: PairedMachine): Promise<PingResult> {
  const r = await request({ host: peer.address, port: peer.port }, 'GET', '/machines/v1/ping', { secret: peer.outboundSecret, timeoutMs: 3_000 });
  if (r.status === 200) return { status: 'connected', agentsRunning: Number(r.body.agentsRunning) || 0 };
  if (r.status === 401) return { status: 'unpaired' };
  return { status: 'offline' };
}

export async function unpairPeer(peerId: string): Promise<void> {
  const file = readMachines();
  const peer = file.peers.find(p => p.id === peerId);
  if (!peer) return;
  await request({ host: peer.address, port: peer.port }, 'POST', '/machines/v1/unpair', { secret: peer.outboundSecret, body: {}, timeoutMs: 3_000 });
  const latest = readMachines();
  writeMachines({ ...latest, peers: latest.peers.filter(p => p.id !== peerId) });
}
```

```ts
// status.ts
import { readMachines } from './store';
import { ping } from './client';
import type { PeerStatus } from './types';

const known = new Map<string, { status: PeerStatus; lastSeen?: string; agentsRunning?: number }>();
let timer: NodeJS.Timeout | null = null;

export const peerStatus = (id: string) => known.get(id) ?? { status: 'unknown' as PeerStatus };

async function pollOnce(onChanged: () => void): Promise<void> {
  let moved = false;
  for (const peer of readMachines().peers) {
    const r = await ping(peer);
    const before = known.get(peer.id);
    const next = r.status === 'connected'
      ? { status: r.status, lastSeen: new Date().toISOString(), agentsRunning: r.agentsRunning }
      : { status: r.status as PeerStatus, lastSeen: before?.lastSeen };
    if (before?.status !== next.status || before?.agentsRunning !== next.agentsRunning) moved = true;
    known.set(peer.id, next);
  }
  if (moved) onChanged();
}

export function startStatusPolling(onChanged: () => void, everyMs = 10_000): void {
  if (timer) return;
  void pollOnce(onChanged);
  timer = setInterval(() => { void pollOnce(onChanged); }, everyMs);
}

export function stopStatusPolling(): void { if (timer) clearInterval(timer); timer = null; }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run __tests__/electron/machines/`
Expected: PASS, all machines units.

- [ ] **Step 5: Bite and commit**

Mutant: in `ping`, map 401 to offline; case 3 fails. Restore.

```bash
git add electron/services/machines/client.ts electron/services/machines/status.ts __tests__/electron/machines/client.test.ts
git commit -m "feat: pair with the code another machine shows, and know whether each paired machine is connected, offline or has forgotten this one"
```

---

### Task 6: IPC, preload and main wiring

**Files:**
- Create: `electron/handlers/machines-handlers.ts`
- Modify: `electron/preload.ts` (a `machines` block beside `claudeAccounts`), `src/types/electron.d.ts` (its types), `electron/main.ts` (register, start, stop)
- Test: `__tests__/electron/handlers/machines-handlers.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 5.
- Produces: IPC channels and the preload API:

```ts
// window.electronAPI.machines
view(): Promise<MachinesView>;
setName(name: string): Promise<{ success: true } | { success: false; error: string }>;
openOffer(): Promise<{ success: true; code: string; expiresAt: string } | { success: false; error: string }>;
closeOffer(): Promise<{ success: true }>;
pair(code: string): Promise<{ success: true; name: string } | { success: false; error: string }>;
setPermission(id: string, mayOnMe: 'see' | 'drive'): Promise<{ success: true } | { success: false; error: string }>;
unpair(id: string): Promise<{ success: true }>;
onChanged(cb: () => void): () => void; // 'machines:changed'
```

Rules in the handlers: `openOffer` starts the bridge if it is not listening and returns its reason as the error when it cannot listen; the code is returned formatted (`482 913`). The bridge is started at launch when `readMachines().peers.length > 0`, and stopped in the first pass of the quit (beside `stopStatusNotifications`). Every change broadcasts `machines:changed` with no payload: the renderer reads `view()` again.

- [ ] **Step 1: Write the failing test** (handlers driven through a fake `ipcMain`, as `claude-accounts-handlers.test.ts` does)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

/**
 * The machines IPC. How it can fail, written before the code:
 * 1. openOffer answers a code while the bridge cannot listen (Tailscale
 *    off), so the other machine can never use it.
 * 2. setPermission takes anything else than see or drive, or an unknown id.
 * 3. A change does not reach the window (machines:changed not sent).
 * 4. view() hands the renderer a secret (outboundSecret or a hash).
 */
const handlers = new Map<string, (...a: unknown[]) => unknown>();
const sent: string[] = [];
vi.mock('electron', () => ({ app: { isPackaged: false }, ipcMain: { handle: (c: string, h: (...a: unknown[]) => unknown) => handlers.set(c, h) } }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: (c: string) => sent.push(c) }));

import { registerMachinesHandlers } from '../../../electron/handlers/machines-handlers';
import { MACHINES_FILE, readMachines, writeMachines, hashSecret } from '../../../electron/services/machines/store';

beforeEach(() => { handlers.clear(); sent.length = 0; fs.rmSync(MACHINES_FILE, { force: true }); delete process.env.TARS_MACHINES_BIND; process.env.DOROTHY_TAILSCALE_BIN = ''; registerMachinesHandlers({ runningAgents: () => 0 }); });
const call = (c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a) as Promise<Record<string, unknown>>;

describe('the machines IPC', () => {
  it('gives no code when the bridge cannot listen, and says why (1)', async () => {
    expect(await call('machines:open-offer')).toEqual({ success: false, error: 'Tailscale is not running on this machine, so no other machine can reach it.' });
  });

  it('gives a formatted code when it can (1)', async () => {
    process.env.TARS_MACHINES_BIND = '127.0.0.1';
    process.env.TARS_MACHINES_PORT = '0';
    const r = await call('machines:open-offer');
    expect(r).toMatchObject({ success: true, code: expect.stringMatching(/^\d{3} \d{3}$/) });
    expect(sent).toContain('machines:changed');
  });

  it('sets see or drive on a known machine, and nothing else (2, 3)', async () => {
    const self = readMachines().self;
    writeMachines({ version: 1, self, peers: [{ id: 'm-bbbbbbbbbbbbbbbb', name: 'PC', address: '127.0.0.1', port: 1, inboundSecretHash: hashSecret('s'), outboundSecret: 'o', mayOnMe: 'see', pairedAt: '' }] });
    expect(await call('machines:set-permission', 'm-bbbbbbbbbbbbbbbb', 'drive')).toEqual({ success: true });
    expect(readMachines().peers[0].mayOnMe).toBe('drive');
    expect(await call('machines:set-permission', 'm-bbbbbbbbbbbbbbbb', 'admin')).toMatchObject({ success: false });
    expect(await call('machines:set-permission', 'm-cccccccccccccccc', 'see')).toMatchObject({ success: false });
    expect(sent).toContain('machines:changed');
  });

  it('never puts a secret in the view (4)', async () => {
    const self = readMachines().self;
    writeMachines({ version: 1, self, peers: [{ id: 'm-bbbbbbbbbbbbbbbb', name: 'PC', address: '127.0.0.1', port: 1, inboundSecretHash: hashSecret('s'), outboundSecret: 'out-secret', mayOnMe: 'see', pairedAt: '' }] });
    const view = JSON.stringify(await call('machines:view'));
    expect(view).not.toContain('out-secret');
    expect(view).not.toContain(hashSecret('s'));
  });
});
```

`TARS_MACHINES_PORT='0'` lets the OS pick a free port; Task 4's `resolveBindTarget` already reads `0` as a port.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/electron/handlers/machines-handlers.test.ts`
Expected: FAIL, cannot find module `machines-handlers`.

- [ ] **Step 3: Write the handlers, the preload block, the types and the main wiring**

```ts
// electron/handlers/machines-handlers.ts
import { ipcMain } from 'electron';
import { broadcastToAllWindows } from '../utils/broadcast';
import { readMachines, writeMachines, cleanName } from '../services/machines/store';
import { startBridge, bridgeState, openPairingOffer, closePairingOffer, currentOffer } from '../services/machines/bridge-server';
import { pairWithCode, candidatesFrom, unpairPeer } from '../services/machines/client';
import { startStatusPolling, peerStatus } from '../services/machines/status';
import { formatCode } from '../services/machines/pairing';
import { detectTailscale } from '../services/tailscale-status';
import type { MachinesView } from '../services/machines/types';
import { app } from 'electron';

export interface MachinesHandlerDeps { runningAgents: () => number }

const changed = () => broadcastToAllWindows('machines:changed', {});
const fail = (err: unknown) => ({ success: false as const, error: err instanceof Error ? err.message : String(err) });

export function registerMachinesHandlers(deps: MachinesHandlerDeps): { startIfPaired: () => Promise<void> } {
  const bridgeDeps = { runningAgents: deps.runningAgents, onChanged: () => { changed(); startStatusPolling(changed); } };

  ipcMain.handle('machines:view', async (): Promise<MachinesView> => {
    const file = readMachines();
    const ts = await detectTailscale();
    const offer = currentOffer();
    return {
      self: { ...file.self, address: ts.dnsName ?? ts.ip },
      tailscale: { installed: ts.installed, running: ts.running },
      bridge: bridgeState(),
      offer: offer ? { code: formatCode(offer.code), expiresAt: new Date(offer.expiresAt).toISOString() } : null,
      peers: file.peers.map(p => ({ id: p.id, name: p.name, address: p.address, mayOnMe: p.mayOnMe, ...peerStatus(p.id) })),
    };
  });

  ipcMain.handle('machines:set-name', async (_e, name: unknown) => {
    try { const file = readMachines(); writeMachines({ ...file, self: { ...file.self, name: cleanName(name) } }); changed(); return { success: true }; } catch (err) { return fail(err); }
  });

  ipcMain.handle('machines:open-offer', async () => {
    const s = await startBridge(bridgeDeps);
    if (!s.listening) return { success: false, error: s.reason ?? 'The bridge is not listening.' };
    const offer = openPairingOffer();
    changed();
    return { success: true, code: formatCode(offer.code), expiresAt: new Date(offer.expiresAt).toISOString() };
  });

  ipcMain.handle('machines:close-offer', async () => { closePairingOffer(); changed(); return { success: true }; });

  ipcMain.handle('machines:pair', async (_e, code: unknown) => {
    const s = await startBridge(bridgeDeps);
    if (!s.listening) return { success: false, error: s.reason ?? 'The bridge is not listening.' };
    const ts = await detectTailscale();
    const result = await pairWithCode(String(code ?? ''), candidatesFrom(process.env, app.isPackaged, ts.peers), s.target!.port);
    if (!result.ok) return { success: false, error: result.error };
    changed();
    startStatusPolling(changed);
    return { success: true, name: result.name };
  });

  ipcMain.handle('machines:set-permission', async (_e, id: unknown, mayOnMe: unknown) => {
    if (mayOnMe !== 'see' && mayOnMe !== 'drive') return { success: false, error: 'A machine may see, or drive.' };
    const file = readMachines();
    if (!file.peers.some(p => p.id === id)) return { success: false, error: 'There is no such machine.' };
    writeMachines({ ...file, peers: file.peers.map(p => (p.id === id ? { ...p, mayOnMe } : p)) });
    changed();
    return { success: true };
  });

  ipcMain.handle('machines:unpair', async (_e, id: unknown) => { await unpairPeer(String(id)); changed(); return { success: true }; });

  return {
    startIfPaired: async () => {
      if (readMachines().peers.length === 0) return;
      await startBridge(bridgeDeps);
      startStatusPolling(changed);
    },
  };
}
```

`bridgeState()` must expose `target` for `machines:pair` (it does: `{ listening, reason?, target? }`).

In `electron/preload.ts`, beside `claudeAccounts`:

```ts
  machines: {
    view: () => ipcRenderer.invoke('machines:view'),
    setName: (name: string) => ipcRenderer.invoke('machines:set-name', name),
    openOffer: () => ipcRenderer.invoke('machines:open-offer'),
    closeOffer: () => ipcRenderer.invoke('machines:close-offer'),
    pair: (code: string) => ipcRenderer.invoke('machines:pair', code),
    setPermission: (id: string, mayOnMe: 'see' | 'drive') => ipcRenderer.invoke('machines:set-permission', id, mayOnMe),
    unpair: (id: string) => ipcRenderer.invoke('machines:unpair', id),
    onChanged: (cb: () => void) => {
      const listener = () => cb();
      ipcRenderer.on('machines:changed', listener);
      return () => { ipcRenderer.removeListener('machines:changed', listener); };
    },
  },
```

In `src/types/electron.d.ts`, copy `MachinesView`, `MachineView`, `PeerStatus`, `PeerPermission` from Task 2 and add `machines?: { ...the signatures above }` to `ElectronAPI`, in the same commit as the preload.

In `electron/main.ts`: import `registerMachinesHandlers` and `stopBridge`, `stopStatusPolling`; after `registerClaudeAccountsHandlers(...)`, `const machines = registerMachinesHandlers({ runningAgents: () => [...agents.values()].filter(a => a.status === 'running' || a.status === 'waiting').length }); void machines.startIfPaired();`; in the first quit pass, add `['stopMachines', () => { stopStatusPolling(); void stopBridge(); }]` next to `stopStatusNotifications`.

- [ ] **Step 4: Run the handlers test, both tsc passes and the shutdown-order test**

Run: `npx vitest run __tests__/electron/handlers/machines-handlers.test.ts __tests__/electron/core/shutdown-order.test.ts && npx tsc --noEmit && npx tsc -p electron/tsconfig.json`
Expected: PASS, 0 type errors. If `shutdown-order.test.ts` lists the first-pass steps exactly, add `stopMachines` to its expected list in this commit.

- [ ] **Step 5: Bite and commit**

Mutant: put `outboundSecret: p.outboundSecret` in the view; case 4 fails. Restore.

```bash
git add electron/handlers/machines-handlers.ts electron/preload.ts src/types/electron.d.ts electron/main.ts __tests__/electron/handlers/machines-handlers.test.ts __tests__/electron/core/shutdown-order.test.ts
git commit -m "feat: settings can name this machine, show a pairing code, pair with another's, and set what each machine may do here"
```

---

### Task 7: Settings > Machines, as drawn

**Files:**
- Create: `src/lib/machines.ts`, `src/hooks/useMachines.ts`, `src/components/Settings/MachinesSection.tsx`
- Modify: `src/components/Settings/types.ts:159` (`'machines'` in `SettingsSection`), `src/components/Settings/constants.ts` (group `Machines`, child `machines` labelled `Your machines`, after `Hermes`), `src/components/Settings/index.ts` (export), `src/app/settings/page.tsx` (case `machines`, header action), `design/UI-INVENTORY.md`, `e2e/surfaces.mjs` (`['machines', 'Machines', 'Your machines']` in `SETTINGS_TREE`)
- Test: `__tests__/lib/machines.test.ts`

**Interfaces:**
- Consumes: `window.electronAPI.machines` (Task 6).
- Produces: `export function statusLine(m: MachineView, now: Date): string` and `export function seenAgo(iso: string | undefined, now: Date): string` in `src/lib/machines.ts`; `useMachines(): { view: MachinesView | null; error: string | null; actions: typeof window.electronAPI.machines }`.

The section, row by row, from the frame `Settings · Machines`:

1. `This machine`, hint `The name your other machines see.`, control: a `Field` input with the name, saved on blur through `setName`; an error under it in the row's error tone.
2. `Address on your tailnet`, hint `Your machines reach it over Tailscale only, never from the internet. Your system may ask once whether Tars can accept connections: allow it on private networks.` (wrap), control: a read-only `Field` with `view.self.address`, or `Tailscale is not running` in the muted tone when `!view.tailscale.running`.
3. When `view.offer`: the notice row (waiting tone) `Pairing code 482 913. Type it on the other machine, in Settings > Machines. It works once and expires in 4:52.`, the minutes and seconds counted down from `expiresAt` each second; at zero the row disappears and `closeOffer` is called.
4. `Pair with a code`, hint `The code the other machine shows under Add a machine.`, controls: an input (six digits, spaces allowed) and a 26 px primary `Pair` button; the result sentence (`Paired with PC.` or the error) in the row below the input.
5. One row per paired machine: label `m.name`, hint `statusLine(m, now)`, control: the status square and word (`connected` in the running tone, `offline` muted, `unpaired by PC` in the error tone with a 26 px `forget` button that calls `unpair`).
6. One row per paired machine: `What the PC may do here` (with the machine's name), hint `See shows your agents and their terminals. Drive also starts, stops and messages them.`, control: `SegmentedControl` with `See` and `Drive`, calling `setPermission`.
7. `Unpair a machine`, hint `Its secret is forgotten here at once. It can no longer see or drive anything on this Mac.` (`this Mac` from the platform: `this PC` on win32), control: a 26 px button `unpair <name>` per machine, or a `Dropdown` of machines and one button when there are more than two.

Header: `HEADER_ACTIONS.machines = { label: 'Add a machine', kind: 'offer' }`; add `'offer'` to `HeaderActionKind`; the header's click for that kind calls `window.electronAPI.machines.openOffer()` and shows its error in the page's existing error banner.

- [ ] **Step 1: Write the failing test for the helpers**

```ts
import { describe, it, expect } from 'vitest';
import { statusLine, seenAgo } from '../../src/lib/machines';

/**
 * The words under each paired machine. How they can fail, written before the code:
 * 1. A connected machine reads "offline", or its agents are not counted.
 * 2. "last seen" is missing for an offline machine that was seen, or shows
 *    a negative or a raw date.
 * 3. A machine that forgot this one reads offline instead of saying so.
 */
const now = new Date('2026-10-02T15:00:00Z');
const base = { id: 'm-bbbbbbbbbbbbbbbb', name: 'PC', address: '100.64.0.2', mayOnMe: 'see' as const };

describe('statusLine', () => {
  it('counts the agents of a connected machine (1)', () => {
    expect(statusLine({ ...base, status: 'connected', agentsRunning: 4, lastSeen: now.toISOString() }, now)).toBe('4 agents running · seen now');
    expect(statusLine({ ...base, status: 'connected', agentsRunning: 1, lastSeen: now.toISOString() }, now)).toBe('1 agent running · seen now');
  });
  it('says when an offline machine was last seen (2)', () => {
    expect(statusLine({ ...base, status: 'offline', lastSeen: '2026-10-02T14:58:00Z' }, now)).toBe('offline · last seen 2 min ago');
    expect(statusLine({ ...base, status: 'offline' }, now)).toBe('offline · not seen since Tars started');
  });
  it('says a machine forgot this one (3)', () => {
    expect(statusLine({ ...base, status: 'unpaired' }, now)).toBe('PC no longer knows this machine. Forget it here, and pair again if you want.');
  });
});

describe('seenAgo', () => {
  it.each([['2026-10-02T15:00:00Z', 'now'], ['2026-10-02T14:59:30Z', 'now'], ['2026-10-02T14:58:00Z', '2 min ago'], ['2026-10-02T12:00:00Z', '3 h ago'], ['2026-09-29T15:00:00Z', '3 days ago'], ['2026-10-02T15:05:00Z', 'now']])('%s reads %s (2)', (iso, words) => {
    expect(seenAgo(iso, now)).toBe(words);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run __tests__/lib/machines.test.ts`
Expected: FAIL, cannot find module `machines`.

- [ ] **Step 3: Write the helpers, the hook, the section and the wiring**

```ts
// src/lib/machines.ts
import type { MachineView } from '@/types/electron';

export function seenAgo(iso: string | undefined, now: Date): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} days ago`;
}

export function statusLine(m: MachineView, now: Date): string {
  if (m.status === 'unpaired') return `${m.name} no longer knows this machine. Forget it here, and pair again if you want.`;
  if (m.status === 'connected') {
    const n = m.agentsRunning ?? 0;
    return `${n} ${n === 1 ? 'agent' : 'agents'} running · seen ${seenAgo(m.lastSeen, now)}`;
  }
  return m.lastSeen ? `offline · last seen ${seenAgo(m.lastSeen, now)}` : 'offline · not seen since Tars started';
}
```

```ts
// src/hooks/useMachines.ts
'use client';
import { useEffect, useState } from 'react';
import type { MachinesView } from '@/types/electron';

type Snapshot = { view: MachinesView | null; error: string | null };
let snapshot: Snapshot = { view: null, error: null };
const listeners = new Set<() => void>();
let started = false;

async function read(): Promise<void> {
  try {
    const view = await window.electronAPI?.machines?.view();
    snapshot = { view: view ?? null, error: view ? null : 'Machines are not available in this window.' };
  } catch (err) {
    snapshot = { ...snapshot, error: err instanceof Error ? err.message : String(err) };
  }
  listeners.forEach(l => l());
}

function start(): void {
  if (started) return;
  started = true;
  window.electronAPI?.machines?.onChanged(() => { void read(); });
  void read();
}

/** The machines view, shared by every component that asks, read again whenever main says it changed. */
export function useMachines(): Snapshot & { reload: () => Promise<void> } {
  const [current, setCurrent] = useState(snapshot);
  useEffect(() => {
    const listener = () => setCurrent(snapshot);
    listeners.add(listener);
    start();
    listener();
    return () => { listeners.delete(listener); };
  }, []);
  return { ...current, reload: read };
}
```

```tsx
// src/components/Settings/MachinesSection.tsx
'use client';

import { useEffect, useState } from 'react';
import { Button, Input, SegmentedControl, StatusSquare } from '@/components/ui';
import type { MachineView, PeerPermission } from '@/types/electron';
import { useMachines } from '@/hooks/useMachines';
import { statusLine } from '@/lib/machines';
import { rendererPlatform } from '@/lib/display-path';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

const api = () => window.electronAPI?.machines;
const left = (iso: string, now: Date) => {
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now.getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const STATUS: Record<MachineView['status'], { tone: 'running' | 'idle' | 'error'; word: (m: MachineView) => string }> = {
  connected: { tone: 'running', word: () => 'connected' },
  offline: { tone: 'idle', word: () => 'offline' },
  unknown: { tone: 'idle', word: () => 'checking' },
  unpaired: { tone: 'error', word: m => `unpaired by ${m.name}` },
};

/**
 * Settings > Machines: this machine's name and tailnet address, a one-time
 * pairing code, the paired machines, what each may do here, and unpairing.
 * Frame: `Settings · Machines` in design/tars-redesign.pen. Main holds every
 * state (electron/handlers/machines-handlers.ts); this reads its view.
 */
export const MachinesSection = () => {
  const { view, error } = useMachines();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [pairNote, setPairNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const here = rendererPlatform() === 'win32' ? 'this PC' : 'this Mac';

  useEffect(() => { if (view) setName(view.self.name); }, [view?.self.name]);
  useEffect(() => {
    if (!view?.offer) return;
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tick);
  }, [view?.offer]);
  useEffect(() => {
    if (view?.offer && new Date(view.offer.expiresAt) <= now) void api()?.closeOffer();
  }, [now, view?.offer]);

  if (!view) return <SettingsCard><SettingsRow label="Machines" description={error ?? 'Reading...'} /></SettingsCard>;

  const saveName = async () => {
    if (name.trim() === view.self.name) return;
    const r = await api()?.setName(name);
    setNameError(r && !r.success ? r.error : null);
  };
  const pair = async () => {
    setPairNote(null);
    const r = await api()?.pair(code);
    setPairNote(r?.success ? { ok: true, text: `Paired with ${r.name}.` } : { ok: false, text: r?.error ?? 'Pairing failed.' });
    if (r?.success) setCode('');
  };

  return (
    <SettingsCard>
      <SettingsRow
        label="This machine"
        description={nameError ?? 'The name your other machines see.'}
        control={<Input width="control" aria-label="This machine" value={name} error={!!nameError} onChange={e => setName(e.target.value)} onBlur={saveName} />}
      />
      <SettingsRow
        label="Address on your tailnet"
        wrap
        description="Your machines reach it over Tailscale only, never from the internet. Your system may ask once whether Tars can accept connections: allow it on private networks."
        control={view.tailscale.running
          ? <Input width="control" mono readOnly value={view.self.address ?? ''} aria-label="Address on your tailnet" />
          : <span className="text-[11.5px] text-muted-foreground">Tailscale is not running</span>}
      />
      {view.offer && (
        <div data-settings-row className="px-4 py-[11px] shrink-0">
          <div className="flex items-center gap-2 px-2.5 py-2 bg-secondary border border-border">
            <StatusSquare tone="waiting" />
            <span className="text-[11.5px] leading-snug text-foreground">
              {`Pairing code ${view.offer.code}. Type it on the other machine, in Settings > Machines. It works once and expires in ${left(view.offer.expiresAt, now)}.`}
            </span>
          </div>
        </div>
      )}
      <SettingsRow
        label="Pair with a code"
        description={pairNote ? pairNote.text : 'The code the other machine shows under Add a machine.'}
        control={(
          <div className="flex items-center gap-2">
            <Input mono aria-label="Pair with a code" value={code} onChange={e => setCode(e.target.value)} placeholder="000 000" />
            <Button size="sm" variant="primary" onClick={pair} disabled={code.replace(/\D/g, '').length !== 6}>Pair</Button>
          </div>
        )}
      />
      {view.peers.map(m => (
        <div key={m.id}>
          <SettingsRow
            label={m.name}
            description={statusLine(m, now)}
            control={(
              <div className="flex items-center gap-2 justify-end">
                <StatusSquare tone={STATUS[m.status].tone} />
                <span className={`text-[11.5px] ${m.status === 'connected' ? 'text-status-running' : m.status === 'unpaired' ? 'text-status-error' : 'text-muted-foreground'}`}>{STATUS[m.status].word(m)}</span>
                {m.status === 'unpaired' && <Button size="sm" variant="secondary" onClick={() => api()?.unpair(m.id)}>forget</Button>}
              </div>
            )}
          />
          <SettingsRow
            label={`What the ${m.name} may do here`}
            description="See shows your agents and their terminals. Drive also starts, stops and messages them."
            control={(
              <SegmentedControl<PeerPermission>
                ariaLabel={`What ${m.name} may do here`}
                value={m.mayOnMe}
                options={[{ value: 'see', label: 'See' }, { value: 'drive', label: 'Drive' }]}
                onChange={v => { void api()?.setPermission(m.id, v); }}
              />
            )}
          />
        </div>
      ))}
      {view.peers.length > 0 && (
        <SettingsRow
          label="Unpair a machine"
          description={`Its secret is forgotten here at once. It can no longer see or drive anything on ${here}.`}
          control={(
            <div className="flex items-center gap-2 justify-end">
              {view.peers.map(m => <Button key={m.id} size="sm" variant="secondary" onClick={() => api()?.unpair(m.id)}>{`unpair ${m.name}`}</Button>)}
            </div>
          )}
        />
      )}
    </SettingsCard>
  );
};
```

The row heading `What the PC may do here` comes from the frame; a machine named `Mac de Nicolas` reads `What the Mac de Nicolas may do here`, which is clumsy: the implementer drops the article (`What Mac de Nicolas may do here`) unless the name is a bare `PC` or `Mac`, and says so in the commit. The `SegmentedControl`'s `onChange` and `ariaLabel` follow `src/components/ui/SegmentedControl.tsx` as it is on the branch; if its radio role differs from `radio`, Task 8's `getByRole('radio', { name: 'Drive' })` follows it.

In `constants.ts`, after the `hermes` group:

```ts
  {
    id: 'machines',
    label: 'Machines',
    icon: Monitor,
    children: [
      { id: 'machines', label: 'Your machines', description: 'Your other computers running Tars, reached over Tailscale.', icon: Monitor },
    ],
  },
```

In `page.tsx`: `import { MachinesSection } from '@/components/Settings';`, `case 'machines': return <MachinesSection />;`, `machines: { label: 'Add a machine', kind: 'offer' }` in `HEADER_ACTIONS`, `'offer'` in `HeaderActionKind`, and in the header's click handler: `if (action.kind === 'offer') { const r = await window.electronAPI?.machines?.openOffer(); if (r && !r.success) setError(r.error); return; }` (the page's existing error state; the section shows the code from the view).

- [ ] **Step 4: Run the helpers test, lint, design lint, guard, both tsc**

Run: `npx vitest run __tests__/lib/machines.test.ts && npm run lint && npm run lint:design && npm run e2e:guard && npx tsc --noEmit`
Expected: PASS; the guard counts the new surface.

- [ ] **Step 5: Record the surface and commit**

Run: `npx playwright test e2e/surfaces.spec.ts -g "settings-machines$" --update-snapshots` (a new surface has no reference yet), then open the picture and compare it with the frame `Settings · Machines`: same rows, same order, same words. A difference is a bug in the section, not a reason to keep the picture.

```bash
git add src/lib/machines.ts src/hooks/useMachines.ts src/components/Settings/ __tests__/lib/machines.test.ts src/app/settings/page.tsx design/UI-INVENTORY.md e2e/surfaces.mjs e2e/__screenshots__/
git commit -m "feat: settings > machines: this machine's name and address, a pairing code, the paired machines and what each may do here"
```

---

### Task 8: Two Tars pair, end to end

**Files:**
- Create: `e2e/machines-pairing.spec.ts`

**Interfaces:**
- Consumes: everything above, through the real app.

- [ ] **Step 1: Write the spec** (it is the proof of the plan; it runs red until Tasks 1 to 7 are in)

```ts
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchSandboxed, recordValues, stepShot, splashGone } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Two Tars, two homes, two bridges on 127.0.0.1 (the development overrides
 * TARS_MACHINES_BIND / _PORT / _PEERS stand where the tailnet would). A shows
 * a code, B types it, both list the other as connected; A lets B drive; B
 * unpairs, and A says B forgot it. Leaves a run directory with each step's
 * picture of both windows and the values asserted.
 *   E2E_PORT_OFFSET=90 npx playwright test e2e/machines-pairing.spec.ts
 */
const A = { api: apiPort(31481), bridge: apiPort(31482) };
const B = { api: apiPort(31483), bridge: apiPort(31484) };

async function launch(name: string, me: typeof A, other: typeof A): Promise<{ app: ElectronApplication; page: Page; home: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-machines-${name}-`));
  const app = await launchSandboxed(electron, home, { env: {
    NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: me.api, DOROTHY_E2E: '1',
    TARS_MACHINES_BIND: '127.0.0.1', TARS_MACHINES_PORT: me.bridge, TARS_MACHINES_PEERS: `127.0.0.1:${other.bridge}`,
  } });
  const page = await app.firstWindow();
  await page.goto(`${DEV_URL}/settings?section=machines`);
  await splashGone(page);
  // Each Tars names itself, so the two lists can be told apart.
  await page.getByLabel('This machine').fill(name);
  await page.getByLabel('This machine').blur();
  return { app, page, home };
}

test('two Tars pair with a code, see each other, and one unpairs', async () => {
  test.setTimeout(180_000);
  const a = await launch('Mac', A, B);
  const b = await launch('PC', B, A);
  const values: Record<string, unknown> = {};
  try {
    await a.page.getByRole('button', { name: 'Add a machine', exact: true }).click();
    const notice = a.page.getByText(/^Pairing code \d{3} \d{3}\./);
    await expect(notice).toBeVisible();
    const code = (await notice.textContent())!.match(/\d{3} \d{3}/)![0];
    values.code = 'shown';
    await stepShot(a.page, '01-a-shows-a-code');

    await b.page.getByLabel('Pair with a code').fill(code);
    await b.page.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(b.page.getByText('Paired with Mac.')).toBeVisible({ timeout: 20_000 });
    await expect(a.page.getByText(/^Pairing code/)).toHaveCount(0);

    // Both list the other, connected, within one poll.
    await expect(a.page.getByText('PC', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(b.page.getByText('Mac', { exact: true })).toBeVisible();
    await expect(a.page.getByText('connected', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(b.page.getByText('connected', { exact: true })).toBeVisible({ timeout: 20_000 });
    await stepShot(a.page, '02-a-lists-pc');
    await stepShot(b.page, '03-b-lists-mac');

    // A lets B drive; the file on A says so, and nothing on B moves.
    await a.page.getByRole('radio', { name: 'Drive' }).click();
    const aFile = JSON.parse(fs.readFileSync(path.join(a.home, '.tars-private', 'machines.json'), 'utf8'));
    values.aMayB = aFile.peers[0].mayOnMe;
    expect(aFile.peers[0].mayOnMe).toBe('drive');
    const bFile = JSON.parse(fs.readFileSync(path.join(b.home, '.tars-private', 'machines.json'), 'utf8'));
    values.bMayA = bFile.peers[0].mayOnMe;
    expect(bFile.peers[0].mayOnMe).toBe('see');
    // Neither file holds the secret it issued, only its hash.
    expect(JSON.stringify(aFile)).not.toContain(bFile.peers[0].outboundSecret);

    // B unpairs: B forgets A at once, A learns it at its next poll.
    await b.page.getByRole('button', { name: 'unpair Mac', exact: true }).click();
    await expect(b.page.getByText('Mac', { exact: true })).toHaveCount(0);
    await expect(a.page.getByText(/no longer knows this machine|^PC$/)).toHaveCount(1, { timeout: 30_000 });
    await stepShot(a.page, '04-a-after-b-unpaired');
    values.done = true;
  } finally {
    recordValues(values);
    await a.app.close();
    await b.app.close();
  }
});
```

The spec's last assertion accepts either outcome on A (B told A at unpair time, so A has forgotten B; or the told call failed and A shows "no longer knows"): both are correct per Review Focus 2. Tighten it once Task 5's `unpairPeer` is known to reach A in this run: it should, so A's list is empty, and the assertion becomes `toHaveCount(0)` on `PC`.

- [ ] **Step 2: Run it**

Run: `npx tsc -p electron/tsconfig.json && E2E_PORT_OFFSET=90 npx playwright test e2e/machines-pairing.spec.ts`
Expected: PASS, run directory with 4 pictures and `values.json`.

- [ ] **Step 3: Show it bites**

Mutants, one at a time: make `checkProof` return `'wrong'` always (the spec fails at `Paired with Mac.`); make `machines:set-permission` write the permission to every peer and B's own file too (the spec fails at `bMayA`). Restore.

- [ ] **Step 4: Commit**

```bash
git add e2e/machines-pairing.spec.ts
git commit -m "test: two tars pair with a code, list each other as connected, set drive, and unpair, end to end"
```

---

### Task 9: Security notes, tracker, full gate

**Files:**
- Modify: `SECURITY.md` (a section `The machines bridge`), `WINDOWS-PORT.md` (journal row, and the lot under 5bis)

- [ ] **Step 1: Write the SECURITY.md section**

It says, in the file's own style: what listens (`<tailnet IPv4>:31416`, nothing else), who is admitted (a paired machine's secret; the loopback token, Tars's pass and the webhook secret are not), what each route does, what pairing proves (the code, by HMAC over a nonce, five tries, five minutes, once) and its known limit: a device of the same tailnet that answers `hello` while a code is shown receives a proof it can test against all 10^6 codes offline, then present to the real offering machine within the five minutes. The mitigation is the tailnet itself (your devices only) and Tailscale ACLs; a later plan may confirm the machine's name on the typing side before sending the proof.

- [ ] **Step 2: Full gate, as CLAUDE.md Workflow Rule 3 lists it**

Run, in order: `npx tsc --noEmit`, `npx tsc -p electron/tsconfig.json`, `npm test`, `npm run lint`, `npm run lint:design`, `npm run e2e:guard`, `node scripts/check-dashes.mjs`, `npm run e2e`.
Expected: all green; the new specs and units counted.

- [ ] **Step 3: Manual check on the real machines** (Nicolas's Mac and PC, both on the tailnet)

1. Install the build on both. On the Mac: Settings > Machines > Add a machine. The OS asks whether Tars may accept incoming connections: allow (macOS), allow on private networks (Windows).
2. On the PC: type the code, Pair. Both list the other as connected within ten seconds.
3. Quit Tars on the PC: the Mac shows offline with "last seen" within twenty seconds.
4. From a third device on the tailnet (a phone with a browser): `http://<mac tailnet ip>:31416/machines/v1/ping` answers 401; `/api/agents` answers 404.

- [ ] **Step 4: Commit**

```bash
git add SECURITY.md WINDOWS-PORT.md
git commit -m "chore: what the machines bridge exposes, and its pairing limit, in security.md; the lot in the port tracker"
```

---

## Plans 2 and 3 (detailed once plan 1 is in)

**Plan 2, see the other machine in the Dashboard, Agents and Projects.** Bridge routes `GET /machines/v1/snapshot` (projects; agents with id, name, status, task, branch, provider, model, stop line, never a token, an env or a path outside the project) and `GET /machines/v1/agents/:id/stream` (Server-Sent Events: the agent's output buffer, then each chunk as it comes; one stream per open pane). Main merges remote agents into `agent:list` with `machine: { id, name }` and namespaced ids (`<machineId>/<agentId>`), relays streams as `agent:output`. Renderer: the badge of the frames on project tabs, panes, cards; the machine filter; the offline pane (`Panel · machine offline`); `PC ✓` in the status bar. Proof: two Tars, an agent on B with a fake CLI printing lines, its pane on A shows them live; B quits, A greys the pane within twenty seconds.

**Plan 3, drive the other machine, and its Kanban.** Bridge routes `POST /machines/v1/agents/:id/start|stop|message` (403 unless the caller's `mayOnMe` here is `drive`; a stop needs a reason, filed as `by: <machine name>`), and the local board: `GET /machines/v1/kanban`, `POST /machines/v1/kanban/tasks` (same permission). Renderer: the panes' and cards' start, stop, send act on the remote agent; the Kanban's `PC` tab. Proof: A drives B's agent (start, message, stop with a reason; B's card says "stopped by Mac"), and with `see` only, every action is refused with a sentence.
