/*
 * Quake Town — browser key events to QW key names (keys.c's keynames table).
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */

const CODE_NAMES: Record<string, string> = {
  Space: 'space', Enter: 'enter', NumpadEnter: 'kp_enter', Tab: 'tab', Escape: 'escape', Backspace: 'backspace',
  ArrowUp: 'uparrow', ArrowDown: 'downarrow', ArrowLeft: 'leftarrow', ArrowRight: 'rightarrow',
  ShiftLeft: 'shift', ShiftRight: 'shift', ControlLeft: 'ctrl', ControlRight: 'ctrl', AltLeft: 'alt', AltRight: 'alt',
  MetaLeft: 'win', MetaRight: 'win', Insert: 'ins', Delete: 'del', PageUp: 'pgup', PageDown: 'pgdn', Home: 'home', End: 'end',
  Pause: 'pause', CapsLock: 'capslock', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: 'semicolon', Quote: "'", Comma: ',', Period: '.', Slash: '/', IntlBackslash: '<',
  Numpad0: 'kp_ins', Numpad1: 'kp_end', Numpad2: 'kp_downarrow', Numpad3: 'kp_pgdn', Numpad4: 'kp_leftarrow',
  Numpad5: 'kp_5', Numpad6: 'kp_rightarrow', Numpad7: 'kp_home', Numpad8: 'kp_uparrow', Numpad9: 'kp_pgup',
  NumpadDecimal: 'kp_del', NumpadAdd: 'kp_plus', NumpadSubtract: 'kp_minus', NumpadMultiply: 'kp_star', NumpadDivide: 'kp_slash',
};

/** The QW key name of a keyboard event, by physical position (so binds survive layouts). */
export function keyName(e: KeyboardEvent): string {
  const c = e.code;
  if (CODE_NAMES[c]) return CODE_NAMES[c];
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(c)) return c.toLowerCase();
  return (e.key || c || '').toLowerCase();
}

/** mouse1 = left, mouse2 = right, mouse3 = middle, mouse4/5 = side buttons (QW numbering). */
export function mouseName(button: number): string {
  return ['mouse1', 'mouse3', 'mouse2', 'mouse4', 'mouse5'][button] ?? `mouse${button + 1}`;
}

/** Is this the console key? Backquote by position, or `~`/`²` by character on layouts that move it. */
export function isConsoleKey(e: KeyboardEvent): boolean {
  return e.code === 'Backquote' || e.key === '`' || e.key === '~' || e.key === '²' || e.key === '§';
}
