/**
 * Storage in a sandboxed frame. indie.fun (and other portals) run the game in an
 * <iframe sandbox="allow-scripts …"> without allow-same-origin: the page's origin is opaque,
 * and merely reading localStorage, sessionStorage, indexedDB or navigator.serviceWorker throws
 * a SecurityError, `typeof localStorage` included. This code and arrr-network both check
 * storage that way, so the first one would end the boot with a black screen.
 *
 * Imported first by main.ts: whichever storage is blocked, localStorage and sessionStorage become
 * in-memory stand-ins (settings, favourites and the ARRR sign-in last until the tab closes),
 * and indexedDB reads as undefined, so the pack cache falls back to memory (content/store.ts).
 * Outside a sandbox nothing changes.
 *
 * Licence: GPL-2.0-or-later.
 */

class MemoryStorage implements Storage {
  private readonly m = new Map<string, string>();
  get length(): number { return this.m.size; }
  clear(): void { this.m.clear(); }
  getItem(key: string): string | null { return this.m.get(String(key)) ?? null; }
  key(index: number): string | null { return [...this.m.keys()][index] ?? null; }
  removeItem(key: string): void { this.m.delete(String(key)); }
  setItem(key: string, value: string): void { this.m.set(String(key), String(value)); }
  [name: string]: unknown;
}

function blocked(read: () => unknown): boolean {
  try { read(); return false; } catch { return true; }
}

/**
 * Each one is checked on its own: indie.fun puts its own localStorage and sessionStorage in
 * place before this runs (localStorage kept through the parent page, so settings do last
 * there), which leaves indexedDB and navigator.serviceWorker throwing all the same.
 */
const define = (name: string, value: unknown): void => {
  try { Object.defineProperty(window, name, { value, configurable: true, writable: true }); } catch (err) { console.warn(`[sandbox] could not replace ${name}:`, err); }
};
const replaced: string[] = [];
for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (blocked(() => window[name].getItem('qt'))) { define(name, new MemoryStorage()); replaced.push(name); }
}
// An opaque origin has no IndexedDB: reading it may work and open() throw, so the origin decides.
if (self.origin === 'null' || blocked(() => window.indexedDB)) { define('indexedDB', undefined); replaced.push('indexedDB'); }
if (replaced.length) console.info(`[sandbox] blocked in this frame, in memory instead: ${replaced.join(', ')}`);

/** False in a sandboxed frame, where even reading navigator.serviceWorker throws. */
export const serviceWorkers = !blocked(() => navigator.serviceWorker) && 'serviceWorker' in navigator;
