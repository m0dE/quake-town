/**
 * Ping in the server list — best effort, and honest about which kind it is.
 *
 * HOW IT WORKS. A room runs on its authority node; central reports that node's id for a
 * live room (`RoomInfo.authorityNodeId`) but publishes no address for it (node URLs are
 * operator-only), and a room nobody has opened has no node yet. The browser cannot ICMP,
 * so "ping" is an HTTP round trip on a warm connection, which is one network RTT plus a
 * fraction of a millisecond of server time — the same thing a WebSocket ping measures.
 * Three sources, best first:
 *
 *   1. `known`   — this browser has played on that node before: the game reported the
 *                  lockstep round trip it measured there (`rememberNodeRtt`). Real ping.
 *   2. `region`  — the build names a node for the room's region (VITE_ARRR_NODE_*):
 *                  GET <node>/health, one warm-up request (DNS + TCP + TLS) discarded,
 *                  then the minimum of three. That is where central is asked to put the
 *                  room, so it is the node you would connect to.
 *   3. `central` — neither: the same measurement against central (the network's front
 *                  door). Shown with "~": it tells you how far the network is, not that
 *                  room's node.
 *
 * `fetch(…, { mode: 'no-cors' })` is used because a node's /health sends no CORS headers;
 * an opaque response still has the timing we need. Failures give null ("—").
 *
 * Licence: GPL-2.0-or-later.
 */
import { regionNodeUrl, type RegionId } from './regions.js';

export type PingKind = 'known' | 'region' | 'central';
export interface Ping { ms: number; kind: PingKind }

const NODE_RTT_KEY = 'qt.nodeRtt';
const NODE_RTT_TTL_MS = 7 * 24 * 3600_000;
const CACHE_MS = 60_000;

type RttBook = Record<string, { ms: number; at: number }>;

function readBook(): RttBook {
  try {
    const raw = JSON.parse(localStorage.getItem(NODE_RTT_KEY) ?? '{}') as RttBook;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * The game calls this once it is connected and has a round trip
 * (`lockstep.roundTripMs`, or the SDK's own ping), with the room's authority node id
 * (from the listing row, or the connection). Kept for a week, per node.
 */
export function rememberNodeRtt(nodeId: string, ms: number, now = Date.now()): void {
  if (!nodeId || !Number.isFinite(ms) || ms < 0) return;
  const book = readBook();
  const prev = book[nodeId];
  // A smoothed figure, so one bad sample does not define the node.
  book[nodeId] = { ms: Math.round(prev && now - prev.at < NODE_RTT_TTL_MS ? prev.ms * 0.6 + ms * 0.4 : ms), at: now };
  for (const [k, v] of Object.entries(book)) if (now - v.at > NODE_RTT_TTL_MS) delete book[k];
  try { localStorage.setItem(NODE_RTT_KEY, JSON.stringify(book)); } catch { /* storage blocked */ }
}

export function knownNodeRtt(nodeId: string | null, now = Date.now()): number | null {
  if (!nodeId) return null;
  const e = readBook()[nodeId];
  return e && now - e.at < NODE_RTT_TTL_MS ? e.ms : null;
}

/** ws(s)://host:port/ws → http(s)://host:port/health. */
export function healthUrl(url: string): string {
  const u = new URL(url.replace(/^ws/, 'http'));
  u.pathname = '/health';
  u.search = '';
  return u.toString();
}

const measured = new Map<string, { at: number; p: Promise<number | null> }>();

/** HTTP round trip to `url`: one warm-up, then the minimum of `samples`. Cached for a minute. */
export function measureRtt(url: string, samples = 3, now = Date.now()): Promise<number | null> {
  const hit = measured.get(url);
  if (hit && now - hit.at < CACHE_MS) return hit.p;
  const p = (async () => {
    const once = async (): Promise<number | null> => {
      const t0 = performance.now();
      try {
        await fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' });
        return performance.now() - t0;
      } catch {
        return null;
      }
    };
    if ((await once()) === null) return null;
    let best = Infinity;
    for (let i = 0; i < samples; i++) best = Math.min(best, (await once()) ?? Infinity);
    return Number.isFinite(best) ? Math.round(best) : null;
  })();
  measured.set(url, { at: now, p });
  return p;
}

/** The best ping figure available for a room. */
export async function pingFor(room: { node: string | null; region: RegionId | null }, central = 'https://cloud.arrr.fun'): Promise<Ping | null> {
  const known = knownNodeRtt(room.node);
  if (known !== null) return { ms: known, kind: 'known' };
  const node = regionNodeUrl(room.region);
  if (node) {
    const ms = await measureRtt(healthUrl(node));
    if (ms !== null) return { ms, kind: 'region' };
  }
  const ms = await measureRtt(`${central.replace(/\/$/, '')}/health`);
  return ms === null ? null : { ms, kind: 'central' };
}

export function pingText(p: Ping | null | undefined): string {
  if (!p) return '—';
  return p.kind === 'central' ? `~${p.ms}` : String(p.ms);
}
