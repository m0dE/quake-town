/**
 * Where settings live: this browser always, the ARRR account too when signed in.
 *
 * One JSON document — archived cvars that differ from default, all binds, stored configs.
 * Written to localStorage 300 ms after a change. When an account is attached, also to the
 * account's vault record (`arrr-network` `vault.open(session)`, the same mechanism
 * vibe-strike keeps its wardrobe in, src/econ/vault.ts there): a save there is a quorum
 * write to the player's holder nodes, so it is debounced harder (1.5 s) and serialised.
 * A failed save leaves the document dirty and is retried on the next change; `flush()`
 * closes the window when the page hides.
 *
 * On attaching: the account's copy wins (it is what the player set up on their other
 * device); an account that has never saved settings is seeded from this browser. The vault
 * record is the player's own and not an authority — settings need none.
 *
 * Licence: GPL-2.0-or-later.
 */
import { cvars as defaultCvars, type CvarRegistry } from './cvars.js';
import { binds as defaultBinds, type Binds } from './binds.js';
import { configs as defaultConfigs, type Configs } from './configs.js';

export interface SettingsDoc {
  v: 1;
  cvars: Record<string, string>;
  binds: Record<string, string>;
  configs: Record<string, string>;
}

/** The part of a vault `SaveStore` this file uses (tests pass a fake). */
export interface VaultDocLike {
  load(): Promise<Record<string, unknown>>;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  save(): Promise<unknown>;
  onConflict(cb: (remote: Record<string, unknown>) => void): void;
}

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SettingsHome = 'browser' | 'account' | 'loading';

export const LOCAL_KEY = 'qt.settings';
export const VAULT_KEY = 'settings';

const isRecord = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === 'string');

export function parseDoc(v: unknown): SettingsDoc | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Partial<SettingsDoc>;
  if (d.v !== 1 || !isRecord(d.cvars) || !isRecord(d.binds) || !isRecord(d.configs ?? {})) return null;
  return { v: 1, cvars: d.cvars, binds: d.binds, configs: d.configs ?? {} };
}

export interface SettingsOptions {
  storage?: KV | null;
  cvars?: CvarRegistry;
  binds?: Binds;
  configs?: Configs;
  localDebounceMs?: number;
  vaultDebounceMs?: number;
  onError?: (err: unknown) => void;
}

export class Settings {
  readonly cvars: CvarRegistry;
  readonly binds: Binds;
  readonly configs: Configs;
  private readonly storage: KV | null;
  private readonly localMs: number;
  private readonly vaultMs: number;
  private readonly onError: (err: unknown) => void;
  private applying = false;
  private localTimer: ReturnType<typeof setTimeout> | null = null;
  private vaultTimer: ReturnType<typeof setTimeout> | null = null;
  private vault: VaultDocLike | null = null;
  private vaultDirty = false;
  private chain: Promise<void> = Promise.resolve();
  private home: SettingsHome = 'browser';
  private readonly statusListeners = new Set<(h: SettingsHome) => void>();
  private started = false;
  /** Bumped by every attach/detach so a late load cannot undo a newer state. */
  private generation = 0;

  constructor(opts: SettingsOptions = {}) {
    this.cvars = opts.cvars ?? defaultCvars;
    this.binds = opts.binds ?? defaultBinds;
    this.configs = opts.configs ?? defaultConfigs;
    this.storage = opts.storage === undefined ? (typeof localStorage !== 'undefined' ? localStorage : null) : opts.storage;
    this.localMs = opts.localDebounceMs ?? 300;
    this.vaultMs = opts.vaultDebounceMs ?? 1500;
    this.onError = opts.onError ?? ((err) => console.warn('[settings] could not save to the account:', err));
  }

