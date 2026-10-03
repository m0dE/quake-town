/**
 * Pack loading: the built-in index, downloads with progress, sha256 verification, the
 * IndexedDB cache, community packs by URL and local pack files (DESIGN.md "Content packs").
 *
 * Resolution of a PackRef { id, url? }: the IndexedDB cache (by sha256) first — it holds
 * only verified bytes, so this never changes the result —, then the built-in index
 * (public/packs/index.json), then the room-given URL. Every download is verified against
 * the sha256 before anything is mounted; a mismatch is refused.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
import { openPack } from './archive';
import { LIMITS, PackError } from './sanitize';
import { defaultStore, STORE_PACKS, type BlobStore } from './store';
import type { PackIndexEntry, PackRef, PackRole, Progress } from './types';
import { PackVfs, type Mount } from './vfs';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  const b = new Uint8Array(digest);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX12 = /^[0-9a-f]{12}$/;

/** Download with progress, refusing more than `limit` bytes. */
export async function fetchBytes(url: string, opts: { limit?: number; expected?: number; onProgress?: Progress; fetchImpl?: typeof fetch; reload?: boolean } = {}): Promise<Uint8Array> {
  const limit = opts.limit ?? LIMITS.packBytes;
  const f = opts.fetchImpl ?? fetch;
  const res = await f(url, opts.reload ? { credentials: 'omit', cache: 'reload' } : { credentials: 'omit' });
  if (!res.ok) throw new PackError(`download failed: HTTP ${res.status} for ${url}`);
  // A proxy, tunnel or captive page answering in the pack's place sends a web page
  const ct = res.headers.get('content-type') ?? '';
  if (/text\/html/i.test(ct)) throw new PackError(`download of ${url} returned a web page (${ct}), not the pack: something between this browser and the server answered instead`);
  const len = Number(res.headers.get('content-length') || 0);
  // content-length is the encoded size when the server compresses; only trust it as an upper bound check
  if (len > limit && !res.headers.get('content-encoding')) throw new PackError(`pack too large: ${len} bytes (at most ${limit})`);
  const total = opts.expected || (res.headers.get('content-encoding') ? 0 : len);
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.length > limit) throw new PackError(`pack too large: ${b.length} bytes (at most ${limit})`);
    opts.onProgress?.(b.length, b.length);
    return b;
  }
  const reader = res.body.getReader();
  let buf = new Uint8Array(total > 0 && total <= limit ? total : 1 << 20);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > limit) { await reader.cancel(); throw new PackError(`pack too large: more than ${limit} bytes`); }
    if (n + value.length > buf.length) {
      const nb = new Uint8Array(Math.min(limit, Math.max(buf.length * 2, n + value.length)));
      nb.set(buf.subarray(0, n));
      buf = nb;
    }
    buf.set(value, n);
    n += value.length;
    opts.onProgress?.(n, total);
  }
  return n === buf.length ? buf : buf.subarray(0, n);
}

export interface LoadedPack { id: string; name: string; bytes: Uint8Array; source: 'cache' | 'builtin' | 'url' | 'local' }

export interface PackLoaderOptions {
  /** URL of the built-in packs directory (default: "packs/" relative to the page) */
  baseUrl?: string;
  store?: BlobStore;
  fetchImpl?: typeof fetch;
}

export class PackLoader {
  readonly baseUrl: string;
  readonly store: BlobStore;
  private fetchImpl: typeof fetch;
  private indexP: Promise<PackIndexEntry[]> | null = null;

