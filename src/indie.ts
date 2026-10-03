/**
 * indie.fun: sessions, retention, frame rate, crash reports and a progression funnel
 * (https://indie.fun/docs). The browser SDK is the hosted script, loaded after boot so it
 * never holds up the menu; if it does not arrive, the game does not notice.
 *
 * `login: false`: players sign in with ARRR (settings/account.ts), and a second account pill
 * on the screen would only confuse them. Anonymous players are still counted.
 *
 * Only the App ID is here: it is public and goes in the page. The App Secret is for a game
 * server, which Quake Town does not have; it never belongs in this repo or in the bundle.
 *
 * Off in `vite` dev and under the test harness (?probe=1, ?test) so they do not count as
 * players; ?indie=1 turns it on there, ?indie=0 turns it off anywhere.
 * Licence: GPL-2.0-or-later.
 */

declare const __BUILD_REV__: string;

/** The `quake-town` game on indie.fun; `VITE_INDIE_APP_ID` at build time overrides it. */
export const INDIE_APP_ID: string = import.meta.env.VITE_INDIE_APP_ID || 'app_565e0fdde3769b0df543c7f9';

const SDK_URL = 'https://indie.fun/js/indie.js';

/** Milestones in the order a player reaches them (the funnel on the indie.fun dashboard). */
const PROGRESSION = ['game_start', 'online_match'] as const;
export type Milestone = typeof PROGRESSION[number];

interface IndieClient {
  progress(step: string): void;
  captureException(error: unknown, context?: Record<string, unknown>): void;
}
type IndieCtor = new (config: Record<string, unknown>) => IndieClient;

let client: IndieClient | null = null;
/** Calls made before the script arrived, replayed once it has. */
const queued: Array<(c: IndieClient) => void> = [];

function enabled(params: URLSearchParams): boolean {
  const flag = params.get('indie');
  if (flag === '0') return false;
  if (flag === '1') return true;
  return !import.meta.env.DEV && params.get('probe') !== '1' && !params.has('test');
}

/** Load the SDK and start the session. Call once at boot. */
export function startIndie(params: URLSearchParams): void {
  if (!INDIE_APP_ID || !enabled(params)) return;
  const s = document.createElement('script');
  s.src = SDK_URL;
  s.async = true;
  s.onload = () => {
    const Indie = (window as unknown as { Indie?: IndieCtor }).Indie;
    if (!Indie) { console.warn('[indie] the SDK loaded but defines no Indie'); return; }
    try {
      client = new Indie({
        appId: INDIE_APP_ID,
        login: false,
        progression: [...PROGRESSION],
        errors: { release: typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : 'dev' },
      });
    } catch (err) { console.warn('[indie] could not start:', err); return; }
    for (const f of queued.splice(0)) f(client);
  };
  s.onerror = () => { queued.length = 0; console.info('[indie] the SDK did not load (blocked or offline): playing without it'); };
  document.head.append(s);
}

function withClient(f: (c: IndieClient) => void): void {
  if (client) { try { f(client); } catch { /* never the game's problem */ } } else if (queued.length < 50) queued.push(f);
}

/** A player reached a milestone (repeats are fine: the funnel counts players, not calls). */
export function indieProgress(step: Milestone): void { withClient((c) => c.progress(step)); }

/** An error the game caught and handled, so the SDK's own uncaught-error capture never sees it. */
export function indieError(err: unknown, context?: Record<string, unknown>): void { withClient((c) => c.captureException(err, context)); }