  /** Load this browser's settings and start saving changes. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    let stored: SettingsDoc | null = null;
    try { stored = parseDoc(JSON.parse(this.storage?.getItem(LOCAL_KEY) ?? 'null')); } catch { /* junk: defaults */ }
    if (stored) this.apply(stored);
    this.cvars.onChange('*', (name) => { if (this.cvars.def(name)?.archive !== false) this.changed(); });
    this.binds.onChange(() => this.changed());
    this.configs.onChange(() => this.changed());
    if (!stored) {
      // A name of their own from the first visit, kept from then on (as doom-arrr does).
      if (this.cvars.isDefault('name')) this.cvars.set('name', `ranger${Math.floor(Math.random() * 900 + 100)}`);
      this.saveLocal();
    }
  }

  doc(): SettingsDoc {
    return { v: 1, cvars: this.cvars.snapshot(), binds: this.binds.snapshot(), configs: this.configs.snapshot() };
  }

  /** Replace the settings with `doc` without echoing a save of it back to where it came from. */
  apply(doc: SettingsDoc): void {
    this.applying = true;
    try {
      this.cvars.load(doc.cvars);
      this.binds.load(doc.binds);
      this.configs.load(doc.configs);
    } finally {
      this.applying = false;
    }
  }

  status(): SettingsHome { return this.home; }

  onStatus(cb: (h: SettingsHome) => void): () => void {
    this.statusListeners.add(cb);
    return () => { this.statusListeners.delete(cb); };
  }

  /**
   * Keep settings in an account's vault document from now on. The account's settings
   * win; an empty account is seeded from this browser. Rejects (and stays on the browser)
   * if the record cannot be read.
   */
  async attachVault(doc: VaultDocLike): Promise<void> {
    const gen = ++this.generation;
    this.setHome('loading');
    let remote: Record<string, unknown>;
    try {
      remote = await doc.load();
    } catch (err) {
      if (gen === this.generation) this.setHome('browser');
      throw err;
    }
    if (gen !== this.generation) return;
    this.vault = doc;
    const theirs = parseDoc(remote[VAULT_KEY]);
    if (theirs) {
      this.apply(theirs);
      this.saveLocal();
    } else {
      doc.set(VAULT_KEY, this.doc());
      this.vaultDirty = true;
      await this.flush();
    }
    doc.onConflict((won) => {
      const d = parseDoc(won[VAULT_KEY]);
      if (d && this.vault === doc) { this.apply(d); this.saveLocal(); }
    });
    this.setHome('account');
  }

  /** Back to this browser only (sign-out). What was last applied stays in effect here. */
  async detachVault(): Promise<void> {
    await this.flush().catch(() => undefined);
    this.generation++;
    this.vault = null;
    this.vaultDirty = false;
    this.setHome('browser');
  }

  /** Everything outstanding, saved. Never rejects for the local copy; rejects if the account save failed. */
  flush(): Promise<void> {
    if (this.localTimer) { clearTimeout(this.localTimer); this.localTimer = null; this.saveLocal(); }
    if (this.vaultTimer) { clearTimeout(this.vaultTimer); this.vaultTimer = null; }
    const doc = this.vault;
    const next = this.chain.then(async () => {
      if (!doc || !this.vaultDirty) return;
      doc.set(VAULT_KEY, this.doc());
      this.vaultDirty = false;
      try {
        await doc.save();
      } catch (err) {
        this.vaultDirty = true;
        throw err;
      }
    });
    this.chain = next.catch((err: unknown) => { this.onError(err); });
    return next;
  }

  /** The whole document as a QW-style cfg (`unbindall`, `bind`, cvar lines). */
  exportText(): string {
    const q = (s: string): string => `"${s.replace(/"/g, '')}"`;
    const lines = ['// Quake Town config — written by writeconfig', 'unbindall'];
    for (const [k, v] of this.binds.all()) lines.push(`bind ${k === '"' ? q(k) : k} ${q(v)}`);
    for (const name of this.cvars.list()) {
      const d = this.cvars.def(name)!;
      if (d.archive !== false) lines.push(`${name} ${q(this.cvars.get(name))}`);
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Apply a cfg's `bind`, `unbind`, `unbindall`, `set`/`seta`/`<cvar> <value>` lines.
   * Returns the lines it did not understand (the console runs those itself if it wants).
   */
  importText(text: string): string[] {
    const skipped: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      for (const stmt of splitStatements(line)) {
        const t = tokenize(stmt);
        if (!t.length) continue;
        const cmd = t[0].toLowerCase();
        if (cmd === 'unbindall') this.binds.unbindAll();
        else if (cmd === 'bind' && t.length >= 3) this.binds.set(t[1], t.slice(2).join(' '));
        else if (cmd === 'unbind' && t[1]) this.binds.unbind(t[1]);
        else if ((cmd === 'set' || cmd === 'seta') && t.length >= 3 && this.cvars.has(t[1])) this.cvars.set(t[1], t[2]);
        else if (t.length >= 2 && this.cvars.has(cmd)) this.cvars.set(cmd, t[1]);
        else skipped.push(stmt);
      }
    }
    return skipped;
  }

  private changed(): void {
    if (this.applying) return;
    if (!this.localTimer) this.localTimer = setTimeout(() => { this.localTimer = null; this.saveLocal(); }, this.localMs);
    if (this.vault) {
      this.vaultDirty = true;
      if (!this.vaultTimer) this.vaultTimer = setTimeout(() => { this.vaultTimer = null; void this.flush().catch(() => undefined); }, this.vaultMs);
    }
  }

  private saveLocal(): void {
    try { this.storage?.setItem(LOCAL_KEY, JSON.stringify(this.doc())); } catch { /* storage blocked or full */ }
  }

  private setHome(h: SettingsHome): void {
    if (h === this.home) return;
    this.home = h;
    for (const l of this.statusListeners) { try { l(h); } catch (err) { console.error(err); } }
  }
}

/** `a; b "c;d"` → ['a', 'b "c;d"'] (QW's Cbuf: `;` outside quotes separates). */
export function splitStatements(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/** QW's Cmd_TokenizeString: whitespace separates, "quoted strings" are one token. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"?|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2]);
  return out;
}

export const settings = new Settings();
