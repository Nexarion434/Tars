import type { HermesGatewayView } from '@/types/electron';

/**
 * What Settings, Hermes, Gateways says of each gateway (2.0.4, the window of #469; frames `Gateways · Settings,
 * Hermes` and `· states`): its caption, its two addresses, the projects it reaches, and a save refused. Main keeps the
 * gateways and their secrets (services/hermes-gateways.ts); nothing here ever sees a secret.
 */

/** What the page reads of hermes.getConnectionInfo(): the local API's port and what Tailscale does. */
export interface GatewayConnection {
  apiPort: number;
  tailscale: { installed: boolean; running: boolean; dnsName?: string; serveConfigured: boolean };
}

/** A project as the window lists it (fs.listProjects): its path and the name Tars gives it. */
export interface KnownProject {
  path: string;
  name: string;
}

/** A gateway's caption: its name in capitals, then its id and its own route. */
export function gatewayCaption(gateway: HermesGatewayView): { title: string; sub: string } {
  return { title: gateway.label.toUpperCase(), sub: `${gateway.id} · ${gateway.path}` };
}

/**
 * The two addresses a gateway's Hermes posts to: on the tailnet, only while Tailscale serves Tars under a tailnet name,
 * and on this machine, on the port main answers. `line` says what Tailscale does, so a missing address is explained.
 */
export function gatewayAddresses(info: GatewayConnection | null, route: string): { tailnet: string | null; local: string | null; line: string } {
  if (!info) return { tailnet: null, local: null, line: 'reading the tailnet…' };
  const local = `http://127.0.0.1:${info.apiPort}${route}`;
  const { installed, running, dnsName, serveConfigured } = info.tailscale;
  if (serveConfigured && dnsName) {
    return { tailnet: `https://${dnsName}${route}`, local, line: `tailscale serve active · ${dnsName}: a Hermes on another machine posts here.` };
  }
  const line = serveConfigured
    ? 'tailscale serve active, without a tailnet name: a Hermes on another machine cannot reach this one'
    : running
      ? 'tailscale running · the API still only listens on this machine'
      : installed
        ? 'tailscale installed but not running'
        : 'no tailscale · a Hermes on another machine cannot reach this one';
  return { tailnet: null, local, line };
}

/** A path as a project's identity: without the slash a folder may end with. */
const keyOf = (p: string) => p.replace(/[\\/]+$/, '');
const folderOf = (p: string) => keyOf(p).split(/[\\/]/).pop() || p;

/** The projects a gateway reaches, each once: named as Tars names it, or by its folder when Tars no longer lists it. */
export function allowedProjects(allowed: string[], known: KnownProject[]): KnownProject[] {
  const seen = new Set<string>();
  const out: KnownProject[] = [];
  for (const p of allowed) {
    const key = keyOf(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: p, name: known.find((k) => keyOf(k.path) === key)?.name ?? folderOf(p) });
  }
  return out;
}

/** What allow projects offers: every project Tars lists, ticked as the gateway reaches it, then those it reaches that Tars no longer lists. */
export function projectPicks(allowed: string[], known: KnownProject[]): (KnownProject & { ticked: boolean })[] {
  const reached = new Set(allowed.map(keyOf));
  const listed = new Set(known.map((k) => keyOf(k.path)));
  return [
    ...known.map((k) => ({ path: k.path, name: k.name, ticked: reached.has(keyOf(k.path)) })),
    ...allowedProjects(allowed, []).filter((p) => !listed.has(keyOf(p.path))).map((p) => ({ ...p, ticked: true })),
  ];
}

/** The chips of the Projects row: up to three whole, else the first two and how many more. */
export function chipsOf(names: string[]): { shown: string[]; more: number } {
  const shown = names.length > 3 ? names.slice(0, 2) : names;
  return { shown, more: names.length - shown.length };
}

/** The Projects row's line: a gateway reaching nothing is said in the waiting tone. */
export function projectsLine(count: number): { hint: string; waiting: boolean } {
  return count === 0
    ? { hint: 'Reaches no project yet. Its Hermes jobs get not found until you allow one.', waiting: true }
    : { hint: 'A job for any other project is answered not found.', waiting: false };
}

/** What a refused save says: a folder Tars may not write or a full disk in the page's words, main's own reason otherwise. */
export function notSavedLine(error: string | undefined): string {
  if (!error) return 'Not saved.';
  if (/\b(EACCES|EPERM)\b|permission denied/i.test(error)) return 'Not saved: Tars could not write its private settings (permission denied).';
  if (/\bENOSPC\b/.test(error)) return 'Not saved: Tars could not write its private settings (the disk is full).';
  return `Not saved: ${error}`;
}
