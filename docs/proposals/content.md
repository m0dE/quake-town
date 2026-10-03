# Proposals from the content part

## DESIGN.md (integrator)

- `public/packs/index.json` entries carry two more fields than the contract lists:
  `file` (the pk3 name under `packs/`, e.g. `base-99dfe0773ebd.pk3`) and `title`.
  `maps[].players` is `[min, max]`. The rooms code (`src/rooms/modes.ts`) already reads
  `file` and accepts `players` as an array.
- Resolver order: the client checks the IndexedDB cache (by sha256, re-verified) before the
  built-in index and the room URL. The cache only ever holds verified bytes, so the result
  is the same as the documented order; it just skips a download.
- Built-in packs may be referenced by name (`"base"`, `"maps-qt"`) or 12-char short id;
  community packs need the full sha256 (a short id is not a verification).
- ericw-tools 2.0.0-alpha11 Linux binaries are built with Embree, which makes those
  binaries GPL-3.0-or-later (their README says so). They are build-time tools only, never
  shipped, and the BSPs they write are ours, so nothing changes for the tree's licence;
  the Licensing section could say "ericw-tools (GPL-2.0-or-later source; the Embree build
  is GPL-3.0-or-later)".

## Shell

- Content API (`src/content/index.ts`):
  ```ts
  const content = createContent();              // packs from ./packs/
  await content.loadBase(onProgress);           // base + the player's stored id paks (art only)
  await content.loadRoom([{ id: 'maps-qt' }, { id: 'maps-lq' }, { id: qtdmShortId }, { id: sha, url }], onProgress);
  new Renderer(canvas, content.vfs, …);         // art view
  sim.map_load(content.vfs.sim.get('maps/qt_aero.bsp'));   // sim view: never reads id paks
  content.maps();                               // maps.json of the mounted packs
  ```
  `content.idPaks` implements the menu's `IdPakLoader` (status/load/forget) and mounts
  the paks immediately; `content.cacheLocalPack(file)` implements `MenuDeps.cacheLocalPack`.
  Use `content.vfs.onChange(fn)` to drop renderer/audio caches when id paks change.
- `package.json` could add `"test:content": "tsx src/content/tests/content.test.ts"`.

## Renderer

- LibreQuake's `gfx/colormap.lmp` is 16384 bytes (64 rows × 256), not id's 16385 (no
  trailing byte). Don't require 16385.
- `progs/flag.mdl` (base pack): skin 0 = red (team 1), skin 1 = blue (team 2), 8 frames
  `wave1..wave8` meant to loop at ~10 Hz. Origin at the foot of the pole, 74 units tall.
  If the mod keeps frame 0, the renderer could animate it client-side (r_lerpframes
  already handles frame changes).

## Mod

- `progs/flag.mdl` exists now with real team skins (0 red, 1 blue): `QT_FLAG_REAL` can be
  on. Cycle `frame` 0..7 every 0.1 s on the standing flag for the waving cloth.
- qt_fort has `item_flag_team1` (red, west keep, x = -2112) / `item_flag_team2` (blue,
  east, x = 2112), 6 `info_player_team1` + 6 `info_player_team2`, 14
  `info_player_deathmatch`. qt_aero kills with a `trigger_hurt` (`dmg 1000`) in the void,
  so falls are deathtype 0 ("died"); a "fell into the void" obituary would read better.

## Bots (qtbots)

- 5-minute 4-bot runs with `qtrun` (native): qt_tower 92 kills, 38 pickups, RA taken 3×,
  Quad 2× (jump pad + lift used). qt_aero: 123 of 299 deaths were falls into the void —
  bots walk off platform edges and miss the 160-unit gap jump; edges of floating
  platforms need "don't step off" handling. qt_fort CTF (8 bots): no flag was taken in
  5 minutes and 3 bots drowned in the flooded tunnels (928 units of water).
