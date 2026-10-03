/*
 * Quake Town — keyboard and mouse to the usercmd the sim takes once per beat.
 * Semantics of QW's cl_input.c (kbuttons, CL_BaseMove, CL_AdjustAngles, IN_MouseMove;
 * Copyright (C) 1996-1997 Id Software, Inc., GPL-2.0-or-later), written fresh.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 *
 * The view angles are absolute and live here: the mouse turns them every frame,
 * the camera reads them every frame, and each beat sends them whole as
 * ANGLE2SHORT. A key pressed and released between two beats (a tap shorter than
 * 13 ms) is latched until the next beat so it is never lost.
 */
import type { CommandSystem } from '../console/commands.js';
import type { Cvars } from '../console/cvars.js';
import { BUTTON_ATTACK, BUTTON_JUMP } from '../sim/abi.js';
import { angleToShort, type UserCmd } from '../sim/wire.js';
import { isConsoleKey, keyName, mouseName } from './keys.js';

export type KeyDest = 'game' | 'console' | 'message' | 'menu';

export interface InputHooks {
  /** Where keys go right now. */
  keyDest(): KeyDest;
  /** A key for the console / chat line / menu (not the game). */
  textKey(e: KeyboardEvent): void;
  /** The pointer lock went away while playing (Esc under lock): QW's togglemenu. */
  lockLost(): void;
}

/** QW kbutton: held, plus "went down since the last cmd" so a tap counts once. */
interface KButton { held: Set<string>; tapped: boolean }

const BUTTONS = ['forward', 'back', 'moveleft', 'moveright', 'moveup', 'movedown', 'left', 'right', 'lookup', 'lookdown',
  'jump', 'attack', 'speed', 'strafe', 'klook', 'mlook', 'showscores'] as const;
type ButtonName = typeof BUTTONS[number];

export class Input {
  /** Degrees, QW convention: [pitch (down positive), yaw, roll]. */
  readonly viewangles: [number, number, number] = [0, 0, 0];
  /** Scoreboard (+showscores) state for the HUD. */
  get showScores(): boolean { return this.down('showscores'); }

  private readonly kb = new Map<ButtonName, KButton>();
  private impulses: number[] = [];
  private mouseDx = 0;
  private mouseDy = 0;
  private oldDx = 0;
  private oldDy = 0;
  private readonly pressedBind = new Map<string, string>();
  private disposers: (() => void)[] = [];
  enabled = true;

