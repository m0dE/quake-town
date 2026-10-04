/**
 * Storage in a sandboxed frame. indie.fun (and other portals) run the game in an
 * <iframe sandbox="allow-scripts …"> without allow-same-origin: the page's origin is opaque,
 * and merely reading localStorage, sessionStorage, indexedDB or navigator.serviceWorker throws
 * a SecurityError, `typeof localStorage` included. This code and arrr-network both check
 * storage that way, so the first one would end the boot with a black screen.
 *
 * Imported first by main.ts: when storage is blocked, localStorage and sessionStorage become
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

/** True when the page runs with an opaque origin (a sandbox without allow-same-origin). */
export const sandboxed = blocked(() => window.localStorage);

if (sandboxed) {
  const define = (name: string, value: unknown): void => {
    try { Object.defineProperty(window, name, { value, configurable: true, writable: true }); } catch (err) { console.warn(`[sandbox] could not replace ${name}:`, err); }
  };
  define('localStorage', new MemoryStorage());
  if (blocked(() => window.sessionStorage)) define('sessionStorage', new MemoryStorage());
  if (blocked(() => window.indexedDB)) define('indexedDB', undefined);
  console.info('[sandbox] storage is blocked in this frame: settings last until the tab closes');
}