  constructor(opts: PackLoaderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? 'packs/';
    this.store = opts.store ?? defaultStore(STORE_PACKS);
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  /** public/packs/index.json (cached for the page's lifetime) */
  index(): Promise<PackIndexEntry[]> {
    if (!this.indexP) {
      this.indexP = (async () => {
        const res = await this.fetchImpl(this.baseUrl + 'index.json', { cache: 'no-cache' });
        if (!res.ok) throw new PackError(`packs/index.json: HTTP ${res.status}`);
        const j = await res.json();
        if (!Array.isArray(j)) throw new PackError('packs/index.json is not a list');
        return j as PackIndexEntry[];
      })();
      this.indexP.catch(() => { this.indexP = null; });
    }
    return this.indexP;
  }

  /** the built-in entry matching a full or 12-char short id, or a pack name ("base") */
  async builtin(idOrName: string): Promise<PackIndexEntry | null> {
    const idx = await this.index();
    const k = idOrName.toLowerCase();
    return idx.find((e) => e.id === k) ?? (HEX12.test(k) ? idx.find((e) => e.id.startsWith(k)) : undefined)
      ?? idx.find((e) => e.name === idOrName) ?? null;
  }

  /** Resolve a pack reference to verified bytes. */
  async resolve(ref: PackRef, onProgress?: Progress): Promise<LoadedPack> {
    const id = ref.id.toLowerCase();
    let entry: PackIndexEntry | null = null;
    try { entry = await this.builtin(id); } catch { /* no index (offline): fall through */ }
    const full = entry?.id ?? (HEX64.test(id) ? id : null);
    if (!full) throw new PackError(`unknown pack ${ref.id}: community packs need the full sha256`);
    // 1. cache
    try {
      const c = await this.store.get(full);
      if (c && (await sha256Hex(c.bytes)) === full) { onProgress?.(c.bytes.length, c.bytes.length); return { id: full, name: c.name, bytes: c.bytes, source: 'cache' }; }
    } catch { /* cache unavailable */ }
    // 2. built-in
    let lastErr: unknown = null;
    if (entry?.file) {
      try {
        const get = (reload: boolean): Promise<Uint8Array> => fetchBytes(this.baseUrl + entry.file, { expected: entry.bytes, onProgress, fetchImpl: this.fetchImpl, limit: Math.max(LIMITS.packBytes, entry.bytes), reload });
        let bytes = await get(false);
        if ((await sha256Hex(bytes)) !== full) {
          // a stale browser cache or a proxy that altered the bytes: once more, past every cache
          console.warn(`[packs] ${entry.file}: got ${bytes.length} bytes (expected ${entry.bytes}) that do not match; downloading it again`);
          bytes = await get(true);
          if ((await sha256Hex(bytes)) !== full) {
            const head = Array.from(bytes.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join(' ');
            console.error(`[packs] ${entry.file} still does not match: ${bytes.length} bytes, starts ${head}. Something between the server and this browser changes binary files.`);
          }
        }
        return await this.accept(full, entry.name, bytes, 'builtin');
      } catch (e) { lastErr = e; }
    }
    // 3. room URL
    if (ref.url) {
      checkUrl(ref.url);
      const bytes = await fetchBytes(ref.url, { onProgress, fetchImpl: this.fetchImpl });
      return await this.accept(full, nameFromUrl(ref.url), bytes, 'url');
    }
    throw lastErr instanceof Error ? lastErr : new PackError(`pack ${ref.id.slice(0, 12)} is not available here (no URL, not cached)`);
  }

  private async accept(id: string, name: string, bytes: Uint8Array, source: LoadedPack['source']): Promise<LoadedPack> {
    const got = await sha256Hex(bytes);
    if (got !== id) throw new PackError(`pack ${id.slice(0, 12)}: sha256 mismatch (got ${got.slice(0, 12)}), refused`);
    try { await this.store.put({ key: id, name, bytes, at: Date.now() }); } catch { /* cache is best effort */ }
    return { id, name, bytes, source };
  }

  /** A host's local pack file: verified-by-construction (we hash it), cached by sha256. */
  async cacheLocalPack(file: Blob & { name?: string }): Promise<{ id: string; name: string; bytes: number }> {
    if (file.size > LIMITS.packBytes) throw new PackError(`pack too large: ${file.size} bytes (at most 64 MB)`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    openPack(bytes); // validates format, paths and limits before we keep it
    const id = await sha256Hex(bytes);
    const name = (file.name ?? 'local').replace(/\.(pk3|pak)$/i, '');
    try { await this.store.put({ key: id, name, bytes, at: Date.now() }); } catch { /* memory-only */ }
    return { id, name, bytes: bytes.length };
  }

  /**
   * Load and mount packs in order (e.g. base, then the room's maps + mod + extras).
   * Enforces the per-pack and all-room-packs limits. Progress reports the sum over packs.
   */
  async mountAll(vfs: PackVfs, refs: { ref: PackRef; role: PackRole }[], onProgress?: Progress): Promise<Mount[]> {
    const sizes = refs.map(() => 0), done = refs.map(() => 0);
    const report = () => onProgress?.(done.reduce((a, b) => a + b, 0), sizes.reduce((a, b) => a + b, 0));
    // known sizes up front for a stable total
    for (let i = 0; i < refs.length; i++) {
      try { const e = await this.builtin(refs[i].ref.id); if (e) sizes[i] = e.bytes; } catch { /* ignore */ }
    }
    const loaded = await Promise.all(refs.map(({ ref }, i) => this.resolve(ref, (d, t) => { done[i] = d; if (t) sizes[i] = t; report(); })));
    const roomBytes = loaded.reduce((a, l, i) => a + (refs[i].role === 'base' ? 0 : l.bytes.length), 0);
    if (roomBytes > LIMITS.roomPacksBytes) throw new PackError(`room packs total ${roomBytes} bytes (at most 128 MB)`);
    return loaded.map((l, i) => vfs.mount({ id: l.id, name: l.name, role: refs[i].role, archive: openPack(l.bytes), bytes: l.bytes.length }));
  }
}

function checkUrl(url: string): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new PackError(`bad pack URL ${url}`); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new PackError('pack URLs must be https');
}

function nameFromUrl(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'pack').replace(/\.(pk3|pak)$/i, ''); } catch { return 'pack'; }
}
