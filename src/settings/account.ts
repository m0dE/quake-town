/**
 * Sign in with ARRR (the SDK's `identity`), adapted from doom-arrr's and vibe-strike's
 * account.ts.
 *
 * Signing in buys two things:
 *  1. A name on the network that is yours: the token goes to `connect({ identity })`, the
 *     node stamps the join's userId from it, so the game uses `session.userId` as the local
 *     member id.
 *  2. Settings that follow the player: the settings document moves into the account's
 *     vault record (persist.ts), the way vibe-strike's wardrobe does.
 *
 * Optional: a guest plays exactly the same, and nothing here may block Play.
 *
 * Licence: GPL-2.0-or-later.
 */
import { identity as sdkIdentity, vault, type IdentitySession } from 'arrr-network';
import { APP_ID } from '../rooms/listing.js';
import { cvars } from './cvars.js';
import { settings as defaultSettings, type Settings, type VaultDocLike } from './persist.js';

export type { IdentitySession };
export type AccountStatus = 'guest' | 'signing-in' | 'signed-in';

export interface AccountState {
  status: AccountStatus;
  session: IdentitySession | null;
  /** One sentence for the player when something did not work, else null. */
  note: string | null;
}

export interface IdentityLike {
  login(opts: { appId: string; centralServiceUrl?: string }): Promise<IdentitySession>;
  current(opts: { appId: string }): IdentitySession | null;
  logout(opts: { appId: string }): void;
  onChange(cb: (session: IdentitySession | null) => void): () => void;
}

const say = (err: unknown): string => {
  const m = err instanceof Error ? err.message : String(err);
  return /popup|closed|cancel/i.test(m) ? 'Sign-in was closed before it finished.' : `Could not sign in (${m}).`;
};

export class Account {
  private st: AccountState = { status: 'guest', session: null, note: null };
  private readonly listeners = new Set<(s: AccountState) => void>();
  private central: string | undefined;
  private unsub: (() => void) | null = null;

  constructor(
    private readonly id: IdentityLike = sdkIdentity,
    private readonly settings: Settings = defaultSettings,
    private readonly openVault: (s: IdentitySession) => VaultDocLike = (s) => vault.open(s),
  ) {}

  /** Pick up a sign-in this browser already has (also consumes a redirect's answer in the URL). */
  start(central?: string): void {
    this.central = central;
    this.unsub ??= this.id.onChange((session) => {
      // A refreshed session for the same player: keep it, nothing else changes.
      if (session && this.st.session && session.userId === this.st.session.userId && session.token !== this.st.session.token) {
        this.set({ ...this.st, session });
      }
    });
    if (this.st.status !== 'guest') return;
    try {
      const s = this.id.current({ appId: APP_ID });
      if (s) this.adopt(s);
    } catch (err) {
      this.set({ status: 'guest', session: null, note: say(err) });
    }
  }

  state(): AccountState { return this.st; }
  session(): IdentitySession | null { return this.st.session; }

  /** Called now and on every change; returns an unsubscribe. */
  onChange(cb: (s: AccountState) => void): () => void {
    this.listeners.add(cb);
    cb(this.st);
    return () => { this.listeners.delete(cb); };
  }

  async signIn(): Promise<void> {
    if (this.st.status === 'signing-in') return;
    this.set({ ...this.st, status: 'signing-in', note: null });
    try {
      const session = await this.id.login({ appId: APP_ID, ...(this.central ? { centralServiceUrl: this.central } : {}) });
      this.adopt(session);
    } catch (err) {
      this.set({ status: 'guest', session: null, note: say(err) });
    }
  }

  async signOut(): Promise<void> {
    await this.settings.detachVault();
    try { this.id.logout({ appId: APP_ID }); } catch { /* already gone */ }
    this.set({ status: 'guest', session: null, note: null });
  }

  private adopt(session: IdentitySession): void {
    this.set({ status: 'signed-in', session, note: null });
    void this.settings.attachVault(this.openVault(session)).then(() => {
      // The account's name, unless the player chose one of their own.
      const name = cvars.get('name');
      if (/^ranger\d{3}$/.test(name) || cvars.isDefault('name')) cvars.set('name', session.username);
    }).catch((err: unknown) => {
      if (this.st.session === session) {
        this.set({ ...this.st, note: 'Your settings stay in this browser for now: the account could not be reached.' });
      }
      console.warn('[account] settings vault:', err);
    });
  }

  private set(s: AccountState): void {
    this.st = s;
    for (const l of this.listeners) { try { l(s); } catch (err) { console.error(err); } }
  }
}

export const account = new Account();
