/*
 * Quake Town — the in-game pause panel: shown while the mouse is not captured
 * (Esc, a click outside, a focus loss). Resume, the console, leave to the menu.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */

export interface PauseHooks {
  resume(): void;
  leave(): void;
  console(): void;
}

const CSS = `
.qt-pause { position:absolute; inset:0; z-index:5; display:grid; place-items:center; background:rgba(8,6,4,0.45); font:600 14px/1.3 ui-monospace,Menlo,Consolas,monospace; color:#e8d8b0; }
.qt-pause.hidden { display:none; }
.qt-pause .box { min-width:280px; padding:22px 26px; background:rgba(24,18,12,0.94); border:1px solid #6b5432; box-shadow:0 0 0 1px #000, 0 12px 40px rgba(0,0,0,0.6); }
.qt-pause h2 { margin:0 0 14px; font-size:13px; letter-spacing:0.18em; color:#c8a050; text-transform:uppercase; }
.qt-pause button { display:block; width:100%; margin:6px 0; padding:9px 12px; text-align:left; font:inherit; color:#f2ead8; background:#2a2016; border:1px solid #4a3a24; cursor:pointer; }
.qt-pause button:hover, .qt-pause button:focus-visible { background:#3a2c1c; border-color:#c8a050; outline:none; }
.qt-pause .hint { margin-top:12px; font-size:12px; color:#9a8a6a; font-weight:400; }
`;

export class PausePanel {
  readonly el: HTMLDivElement;
  private shown = false;

  constructor(host: HTMLElement, hooks: PauseHooks, title: string) {
    if (!document.getElementById('qt-pause-css')) {
      const st = document.createElement('style');
      st.id = 'qt-pause-css';
      st.textContent = CSS;
      document.head.append(st);
    }
    this.el = document.createElement('div');
    this.el.className = 'qt-pause hidden';
    const box = document.createElement('div');
    box.className = 'box';
    const h = document.createElement('h2');
    h.textContent = title;
    const mk = (label: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Esc frees the mouse. ~ opens the console.';
    box.append(h, mk('Resume', () => hooks.resume()), mk('Console', () => hooks.console()), mk('Leave to the menu', () => hooks.leave()), hint);
    this.el.append(box);
    // a click on the dim area resumes too
    this.el.addEventListener('click', () => hooks.resume());
    box.addEventListener('click', (e) => e.stopPropagation());
    host.append(this.el);
  }

  get open(): boolean { return this.shown; }

  show(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.el.classList.toggle('hidden', !on);
  }

  dispose(): void { this.el.remove(); }
}
