/*
 * Quake Town — the command system: command buffer, tokenizer, commands, aliases,
 * binds and stored configs. Behaviour follows QW's cmd.c / keys.c
 * (Copyright (C) 1996-1997 Id Software, Inc., GPL-2.0-or-later); written fresh.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 *
 * Binds, cvars and stored configs are the settings part's (src/settings: one
 * document, persisted to the browser and the ARRR account); aliases are kept here.
 */
import type { Cvars } from './cvars.js';

export type CommandFn = (args: string[], line: string) => void;

export interface CommandDef { name: string; fn: CommandFn; desc?: string }

/** QW Cmd_TokenizeString: whitespace-separated, "quoted strings", // ends the line. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && line.charCodeAt(i) <= 32) i++;
    if (i >= n) break;
    if (line[i] === '/' && line[i + 1] === '/') break;
    if (line[i] === '"') {
      i++;
      let s = '';
      while (i < n && line[i] !== '"') s += line[i++];
      i++;
      out.push(s);
      continue;
    }
    let s = '';
    while (i < n && line.charCodeAt(i) > 32) s += line[i++];
    out.push(s);
  }
  return out;
}

/** Split a buffer into commands on `;` and newlines outside quotes (QW Cbuf_Execute). */
export function splitCommands(text: string): string[] {
  const out: string[] = [];
  let quotes = false;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === '"') quotes = !quotes;
    if (i === text.length || c === '\n' || (!quotes && c === ';')) {
      const s = text.slice(start, i).trim();
      if (s) out.push(s);
      start = i + 1;
      if (c === '\n') quotes = false;
    }
  }
  return out;
}

/** The rest of a line after the first token (QW Cmd_Args). */
export function argsOf(line: string): string {
  const m = /^\s*("[^"]*"|\S+)\s*/.exec(line);
  return m ? line.slice(m[0].length) : '';
}

/** The settings part's bind and config stores (src/settings/binds.ts, configs.ts), narrowed. */
export interface BindStore {
  get(key: string): string;
  set(key: string, command: string): void;
  unbind(key: string): void;
  unbindAll(): void;
  all(): [string, string][];
}
export interface ConfigStore {
  list(): string[];
  get(name: string): string | null;
  save(name: string, text: string): void;
}

export type PrintFn = (text: string) => void;

const ALIAS_KEY = 'qt.aliases';

export class CommandSystem {
  readonly commands = new Map<string, CommandDef>();
  readonly aliases = new Map<string, string>();
  private printers = new Set<PrintFn>();
  private depth = 0;
  /** Set while executing text that came from a stufftext: only whitelisted commands run. */
  restricted: ((name: string) => boolean) | null = null;
  /** A command nobody knows, and not a cvar: handed here (the game forwards it to the mod as `{ k }`). */
  forward: ((line: string) => boolean) | null = null;

  constructor(
    readonly cvars: Cvars,
    readonly binds: BindStore,
    private readonly configs: ConfigStore,
    /** settings.exportText(): the whole settings document as a cfg, for writeconfig */
    private readonly exportText: () => string = () => '',
    private readonly storage: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null,
  ) {
    this.registerBuiltins();
    try {
      const saved = JSON.parse(this.storage?.getItem(ALIAS_KEY) ?? '{}') as Record<string, string>;
      for (const [k, v] of Object.entries(saved)) if (typeof v === 'string') this.aliases.set(k, v);
    } catch { /* none */ }
  }

  onPrint(fn: PrintFn): () => void { this.printers.add(fn); return () => this.printers.delete(fn); }
  print(text: string): void { for (const p of this.printers) p(text); }

  register(name: string, fn: CommandFn, desc?: string): void {
    this.commands.set(name.toLowerCase(), { name: name.toLowerCase(), fn, desc });
  }

  /** Run a buffer of commands now (QW Cbuf_AddText + Cbuf_Execute). */
  exec(text: string): void {
    if (this.depth > 16) { this.print('recursive alias/exec, stopped\n'); return; }
    this.depth++;
    try { for (const cmd of splitCommands(text)) this.execOne(cmd); } finally { this.depth--; }
  }

  private execOne(line: string): void {
    const args = tokenize(line);
    if (!args.length) return;
    const name = args[0].toLowerCase();
    if (this.restricted && !this.restricted(name)) { this.print(`stufftext: "${name}" is not allowed\n`); return; }
    const cmd = this.commands.get(name);
    if (cmd) { cmd.fn(args, line); return; }
    const alias = this.aliases.get(name);
    if (alias !== undefined) { this.exec(alias); return; }
    if (this.cvars.has(name)) {
      if (args.length === 1) {
        const d = this.cvars.def(name);
        this.print(`"${name}" is "${this.cvars.get(name)}"${d && d.def !== this.cvars.get(name) ? ` (default "${d.def}")` : ''}\n`);
      } else if (!this.cvars.set(name, args[1])) this.print(`"${args[1]}" is not a valid value for ${name}\n`);
      return;
    }
    if (this.forward && this.forward(line)) return;
    this.print(`Unknown command "${args[0]}"\n`);
  }

  /** The command bound to a key name, or ''. Key names are QW's: "w", "space", "mouse1", "mwheelup", "f1", "uparrow". */
  bindOf(key: string): string { return this.binds.get(key); }

  bind(key: string, cmd: string): void {
    if (cmd) this.binds.set(key, cmd); else this.binds.unbind(key);
  }

