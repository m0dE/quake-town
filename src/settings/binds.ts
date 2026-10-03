/**
 * Key bindings with QuakeWorld key names (keys.c `keynames[]`), and the DOM → QW key-name
 * mapping. The console's `bind`/`unbind`/`unbindall`, the input part's key handling and
 * the menu's controls page all go through `binds`.
 *
 * Licence: GPL-2.0-or-later.
 */

/** Modern defaults: WASD, mouse to shoot and jump. */
export const DEFAULT_BINDS: Readonly<Record<string, string>> = {
  w: '+forward', s: '+back', a: '+moveleft', d: '+moveright',
  space: '+jump', mouse2: '+jump', c: '+movedown', shift: '+speed',
  mouse1: '+attack', ctrl: '+attack',
  1: 'impulse 1', 2: 'impulse 2', 3: 'impulse 3', 4: 'impulse 4',
  5: 'impulse 5', 6: 'impulse 6', 7: 'impulse 7', 8: 'impulse 8',
  q: 'weapon 7 5 4 3 2 1', e: 'weapon 8 5 3 2 1',
  mwheelup: 'impulse 12', mwheeldown: 'impulse 10',
  tab: '+showscores', t: 'messagemode', y: 'messagemode2',
  '`': 'toggleconsole', '~': 'toggleconsole',
  f1: 'ready', f2: 'break', f12: 'screenshot',
  escape: 'togglemenu', pause: 'pause',
  uparrow: '+forward', downarrow: '+back', leftarrow: '+left', rightarrow: '+right',
};

type Listener = () => void;

export class Binds {
  private map = new Map<string, string>();
  private readonly listeners = new Set<Listener>();

  constructor(defaults: Readonly<Record<string, string>> = DEFAULT_BINDS) {
    for (const [k, v] of Object.entries(defaults)) this.map.set(k, v);
  }

  get(key: string): string { return this.map.get(normKey(key)) ?? ''; }

  set(key: string, command: string): void {
    const k = normKey(key);
    const c = command.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256);
    if (!k) return;
    if (!c) { this.unbind(k); return; }
    if (this.map.get(k) === c) return;
    this.map.set(k, c);
    this.emit();
  }

  unbind(key: string): void {
    if (this.map.delete(normKey(key))) this.emit();
  }

  unbindAll(): void {
    if (!this.map.size) return;
    this.map.clear();
    this.emit();
  }

  resetDefaults(): void {
    this.map = new Map(Object.entries(DEFAULT_BINDS));
    this.emit();
  }

  /** Sorted by key name. */
  all(): [string, string][] {
    return [...this.map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  /** Every key bound to exactly `command`. */
  keysFor(command: string): string[] {
    const c = command.trim();
    return this.all().filter(([, v]) => v === c).map(([k]) => k);
  }

  /** Replace everything (persistence). */
  load(record: Record<string, string>): void {
    this.map = new Map(Object.entries(record).filter(([k, v]) => typeof v === 'string' && normKey(k)).map(([k, v]) => [normKey(k), v]));
    this.emit();
  }

  snapshot(): Record<string, string> { return Object.fromEntries(this.all()); }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private emit(): void {
    for (const l of this.listeners) { try { l(); } catch (err) { console.error(err); } }
  }
}

export const binds = new Binds();

/** Lower-case QW key name; single characters as themselves. */
export function normKey(key: string): string {
  const k = String(key).trim();
  return k.length === 1 ? k.toLowerCase() : k.toLowerCase().replace(/\s+/g, '');
}

const CODE_NAMES: Record<string, string> = {
  Space: 'space', Tab: 'tab', Enter: 'enter', NumpadEnter: 'kp_enter', Escape: 'escape', Backspace: 'backspace',
  ArrowUp: 'uparrow', ArrowDown: 'downarrow', ArrowLeft: 'leftarrow', ArrowRight: 'rightarrow',
  ShiftLeft: 'shift', ShiftRight: 'shift', ControlLeft: 'ctrl', ControlRight: 'ctrl', AltLeft: 'alt', AltRight: 'alt',
  Insert: 'ins', Delete: 'del', Home: 'home', End: 'end', PageUp: 'pgup', PageDown: 'pgdn', Pause: 'pause',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: 'semicolon',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', CapsLock: 'capslock',
  Numpad0: 'kp_ins', Numpad1: 'kp_end', Numpad2: 'kp_downarrow', Numpad3: 'kp_pgdn', Numpad4: 'kp_leftarrow',
  Numpad5: 'kp_5', Numpad6: 'kp_rightarrow', Numpad7: 'kp_home', Numpad8: 'kp_uparrow', Numpad9: 'kp_pgup',
  NumpadDecimal: 'kp_del', NumpadAdd: 'kp_plus', NumpadSubtract: 'kp_minus', NumpadMultiply: 'kp_star', NumpadDivide: 'kp_slash',
};

/**
 * The QW key name for a keyboard event. Uses the physical key (`code`) so WASD stays WASD
 * on AZERTY the way a QW player expects their muscle memory, letters/digits by position.
 */
export function keyName(e: Pick<KeyboardEvent, 'code' | 'key'>): string {
  if (CODE_NAMES[e.code]) return CODE_NAMES[e.code];
  let m = /^Key([A-Z])$/.exec(e.code);
  if (m) return m[1].toLowerCase();
  m = /^Digit(\d)$/.exec(e.code);
  if (m) return m[1];
  m = /^F(\d{1,2})$/.exec(e.code);
  if (m) return `f${m[1]}`;
  return normKey(e.key || e.code);
}

/** DOM mouse button → mouse1..mouse5 (QW: 1 left, 2 right, 3 middle). */
export function mouseKeyName(button: number): string {
  return ['mouse1', 'mouse3', 'mouse2', 'mouse4', 'mouse5'][button] ?? `mouse${button + 1}`;
}

export function wheelKeyName(deltaY: number): string {
  return deltaY < 0 ? 'mwheelup' : 'mwheeldown';
}
