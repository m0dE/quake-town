/**
 * Named config texts kept with the settings (the console's `exec`, `writeconfig`).
 * Data only: nothing here runs them, and configs from packs never land here
 * (DESIGN.md "Sandbox").
 *
 * Licence: GPL-2.0-or-later.
 */

export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_CONFIGS = 64;
const NAME = /^[a-z0-9_.-]{1,40}$/;

type Listener = () => void;

export class Configs {
  private map = new Map<string, string>();
  private readonly listeners = new Set<Listener>();

  /** `name` as stored: lower case, `.cfg` added when it has no extension. */
  static key(name: string): string | null {
    let k = name.trim().toLowerCase();
    if (!k.includes('.')) k += '.cfg';
    return NAME.test(k) ? k : null;
  }

  list(): string[] { return [...this.map.keys()].sort(); }
  get(name: string): string | null { const k = Configs.key(name); return k ? this.map.get(k) ?? null : null; }

  /** Throws with a sentence when the name or size is not allowed. */
  save(name: string, text: string): void {
    const k = Configs.key(name);
    if (!k) throw new Error(`"${name}" is not a config name (letters, digits, _ . -).`);
    if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) throw new Error('Config is over 64 KB.');
    if (!this.map.has(k) && this.map.size >= MAX_CONFIGS) throw new Error(`At most ${MAX_CONFIGS} configs.`);
    this.map.set(k, text);
    this.emit();
  }

  remove(name: string): void {
    const k = Configs.key(name);
    if (k && this.map.delete(k)) this.emit();
  }

  load(record: Record<string, string>): void {
    this.map = new Map(Object.entries(record).filter(([k, v]) => Configs.key(k) === k && typeof v === 'string').slice(0, MAX_CONFIGS));
    this.emit();
  }

  snapshot(): Record<string, string> { return Object.fromEntries(this.map); }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private emit(): void {
    for (const l of this.listeners) { try { l(); } catch (err) { console.error(err); } }
  }
}

export const configs = new Configs();
