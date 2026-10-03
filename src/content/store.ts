/**
 * Byte stores: packs cached by sha256, and the player's own id paks. IndexedDB in the
 * browser, an in-memory store for tests and for browsers without IndexedDB (private mode).
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */

export interface StoredBlob { key: string; name: string; bytes: Uint8Array; at: number }

export interface BlobStore {
  get(key: string): Promise<StoredBlob | null>;
  put(blob: StoredBlob): Promise<void>;
  delete(key: string): Promise<void>;
  /** keys + names + sizes, no bytes */
  list(): Promise<{ key: string; name: string; size: number; at: number }[]>;
}

export class MemoryStore implements BlobStore {
  private m = new Map<string, StoredBlob>();
  async get(key: string) { return this.m.get(key) ?? null; }
  async put(b: StoredBlob) { this.m.set(b.key, b); }
  async delete(key: string) { this.m.delete(key); }
  async list() { return [...this.m.values()].map((b) => ({ key: b.key, name: b.name, size: b.bytes.length, at: b.at })); }
}

const DB_NAME = 'quake-town-content';
const DB_VERSION = 1;
export const STORE_PACKS = 'packs';
export const STORE_IDPAKS = 'idpaks';

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_PACKS)) db.createObjectStore(STORE_PACKS, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(STORE_IDPAKS)) db.createObjectStore(STORE_IDPAKS, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error ?? new Error('IndexedDB open failed')); };
      req.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
    });
  }
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

export class IdbStore implements BlobStore {
  constructor(private readonly storeName: string) {}
  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await openDb();
    return db.transaction(this.storeName, mode).objectStore(this.storeName);
  }
  async get(key: string): Promise<StoredBlob | null> {
    const r = await wrap((await this.tx('readonly')).get(key)) as StoredBlob | undefined;
    if (!r) return null;
    // stored as ArrayBuffer-backed Uint8Array; normalise
    return { ...r, bytes: r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes as ArrayBuffer) };
  }
  async put(b: StoredBlob): Promise<void> {
    // store a tight copy so a view into a larger buffer does not drag the whole buffer along
    const bytes = b.bytes.byteOffset === 0 && b.bytes.byteLength === b.bytes.buffer.byteLength ? b.bytes : b.bytes.slice();
    await wrap((await this.tx('readwrite')).put({ ...b, bytes }));
  }
  async delete(key: string): Promise<void> { await wrap((await this.tx('readwrite')).delete(key)); }
  async list(): Promise<{ key: string; name: string; size: number; at: number }[]> {
    const out: { key: string; name: string; size: number; at: number }[] = [];
    const store = await this.tx('readonly');
    await new Promise<void>((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(); return; }
        const v = c.value as StoredBlob;
        out.push({ key: v.key, name: v.name, size: (v.bytes as Uint8Array).byteLength, at: v.at });
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return out;
  }
}

/** IndexedDB when available, memory otherwise */
export function defaultStore(storeName: string): BlobStore {
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB) return new IdbStore(storeName);
  } catch { /* SecurityError in some private modes */ }
  return new MemoryStore();
}
