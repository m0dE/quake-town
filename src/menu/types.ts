import type { IdentitySession } from 'arrr-network';
import type { PackIndexEntry, RoomConfig, RegionId, Mode } from '../rooms/index.js';
import type { PlayerLook } from '../settings/index.js';

export interface PlayRequest {
  roomId: string;
  config: RoomConfig;
  /** toServerinfo(config): the infostring for world_new. */
  serverinfo: string;
  spectate?: boolean;
  /** Practice against bots with no network: the game runs the sim locally. */
  offline?: boolean;
  /** Preferred node for this room's region, when the build names one. */
  nodeUrl?: string;
  identity: IdentitySession | null;
  password?: string;
}

export interface MenuDeps {
  central?: string;
  /** One line shown at the top (e.g. why the player is back in the menu). */
  notice?: string;
  packIndex?: () => Promise<PackIndexEntry[]>;
  renderPreview?: (canvas: HTMLCanvasElement, look: PlayerLook, t: number) => void;
  cacheLocalPack?: (file: File) => Promise<{ id: string; name: string; bytes: number }>;
  /** Models and skins to offer on the Customize screen (default: player / base). */
  models?: () => string[];
  skins?: () => string[];
}

export interface Screen {
  el: HTMLElement;
  show?(): void;
  hide?(): void;
  dispose?(): void;
}

export interface MenuCtx {
  deps: MenuDeps;
  index(): readonly PackIndexEntry[];
  onIndex(cb: () => void): void;
  region(): RegionId;
  quickMode(): Mode;
  /** Open the join dialog for a room (password, packs, spectate). */
  join(roomId: string, config: RoomConfig, opts?: { spectate?: boolean; direct?: boolean }): void;
  play(req: Omit<PlayRequest, 'serverinfo' | 'identity' | 'nodeUrl'>): void;
  toast(text: string): void;
  go(screen: ScreenId): void;
}

export type ScreenId = 'servers' | 'host' | 'player' | 'settings';