  private saveAliases(): void {
    try { this.storage?.setItem(ALIAS_KEY, JSON.stringify(Object.fromEntries(this.aliases))); } catch { /* full */ }
  }

  /** Aliases as cfg lines (binds and cvars are the settings document's). */
  aliasText(): string {
    let s = '';
    for (const [k, v] of [...this.aliases].sort()) s += `alias ${k} "${v}"\n`;
    return s;
  }

  private registerBuiltins(): void {
    const r = (n: string, fn: CommandFn, d?: string): void => this.register(n, fn, d);
    r('echo', (a) => this.print(`${a.slice(1).join(' ')}\n`), 'print text');
    r('bind', (a) => {
      if (a.length < 2) { this.print('bind <key> [command] : attach a command to a key\n'); return; }
      if (a.length === 2) {
        const b = this.bindOf(a[1]);
        this.print(b ? `"${a[1]}" = "${b}"\n` : `"${a[1]}" is not bound\n`);
        return;
      }
      this.bind(a[1], a.slice(2).join(' '));
    }, 'attach a command to a key');
    r('unbind', (a) => { if (a[1]) this.bind(a[1], ''); }, 'remove a key binding');
    r('unbindall', () => { this.binds.unbindAll(); }, 'remove every key binding');
    r('bindlist', () => { for (const [k, v] of this.binds.all()) this.print(`${k} "${v}"\n`); }, 'list the key bindings');
    r('alias', (a, line) => {
      if (a.length === 1) { for (const [k, v] of this.aliases) this.print(`${k} : ${v}\n`); return; }
      const name = a[1].toLowerCase();
      if (a.length === 2) { const v = this.aliases.get(name); this.print(v !== undefined ? `${name} : ${v}\n` : `no alias ${name}\n`); return; }
      // The value is the rest of the line, quotes stripped once (QW Cmd_Alias_f).
      let v = argsOf(argsOf(line)).trim();
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
      this.aliases.set(name, v);
      this.saveAliases();
    }, 'name a command sequence');
    r('unalias', (a) => { if (a[1]) { this.aliases.delete(a[1].toLowerCase()); this.saveAliases(); } });
    const setVar = (a: string[], archive: boolean): void => {
      if (a.length < 3) return;
      const name = a[1].toLowerCase();
      // QW `set` creates a user cvar when there is none.
      if (!this.cvars.has(name)) this.cvars.register({ name, def: '', kind: 'string', group: 'game', label: name, help: 'user variable', archive });
      if (!this.cvars.set(name, a.slice(2).join(' '))) this.print(`"${a[2]}" is not a valid value for ${name}\n`);
    };
    r('set', (a) => setVar(a, false));
    r('seta', (a) => setVar(a, true));
    r('toggle', (a) => { if (a[1]) this.cvars.set(a[1], this.cvars.num(a[1]) ? '0' : '1'); });
    r('inc', (a) => { if (a[1]) this.cvars.set(a[1], String(this.cvars.num(a[1]) + (a[2] ? Number(a[2]) || 0 : 1))); });
    r('reset', (a) => { if (a[1]) this.cvars.reset(a[1]); });
    r('cvarlist', (a) => {
      const f = (a[1] ?? '').toLowerCase();
      let n = 0;
      for (const name of this.cvars.list(f)) {
        const d = this.cvars.def(name);
        n++;
        this.print(`${d?.archive !== false ? '*' : ' '} ${name} "${this.cvars.get(name)}"${d?.help ? `  ${d.help}` : ''}\n`);
      }
      this.print(`${n} cvars\n`);
    }, 'list console variables');
    r('cmdlist', () => {
      const names = [...this.commands.keys()].sort();
      for (const n of names) { const d = this.commands.get(n)!; this.print(`${n}${d.desc ? `  ${d.desc}` : ''}\n`); }
      this.print(`${names.length} commands\n`);
    }, 'list commands');
    r('exec', (a) => {
      const name = (a[1] ?? '').toLowerCase();
      if (!name) { this.print('exec <filename> : run a config stored in this browser\n'); return; }
      const text = this.configs.get(name) ?? this.configs.get(`${name}.cfg`);
      if (text === null) { this.print(`couldn't exec ${name}\n`); return; }
      this.exec(text);
    }, 'run a config stored in this browser');
    r('writeconfig', (a) => {
      const name = (a[1] ?? 'config.cfg').toLowerCase();
      const file = name.endsWith('.cfg') ? name : `${name}.cfg`;
      try { this.configs.save(file, this.exportText() + this.aliasText()); this.print(`wrote ${file}\n`); } catch (e) { this.print(`could not write: ${e}\n`); }
    }, 'store the binds, aliases and settings as a config in this browser');
    r('cfglist', () => { for (const n of this.configs.list()) this.print(`${n}\n`); }, 'list the stored configs');
    r('savecfg', (a) => {
      // savecfg <name> "<commands>": store a config typed or pasted into the console
      const name = (a[1] ?? '').toLowerCase();
      if (!name || a.length < 3) { this.print('savecfg <name> "<commands>"\n'); return; }
      try { this.configs.save(name, a.slice(2).join(' ')); this.print(`stored ${name}\n`); } catch (e) { this.print(`could not store: ${e}\n`); }
    }, 'store a config in this browser');
    r('wait', () => { /* QW's wait delays a frame; commands here run at once */ });
  }
}
