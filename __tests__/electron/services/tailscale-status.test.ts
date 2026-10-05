import { describe, it, expect } from 'vitest';
import { parseTailscaleStatus, tailnetIp, deviceName } from '../../../electron/services/tailscale-status';

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
 * 6. A machine shared in from another tailnet (ShareeNode) is not told
 *    apart, so pairing would trust a stranger's device (final review, C1).
 * 7. The address of a Tailscale that is stopped is used: the bridge then
 *    fails to bind it (EADDRNOTAVAIL) and says so in words nobody can act
 *    on, not that Tailscale is off (final review, Important 4).
 * 8. A device asking to pair is named by the hostname it reports, which it
 *    can set to any other machine's (security review, 2026-10-05), not by its
 *    MagicDNS name, which the tailnet keeps unique; or a device shared in
 *    from another tailnet loses the part of its name that says so.
 */
const status = {
  BackendState: 'Running',
  Self: { HostName: 'mac', DNSName: 'mac.example.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a::1'] },
  Peer: {
    k1: { HostName: 'pc', DNSName: 'pc.example.ts.net.', TailscaleIPs: ['100.64.0.2'], Online: true, OS: 'windows' },
    k2: { HostName: 'old', DNSName: 'old.example.ts.net.', TailscaleIPs: ['100.64.0.3'], Online: false, OS: 'macOS' },
    k3: { HostName: 'v6', DNSName: 'v6.example.ts.net.', TailscaleIPs: ['fd7a::9'], Online: true, OS: 'linux' },
    k4: { HostName: 'friend', DNSName: 'friend.other.ts.net.', TailscaleIPs: ['100.64.0.9'], Online: true, OS: 'linux', ShareeNode: true },
  },
};

describe('parseTailscaleStatus', () => {
  it('reads this machine: running, its MagicDNS name without the dot, its IPv4 (2, 3)', () => {
    expect(parseTailscaleStatus(status)).toMatchObject({ running: true, dnsName: 'mac.example.ts.net', ip: '100.64.0.1' });
  });

  it('lists the peers with an IPv4, online or not, never itself, shared ones said so (1, 2, 5, 6)', () => {
    const { peers } = parseTailscaleStatus(status);
    expect(peers).toEqual([
      { name: 'pc', dnsName: 'pc.example.ts.net', ip: '100.64.0.2', online: true, os: 'windows', shared: false },
      { name: 'old', dnsName: 'old.example.ts.net', ip: '100.64.0.3', online: false, os: 'macOS', shared: false },
      { name: 'friend', dnsName: 'friend.other.ts.net', ip: '100.64.0.9', online: true, os: 'linux', shared: true },
    ]);
  });

  it.each([null, 42, 'x', {}, { Self: 'nope', Peer: [] }])('reads %j as not running, with no peers (4)', (raw) => {
    expect(parseTailscaleStatus(raw)).toEqual({ running: false, peers: [] });
  });
});

describe('tailnetIp', () => {
  it('is the address only while Tailscale runs (7)', () => {
    expect(tailnetIp({ running: false, ip: '100.64.0.1' })).toBeUndefined();
    expect(tailnetIp({ running: true, ip: '100.64.0.1' })).toBe('100.64.0.1');
  });
});

describe('deviceName', () => {
  const peer = { name: 'warmachine', ip: '100.64.0.9', online: true, shared: false };
  it('is the MagicDNS name the tailnet keeps unique, never the hostname the device reports (8)', () => {
    expect(deviceName({ ...peer, dnsName: 'macbook-pro-de-nicolas-2.tail957bfd.ts.net' })).toBe('macbook-pro-de-nicolas-2');
    expect(deviceName({ ...peer, dnsName: 'warmachine-1.tail957bfd.ts.net' })).toBe('warmachine-1');
    expect(deviceName(peer)).toBeUndefined();
  });

  it('keeps the whole name of a device shared in from another tailnet (8)', () => {
    expect(deviceName({ ...peer, shared: true, dnsName: 'friend.other.ts.net' })).toBe('friend.other.ts.net');
  });
});
