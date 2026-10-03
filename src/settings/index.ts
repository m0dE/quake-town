/** Settings: cvars, binds, configs, persistence, the ARRR account. See README.md. */
export * from './cvars.js';
export * from './binds.js';
export * from './configs.js';
export * from './persist.js';
export * from './palette.js';
export { account, Account, type AccountState, type AccountStatus } from './account.js';

import { cvars } from './cvars.js';

/** The cosmetic player look: what the menu preview and the `{ look }` profile carry. */
export interface PlayerLook {
  model: string;
  skin: string;
  /** QW colour rows 0..13. */
  topcolor: number;
  bottomcolor: number;
}

export function playerLook(): PlayerLook {
  return { model: cvars.get('model'), skin: cvars.get('skin'), topcolor: cvars.num('topcolor'), bottomcolor: cvars.num('bottomcolor') };
}

const USERINFO_KEYS = ['name', 'team', 'topcolor', 'bottomcolor', 'skin'] as const;

/** `\name\…\team\…\topcolor\…\bottomcolor\…\skin\…` (values are cleaned of `\` and `"` by the registry). */
export function userinfo(): string {
  return USERINFO_KEYS.map((k) => `\\${k}\\${cvars.get(k)}`).join('');
}

/** Fires once per task after any userinfo cvar changed (so the game sends a single `{ u }`). */
export function onUserinfo(cb: (info: string) => void): () => void {
  let queued = false;
  return cvars.onChange('*', (name) => {
    if (!cvars.def(name)?.userinfo || queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; cb(userinfo()); });
  });
}
export * from './crosshair.js';
