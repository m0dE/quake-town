/** Rooms: config in the room id, serverinfo, modes, regions, listing, ping, favourites. */
export * from './config.js';
export * from './modes.js';
export * from './regions.js';
export * from './listing.js';
export * from './ping.js';
export * from './favourites.js';

import { decodeRoomId, type RoomConfig } from './config.js';

/** `#room=<id>` (or `#<id>`) → the room, or null. */
export function roomFromHash(hash: string): { roomId: string; config: RoomConfig } | null {
  const h = hash.replace(/^#/, '');
  const params = new URLSearchParams(h);
  const id = params.get('room') ?? (h.startsWith('qt1.') ? h : null);
  if (!id) return null;
  const config = decodeRoomId(id);
  return config ? { roomId: id, config } : null;
}

/** The shareable link for a room on this page. */
export function roomLink(roomId: string, base: string = typeof location !== 'undefined' ? location.href : 'https://quake-town.play.arrr.fun/'): string {
  const u = new URL(base);
  u.hash = `room=${roomId}`;
  return u.toString();
}
