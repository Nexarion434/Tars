/**
 * Where a platform's updates come from, and what of a release it installs
 * (audit B, answer 4; decisions D11 and D13): the decisions behind the GitHub
 * fallback of services/update-checker.ts, which calls these and decides
 * nothing of its own.
 *
 * win32: the fork's releases (the same repository as package.json
 * build.win.publish, which electron-builder bakes into a Windows build for
 * electron-updater; platform/update-feed.test.ts holds the two together),
 * versions `<upstream version>-win.<n>` ordered as semver, as electron-updater
 * orders them, and the NSIS setup .exe, never another platform's file.
 *
 * darwin and linux: the repository they are given (GITHUB_REPO), x.y.z
 * compared part by part and the .dmg, then the .zip, byte for byte what
 * update-checker.ts did before this layer.
 */

/** The fork the Windows builds are released on. */
export const WINDOWS_UPDATE_REPO = 'Nexarion434/Tars';

/** The repository whose releases the fallback reads on this platform. */
export function updateRepoFor(platform: NodeJS.Platform, upstreamRepo: string): string {
  return platform === 'win32' ? WINDOWS_UPDATE_REPO : upstreamRepo;
}

type ReleaseAsset = { name: string; browser_download_url?: string };

/**
 * The asset of a release this platform installs. win32: the setup .exe, this
 * architecture's first, and nothing rather than another platform's file.
 * darwin and linux: the .dmg, then the .zip.
 */
export function installerAssetFor<T extends ReleaseAsset>(assets: T[], platform: NodeJS.Platform, arch: string): T | undefined {
  if (platform === 'win32') {
    const setups = assets.filter(a => /setup/i.test(a.name) && /\.exe$/i.test(a.name));
    return setups.find(a => a.name.toLowerCase().includes(arch.toLowerCase())) ?? setups[0];
  }
  const dmgAsset = assets.find(a => a.name.endsWith('.dmg'));
  const zipAsset = assets.find(a => a.name.endsWith('.zip'));
  return dmgAsset || zipAsset;
}

/**
 * Semantic version precedence (semver 2.0, what electron-updater compares
 * with): negative when a is before b, 0 when equal, positive after, null when
 * either is not x.y.z[-prerelease]. A release is after its prereleases, and
 * numeric identifiers compare as numbers: 1.9.0-win.10 is after 1.9.0-win.9.
 */
export function compareSemver(a: string, b: string): number | null {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(v);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
  }
  if (!pa[4] || !pb[4]) return (pa[4] ? -1 : 0) - (pb[4] ? -1 : 0);
  const ia = pa[4].split('.');
  const ib = pb[4].split('.');
  for (let i = 0; i < Math.min(ia.length, ib.length); i++) {
    const na = /^\d+$/.test(ia[i]);
    const nb = /^\d+$/.test(ib[i]);
    if (na && nb && Number(ia[i]) !== Number(ib[i])) return Number(ia[i]) - Number(ib[i]);
    if (na !== nb) return na ? -1 : 1;
    if (!na && ia[i] !== ib[i]) return ia[i] < ib[i] ? -1 : 1;
  }
  return ia.length - ib.length;
}

/** Whether `latest` is newer than `current` on this platform. */
export function isNewerRelease(current: string, latest: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return (compareSemver(latest, current) ?? 0) > 0;
  const pa = current.split('.').map(Number);
  const pb = latest.split('.').map(Number);
  let hasUpdate = false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (nb > na) { hasUpdate = true; break; }
    if (na > nb) break;
  }
  return hasUpdate;
}
