/**
 * Favourite servers, in this browser (localStorage). A favourite is a room id, which
 * carries the whole config, so a favourite is listed even when the room is empty and
 * joining it re-creates it exactly.
 *
 * Licence: GPL-2.0-or-later.
 */
import { decodeRoomId } from './config.js';

const KEY = 'qt.favourites';
const MAX = 100;

export function favourites(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && decodeRoomId(x) !== null).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function isFavourite(roomId: string): boolean {
  return favourites().includes(roomId);
}

/** Toggle; returns the new state. */
export function toggleFavourite(roomId: string): boolean {
  const list = favourites();
  const i = list.indexOf(roomId);
  if (i >= 0) list.splice(i, 1);
  else if (decodeRoomId(roomId)) list.unshift(roomId);
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* storage blocked */ }
  return i < 0;
}
