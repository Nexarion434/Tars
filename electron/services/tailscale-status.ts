import { execFile } from 'child_process';
import { promisify } from 'util';
import { app } from 'electron';
import { tailscaleCandidates } from '../platform';

const execFileAsync = promisify(execFile);

/**
 * A machine of the tailnet other than this one, as `tailscale status` lists it.
 * `shared` is a machine another tailnet shares in (ShareeNode): reachable, but
 * not one of yours, so it is never asked for a pairing code.
 */
export interface TailscalePeer { name: string; dnsName?: string; ip: string; online: boolean; os?: string; shared: boolean }

/** What Tailscale says about this machine: Settings > Hermes reads it, and Settings > Machines. */
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
        shared: p.ShareeNode === true,
      });
    }
  }
  return { running: s.BackendState === 'Running', dnsName: bare(s.Self.DNSName), ip: ipv4(s.Self.TailscaleIPs), peers };
}

/**
 * Where to look for `tailscale`: where this platform installs it
 * (tailscaleCandidates). A development run may name the one binary to ask,
 * or none with an empty value (DOROTHY_TAILSCALE_BIN): the e2e fixture
 * does, since two of the places are absolute paths no sandbox HOME hides, and
 * a sandbox asked the Mac's own Tailscale, whose MagicDNS name ended up in the
 * reference screenshots (QA's note on #222). A packaged Tars never reads it.
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
