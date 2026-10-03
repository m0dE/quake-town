/**
 * Pack sandbox rules (DESIGN.md "Sandbox"): path sanitising and size limits.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
export const LIMITS = {
  packBytes: 64 * 1024 * 1024,
  roomPacksBytes: 128 * 1024 * 1024,
  bspBytes: 32 * 1024 * 1024,
  progsBytes: 4 * 1024 * 1024,
  zipEntries: 4096,
  /** the player's own id paks are art only and never shared; pak0+pak1 of every release fit */
  idPakBytes: 256 * 1024 * 1024,
} as const;

/**
 * Normalise a path from a pack directory to a Quake path, or null if it is unsafe:
 * lower-case, forward slashes, no leading "./", no "..", no absolute paths or drive letters,
 * no empty components, no control characters, ≤ 255 chars.
 */
export function sanitizePath(raw: string): string | null {
  if (!raw || raw.length > 255) return null;
  let p = raw.replace(/\\/g, '/');
  if (/[\x00-\x1f\x7f]/.test(p)) return null;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  while (p.startsWith('./')) p = p.slice(2);
  if (p.endsWith('/')) return null; // a directory entry
  const parts = p.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
  }
  return p.toLowerCase();
}

export class PackError extends Error {
  constructor(message: string) { super(message); this.name = 'PackError'; }
}

/** per-file limits by type */
export function checkFileSize(path: string, bytes: number): void {
  if (path.endsWith('.bsp') && bytes > LIMITS.bspBytes) throw new PackError(`${path} is ${bytes} bytes (a map may be at most 32 MB)`);
  if (/(^|\/)(qw)?progs\.dat$/.test(path) && bytes > LIMITS.progsBytes) throw new PackError(`${path} is ${bytes} bytes (progs may be at most 4 MB)`);
}
