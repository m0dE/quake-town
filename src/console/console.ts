/*
 * Quake Town — the drop-down console, the notify lines and the chat input line.
 * Behaviour follows QW's console.c / keys.c (Con_Print, Con_DrawNotify,
 * Con_DrawConsole, Key_Console, Key_Message, CompleteCommandLine);
 * Copyright (C) 1996-1997 Id Software, Inc., GPL-2.0-or-later; written fresh.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
import type { Draw2D } from '../hud/gfx.js';
import type { CommandSystem } from './commands.js';
import type { Cvars } from './cvars.js';

const MAX_LINES = 1024;
const HISTORY_KEY = 'qt.history';

interface Line { text: string; at: number }

export class Console {
  /** 0 closed .. 1 open (half screen). */
  private frac = 0;
  open = false;
  private lines: Line[] = [];
  private partial = '';
  private input = '';
  private cursor = 0;
  private history: string[] = [];
  private histPos = -1;
  private scroll = 0;
  /** messagemode: 0 off, 1 say, 2 say_team */
  chatMode = 0;
  private chatText = '';
  private lastFrame = 0;
  onChat: ((text: string, team: boolean) => void) | null = null;
  /** The console wants the mouse back (it opened): the game unlocks the pointer. */
  onToggle: ((open: boolean) => void) | null = null;

  constructor(private readonly cmds: CommandSystem, private readonly cvars: Cvars) {
    cmds.onPrint((t) => this.print(t));
    try { this.history = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]').slice(-64); } catch { this.history = []; }
    cmds.register('toggleconsole', () => this.toggle(), 'open or close the console');
    cmds.register('clear', () => { this.lines = []; this.partial = ''; }, 'clear the console');
    cmds.register('messagemode', () => this.startChat(1), 'type a message to everyone');
    cmds.register('messagemode2', () => this.startChat(2), 'type a message to your team');
    cmds.register('condump', () => { console.log(this.lines.map((l) => l.text).join('\n')); this.print('console written to the browser log\n'); });
  }

  /** Con_Print: text with \n line breaks, appended. */
  print(text: string): void {
    const now = performance.now();
    let s = this.partial + text;
    let nl: number;
    while ((nl = s.indexOf('\n')) >= 0) {
      this.lines.push({ text: s.slice(0, nl), at: now });
      s = s.slice(nl + 1);
    }
    this.partial = s;
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }

  toggle(): void {
    this.open = !this.open;
    if (this.open) { this.chatMode = 0; this.scroll = 0; }
    this.onToggle?.(this.open);
  }

  private startChat(mode: number): void {
    if (this.open) return;
    this.chatMode = mode;
    this.chatText = '';
    this.onToggle?.(true);
  }

  get keyDest(): 'console' | 'message' | null { return this.open ? 'console' : this.chatMode ? 'message' : null; }

  /** A key while the console or the chat line has the keyboard (Key_Console / Key_Message). */
  key(e: KeyboardEvent): void {
    if (this.chatMode) { this.chatKey(e); return; }
    e.preventDefault();
    const k = e.key;
    if (k === 'Escape') { this.toggle(); return; }
    if (k === 'Enter') {
      const line = this.input.trim();
      this.print(`]${this.input}\n`);
      if (line) {
        if (this.history[this.history.length - 1] !== line) this.history.push(line);
        if (this.history.length > 64) this.history.shift();
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history)); } catch { /* full */ }
        // QW: a line typed without a leading slash that is not a command is said (we keep it a command).
        this.cmds.exec(line.startsWith('/') || line.startsWith('\\') ? line.slice(1) : line);
      }
      this.input = ''; this.cursor = 0; this.histPos = -1; this.scroll = 0;
      return;
    }
    if (k === 'Tab') { this.complete(); return; }
    if (k === 'Backspace') { if (this.cursor > 0) { this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor); this.cursor--; } return; }
    if (k === 'Delete') { this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1); return; }
    if (k === 'ArrowLeft') { this.cursor = Math.max(0, this.cursor - 1); return; }
    if (k === 'ArrowRight') { this.cursor = Math.min(this.input.length, this.cursor + 1); return; }
    if (k === 'Home') { this.cursor = 0; return; }
    if (k === 'End') { this.cursor = this.input.length; return; }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      if (!this.history.length) return;
      if (k === 'ArrowUp') this.histPos = this.histPos < 0 ? this.history.length - 1 : Math.max(0, this.histPos - 1);
      else this.histPos = this.histPos < 0 ? -1 : this.histPos + 1 >= this.history.length ? -1 : this.histPos + 1;
      this.input = this.histPos < 0 ? '' : this.history[this.histPos];
      this.cursor = this.input.length;
      return;
    }
    if (k === 'PageUp') { this.scroll = Math.min(this.lines.length, this.scroll + 4); return; }
    if (k === 'PageDown') { this.scroll = Math.max(0, this.scroll - 4); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'v') {
      void navigator.clipboard?.readText().then((t) => { this.insert(t.replace(/[\r\n]+/g, ' ')); }).catch(() => {});
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'l') { this.lines = []; return; }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey) this.insert(k);
  }

  private insert(t: string): void {
    const clean = t.replace(/[^\x20-\x7e]/g, '');
    this.input = (this.input.slice(0, this.cursor) + clean + this.input.slice(this.cursor)).slice(0, 255);
    this.cursor = Math.min(this.input.length, this.cursor + clean.length);
  }

  private chatKey(e: KeyboardEvent): void {
    e.preventDefault();
    const k = e.key;
    if (k === 'Escape') { this.chatMode = 0; this.onToggle?.(false); return; }
    if (k === 'Enter') {
      const t = this.chatText.trim();
      const team = this.chatMode === 2;
      this.chatMode = 0;
      this.onToggle?.(false);
      if (t) this.onChat?.(t, team);
      return;
    }
    if (k === 'Backspace') { this.chatText = this.chatText.slice(0, -1); return; }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && this.chatText.length < 120) this.chatText += k.replace(/[^\x20-\x7e]/g, '');
  }

  /** CompleteCommandLine: commands, aliases and cvars; a list when ambiguous. */
  private complete(): void {
    const parts = this.input.split(' ');
    if (parts.length > 1) return;
    const p = parts[0].replace(/^[/\\]/, '').toLowerCase();
    if (!p) return;
    const names = new Set<string>();
    for (const n of this.cmds.commands.keys()) if (n.startsWith(p)) names.add(n);
    for (const n of this.cmds.aliases.keys()) if (n.startsWith(p)) names.add(n);
    for (const n of this.cvars.list(p)) names.add(n);
    const list = [...names].sort();
    if (!list.length) return;
    if (list.length === 1) { this.input = `${list[0]} `; this.cursor = this.input.length; return; }
    let common = list[0];
    for (const n of list) while (!n.startsWith(common)) common = common.slice(0, -1);
    this.print(`]${this.input}\n`);
    for (const n of list.slice(0, 40)) this.print(`  ${n}${this.cvars.has(n) ? ` "${this.cvars.get(n)}"` : ''}\n`);
    if (list.length > 40) this.print(`  ... ${list.length - 40} more\n`);
    this.input = common; this.cursor = common.length;
  }

  /** Draw the console (sliding), or the notify lines and the chat line when it is closed. Returns how much of the screen it covers. */
  draw(d: Draw2D, now: number, playing: boolean): number {
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const speed = (this.cvars.num('scr_conspeed') || 3000) / Math.max(200, d.h * d.s);
    const target = this.open ? 1 : 0;
    if (this.frac < target) this.frac = Math.min(target, this.frac + dt * speed);
    else if (this.frac > target) this.frac = Math.max(target, this.frac - dt * speed);
    // not playing (no world yet): the console is full screen like QW's
    const full = !playing && this.open;
    const height = Math.floor((full ? 1 : 0.5) * d.h * this.frac);
    if (height > 0) this.drawConsole(d, height);
    else this.drawNotify(d, now);
    return full ? this.frac : this.frac * 0.5;
  }

  private drawConsole(d: Draw2D, height: number): void {
    const back = d.gfx.lmp('gfx/conback.lmp');
    if (back) {
      const sw = d.w, sh = Math.floor(d.w * back.h / back.w);
      d.ctx.globalAlpha = 0.92;
      d.ctx.drawImage(back.canvas as CanvasImageSource, 0, 0, back.w, back.h, 0, (height - sh) * d.s, sw * d.s, sh * d.s);
      d.ctx.globalAlpha = 1;
    } else d.fillCss(0, 0, d.w, height, 'rgba(20,14,8,0.92)');
    d.fill(0, height - 1, d.w, 1, 0x6f);
    const cols = Math.floor(d.w / 8) - 2;
    // version text bottom right
    const ver = 'Quake Town';
    d.string(d.w - ver.length * 8 - 8, height - 12, ver, true);
    // input line
    let y = height - 22;
    const shown = (`]${this.input}`).slice(Math.max(0, this.cursor + 2 - cols));
    d.string(8, y, shown);
    if (Math.floor(performance.now() / 250) & 1) d.char(8 + Math.min(this.cursor + 1, cols - 1) * 8, y, 11);
    y -= 10;
    // wrap the scrollback to the width, newest at the bottom
    const wrapped: string[] = [];
    const want = Math.ceil(y / 8) + this.scroll + 1;
    for (let i = this.lines.length - 1; i >= 0 && wrapped.length < want; i--) {
      const t = this.lines[i].text;
      const parts: string[] = [];
      for (let k = 0; k < Math.max(1, t.length); k += cols) parts.push(t.slice(k, k + cols));
      for (let k = parts.length - 1; k >= 0; k--) wrapped.push(parts[k]);
    }
    if (this.scroll) { d.string(8, y, '^   ^   ^   ^   ^   ^   ^   ^', true); y -= 8; }
    for (let i = this.scroll; i < wrapped.length && y >= 0; i++) { d.string(8, y, wrapped[i]); y -= 8; }
  }

  /** Con_DrawNotify: the last few lines for con_notifytime seconds, and the say: line. */
  private drawNotify(d: Draw2D, now: number): void {
    const n = this.cvars.num('con_notifylines') || 4;
    const time = (this.cvars.num('con_notifytime') || 3) * 1000;
    let y = 0;
    const cols = Math.floor(d.w / 8) - 1;
    const recent = this.lines.slice(-n).filter((l) => now - l.at < time);
    for (const l of recent) { d.string(4, y, l.text.slice(0, cols)); y += 8; }
    if (this.chatMode) {
      const label = this.chatMode === 2 ? 'say_team: ' : 'say: ';
      const text = label + this.chatText;
      const shown = text.slice(Math.max(0, text.length - cols + 1));
      d.string(4, y, shown);
      if (Math.floor(now / 250) & 1) d.char(4 + shown.length * 8, y, 11);
    }
  }

  /** Lines for tests and the chat log. */
  tail(n: number): string[] { return this.lines.slice(-n).map((l) => l.text); }
}
