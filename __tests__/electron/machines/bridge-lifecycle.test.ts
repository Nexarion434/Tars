import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { startBridge, stopBridge, bridgeState } from '../../../electron/services/machines/bridge-server';

/**
 * The bridge's listener over its life, in a development run (the overrides
 * bind 127.0.0.1). How it can fail, written before the code:
 * 1. Two starts at once (a double click on Add a machine, or the start at
 *    launch beside a pairing) open two servers on the one port: the second
 *    fails (EADDRINUSE) and reports the bridge down while the first listens,
 *    or the first is left listening with nothing to close it (final review,
 *    Important 2).
 */
const deps = { runningAgents: () => 0, onChanged: () => {} };

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

beforeEach(async () => {
  process.env.DOROTHY_TAILSCALE_BIN = '';
  process.env.TARS_MACHINES_BIND = '127.0.0.1';
  process.env.TARS_MACHINES_PORT = String(await freePort());
});
afterEach(async () => {
  await stopBridge();
  delete process.env.TARS_MACHINES_BIND;
  delete process.env.TARS_MACHINES_PORT;
});

describe('starting the bridge', () => {
  it('twice at once opens one server, and both starts say it listens (1)', async () => {
    const [a, b] = await Promise.all([startBridge(deps), startBridge(deps)]);
    expect(a).toMatchObject({ listening: true });
    expect(b).toMatchObject({ listening: true });
    expect(b.target).toEqual(a.target);
    expect(bridgeState().listening).toBe(true);
    // One server: once it is stopped, nothing answers on the port.
    await stopBridge();
    const r = await fetch(`http://127.0.0.1:${a.target!.port}/machines/v1/ping`).then(x => x.status, () => 0);
    expect(r).toBe(0);
  });
});
