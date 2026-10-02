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