  constructor(private readonly target: HTMLElement, private readonly cmds: CommandSystem, private readonly cvars: Cvars, private readonly hooks: InputHooks) {
    for (const b of BUTTONS) {
      const k: KButton = { held: new Set(), tapped: false };
      this.kb.set(b, k);
      cmds.register(`+${b}`, (a) => { const key = a[1] ?? '_'; if (!k.held.has(key)) { k.held.add(key); k.tapped = true; } });
      cmds.register(`-${b}`, (a) => { if (a[1]) k.held.delete(a[1]); else k.held.clear(); });
    }
    cmds.register('impulse', (a) => { const n = Number(a[1]); if (Number.isInteger(n) && n > 0 && n < 256 && this.impulses.length < 8) this.impulses.push(n); }, 'queue a weapon/action impulse');
    cmds.register('centerview', () => { this.viewangles[0] = 0; });

    this.on(document, 'mousemove', (e) => this.onMouseMove(e as MouseEvent));
    this.on(window, 'mousedown', (e) => this.onButton(e as MouseEvent, true));
    this.on(window, 'mouseup', (e) => this.onButton(e as MouseEvent, false));
    this.on(window, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.on(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.on(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.on(window, 'blur', () => this.releaseAll());
    this.on(window, 'contextmenu', (e) => { if (this.locked) e.preventDefault(); });
    this.on(document, 'pointerlockchange', () => {
      if (!this.locked) { this.releaseAll(); if (this.enabled && this.hooks.keyDest() === 'game') this.hooks.lockLost(); }
    });
  }

  get locked(): boolean { return document.pointerLockElement === this.target; }

  lock(): void {
    if (this.locked) return;
    try {
      const raw = this.cvars.num('m_rawinput') !== 0;
      const p = (this.target.requestPointerLock as unknown as (o?: unknown) => Promise<void> | void).call(this.target, raw ? { unadjustedMovement: true } : undefined);
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => { try { void this.target.requestPointerLock(); } catch { /* not now */ } });
      }
    } catch { /* needs a gesture */ }
  }

  unlock(): void { if (this.locked) document.exitPointerLock(); }

  /** Is a button held (or tapped since the last cmd)? */
  down(b: ButtonName): boolean { const k = this.kb.get(b)!; return k.held.size > 0 || k.tapped; }

  /**
   * Per rendered frame: mouse and turn keys into the view angles (CL_AdjustAngles +
   * IN_MouseMove). `dt` in seconds.
   */
  frame(dt: number): void {
    let dx = this.mouseDx, dy = this.mouseDy;
    this.mouseDx = 0; this.mouseDy = 0;
    if (this.cvars.num('m_filter')) { const ox = this.oldDx, oy = this.oldDy; this.oldDx = dx; this.oldDy = dy; dx = (dx + ox) * 0.5; dy = (dy + oy) * 0.5; }
    if (!this.enabled) return;
    const sens = this.cvars.num('sensitivity');
    const va = this.viewangles;
    // QW: cl.viewangles[YAW] -= m_yaw * mouse_x; cl.viewangles[PITCH] += m_pitch * mouse_y (freelook).
    va[1] -= this.cvars.num('m_yaw') * dx * sens;
    const mp = this.cvars.num('m_pitch') * (this.cvars.num('invert_mouse') ? -1 : 1);
    va[0] += mp * dy * sens;
    // CL_AdjustAngles: keyboard turning
    const speed = this.down('speed') ? dt * 2.5 : dt;    // cl_anglespeedkey 1.5 + 1 like QW's run turn
    if (!this.down('strafe')) {
      va[1] -= speed * this.cvars.num('cl_yawspeed') * ((this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0));
    }
    va[0] -= speed * this.cvars.num('cl_pitchspeed') * ((this.down('lookup') ? 1 : 0) - (this.down('lookdown') ? 1 : 0));
    this.clampAngles();
  }

  /** QW clamps pitch to 80 down, 70 up; yaw wraps. */
  clampAngles(): void {
    const va = this.viewangles;
    if (va[0] > 80) va[0] = 80;
    if (va[0] < -70) va[0] = -70;
    va[1] = ((va[1] % 360) + 360) % 360;
    va[2] = 0;
  }

  /** The sim set our angles (teleport, respawn: QW svc_setangle). */
  setAngles(pitch: number, yaw: number): void {
    this.viewangles[0] = pitch > 180 ? pitch - 360 : pitch;
    this.viewangles[1] = yaw;
    this.clampAngles();
  }

  /** This beat's usercmd (CL_BaseMove + buttons + impulse). Clears the one-beat latches. */
  cmd(): UserCmd {
    const c = this.cvars;
    let forward = 0, side = 0, up = 0, buttons = 0, impulse = 0;
    if (this.enabled) {
      const k = (b: ButtonName): number => (this.down(b) ? 1 : 0);
      if (this.down('strafe')) {
        side += c.num('cl_sidespeed') * k('right');
        side -= c.num('cl_sidespeed') * k('left');
      }
      side += c.num('cl_sidespeed') * k('moveright');
      side -= c.num('cl_sidespeed') * k('moveleft');
      up += c.num('cl_upspeed') * k('moveup');
      up -= c.num('cl_upspeed') * k('movedown');
      forward += c.num('cl_forwardspeed') * k('forward');
      forward -= c.num('cl_backspeed') * k('back');
      if (this.down('speed')) { const m = c.num('cl_movespeedkey') || 2; forward *= m; side *= m; up *= m; }
      if (this.down('attack')) buttons |= BUTTON_ATTACK;
      if (this.down('jump')) buttons |= BUTTON_JUMP;
      impulse = this.impulses.shift() ?? 0;
    }
    for (const kb of this.kb.values()) kb.tapped = false;
    const clamp = (v: number): number => Math.max(-500, Math.min(500, Math.round(v)));
    return {
      pitch: angleToShort(this.viewangles[0]), yaw: angleToShort(this.viewangles[1]),
      forward: clamp(forward), side: clamp(side), up: clamp(up), buttons, impulse,
    };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.unlock();
  }

  releaseAll(): void {
    for (const [, bind] of this.pressedBind) if (bind.startsWith('+')) this.cmds.exec(`-${bind.slice(1)}`);
    this.pressedBind.clear();
    for (const kb of this.kb.values()) kb.held.clear();
  }

  // ---------------------------------------------------------------- events
  private on(t: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    t.addEventListener(type, fn, opts);
    this.disposers.push(() => t.removeEventListener(type, fn, opts));
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.locked) return;
    this.mouseDx += e.movementX;
    this.mouseDy += e.movementY;
  }

  private onButton(e: MouseEvent, down: boolean): void {
    if (!this.enabled) return;
    if (!this.locked) {
      // The first click captures the mouse; it is not a shot.
      if (down && e.button === 0 && e.target === this.target && this.hooks.keyDest() === 'game') this.lock();
      return;
    }
    this.key(mouseName(e.button), down);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.locked || !this.enabled) return;
    e.preventDefault();
    const name = e.deltaY < 0 ? 'mwheelup' : e.deltaY > 0 ? 'mwheeldown' : '';
    if (!name) return;
    this.key(name, true);
    this.key(name, false);
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (down && isConsoleKey(e)) {
      e.preventDefault();
      if (!e.repeat) this.cmds.exec('toggleconsole');
      return;
    }
    const dest = this.hooks.keyDest();
    if (dest !== 'game') {
      if (down) this.hooks.textKey(e);
      else { const name = keyName(e); if (this.pressedBind.has(name)) this.key(name, false); }
      return;
    }
    if (!this.enabled) return;
    const name = keyName(e);
    // Keep the browser's own keys (F5 reload, F11 fullscreen, F12 devtools when unbound).
    if (!this.cmds.bindOf(name) && /^f([5]|1[12])$/.test(name)) return;
    e.preventDefault();
    if (down && e.repeat) return;
    this.key(name, down);
  }

  /** A key went down or up in the game: run its bind (QW Key_Event). Public for tests. */
  key(name: string, down: boolean): void {
    if (down) {
      const bind = this.cmds.bindOf(name);
      if (!bind) return;
      this.pressedBind.set(name, bind);
      // "+attack" gets the key name appended so two keys holding one button release correctly.
      if (bind.startsWith('+')) this.cmds.exec(`${bind} ${name}`);
      else this.cmds.exec(bind);
    } else {
      const bind = this.pressedBind.get(name);
      this.pressedBind.delete(name);
      if (bind && bind.startsWith('+')) {
        const first = bind.split(/[;\s]/)[0];
        this.cmds.exec(`-${first.slice(1)} ${name}`);
      }
    }
  }
}
