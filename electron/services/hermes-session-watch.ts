import { HERMES_SIGNED_OUT, measuredHermes } from './kanban-board';

/**
 * Tars's Hermes session, kept valid and watched.
 *
 * Measured in Hermes 0.21.5's own code (plugins/dashboard_auth/basic): the
 * access token lives 12 hours and the refresh token 30 days, and the gateway's
 * middleware refreshes a lapsed access token by itself, minting a new refresh
 * token with it. So a session stays valid as long as Tars asks the gateway
 * something, signed in, at least once a month: each check is that request, and
 * hermesRequest keeps the cookies it rotates. What ends a session then is the
 * gateway (a new signing secret, a sign-out, another provider's rules), and the
 * check is also what finds it, as does any kanban call refused on the way.
 *
 * On 17/10 every kanban call answered "Unauthorized" and nothing said so: the
 * state below is what the window shows, with the one action to take.
 */

/** What a check learns from the gateway: probeHermes, for the connection a file names. */
export interface SessionCheck {
  /** A connection file names a gateway. */
  configured: boolean;
  reachable: boolean;
  authRequired: boolean;
  signedIn: boolean;
  version?: string;
}

export interface HermesSessionState {
  /** `none`: no Hermes configured, or one that asks for no sign-in. */
  session: 'none' | 'signed-in' | 'signed-out' | 'unreachable';
  version?: string;
  /** The rules of this version were not measured: a task an agent claims stays `scheduled`. */
  unmeasured: boolean;
  /** The sentence the window shows, the same the kanban tools answer with. */
  message?: string;
  checkedAt?: string;
}

const UNREACHABLE = 'Hermes does not answer: the kanban tools cannot reach the board until it does.';

/**
 * How soon a refused call is checked: one 401 (during a gateway's refresh, say)
 * said signed out for up to half an hour while every call after it worked (the
 * Audit's L2 on #452). One check for a burst of refusals.
 */
export const RECHECK_AFTER_REFUSAL_MS = 10_000;

export function createHermesSessionWatch(opts: {
  check: () => Promise<SessionCheck>;
  everyMs: number;
  onChange: (state: HermesSessionState) => void;
}) {
  let state: HermesSessionState = { session: 'none', unmeasured: false };
  let configured = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  let recheck: ReturnType<typeof setTimeout> | null = null;

  const same = (a: HermesSessionState, b: HermesSessionState) =>
    a.session === b.session && a.version === b.version && a.unmeasured === b.unmeasured;

  function set(next: HermesSessionState): void {
    const changed = !same(state, next);
    state = next;
    if (changed) opts.onChange(state);
  }

  async function checkNow(): Promise<HermesSessionState> {
    const checkedAt = new Date().toISOString();
    let c: SessionCheck;
    try {
      c = await opts.check();
    } catch {
      set({ ...state, session: 'unreachable', message: UNREACHABLE, checkedAt });
      return state;
    }
    configured = c.configured && c.authRequired;
    const version = c.version ?? state.version;
    const unmeasured = c.configured && c.reachable && !measuredHermes(c.version);
    if (!c.configured) set({ session: 'none', unmeasured: false, checkedAt });
    else if (!c.reachable) set({ session: 'unreachable', version, unmeasured: state.unmeasured, message: UNREACHABLE, checkedAt });
    else if (!c.authRequired) set({ session: 'none', version: c.version, unmeasured, checkedAt });
    else if (!c.signedIn) set({ session: 'signed-out', version: c.version, unmeasured, message: HERMES_SIGNED_OUT, checkedAt });
    else set({ session: 'signed-in', version: c.version, unmeasured, checkedAt });
    return state;
  }

  return {
    /** A check now, then one every `everyMs`, which never holds the process open. */
    start(): void {
      if (timer) return;
      void checkNow();
      timer = setInterval(() => { void checkNow(); }, opts.everyMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      if (recheck) clearTimeout(recheck);
      recheck = null;
    },
    checkNow,
    /** A kanban call the gateway refused for the session: said at once, and checked again soon. */
    refused(): void {
      if (!configured) return;
      set({ ...state, session: 'signed-out', message: HERMES_SIGNED_OUT, checkedAt: new Date().toISOString() });
      if (recheck) return;
      recheck = setTimeout(() => { recheck = null; void checkNow(); }, RECHECK_AFTER_REFUSAL_MS);
      recheck.unref?.();
    },
    state: (): HermesSessionState => state,
  };
}

/** The watch main.ts starts, which the kanban routes tell of a refused call. */
let current: ReturnType<typeof createHermesSessionWatch> | null = null;

export function setHermesSessionWatch(watch: ReturnType<typeof createHermesSessionWatch> | null): void {
  current = watch;
}

export function hermesSessionWatch(): ReturnType<typeof createHermesSessionWatch> | null {
  return current;
}
