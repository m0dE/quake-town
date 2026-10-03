# src/menu — the start screen

Owner: menu part. The game part (`src/main.ts`) calls exactly this:

```ts
import { showMenu, hideMenu, type MenuDeps, type PlayRequest } from './menu/index.js';

const req: PlayRequest = await showMenu(document.getElementById('app')!, deps);
hideMenu();                 // or let showMenu's caller hide it once the world is up
// ... connect to req.roomId with req.config, then play
// on disconnect / quit: showMenu(root, { ...deps, notice: 'Disconnected: …' }) again
```

`showMenu(root, deps)` builds the start screen inside `root` (it owns `root`'s children
while shown; nothing else is drawn over or under it), and resolves **once** with a
`PlayRequest` when the player picks something to play. Calling it again while it is up
returns the same pending promise. `hideMenu()` removes it and stops the server-list
refresh and the preview animation; it is safe to call twice.

```ts
interface PlayRequest {
  roomId: string;            // 'qt1.<b64url>-quaketown' — pass to arrr-network connect()
  config: RoomConfig;        // decoded; src/rooms/config.ts. Every client derives the world from it
  serverinfo: string;        // toServerinfo(config): the infostring for world_new
  spectate?: boolean;        // join as spectator (do not send { j: 1 })
  offline?: boolean;         // practice against bots, no network: run the sim locally
  nodeUrl?: string;          // preferred node for this room's region, when the build names one
  identity: IdentitySession | null;   // ARRR sign-in (pass to connect as `identity`)
  password?: string;         // what the player typed, already checked against config.password
}

interface MenuDeps {
  central?: string;                          // central URL override (?central=)
  notice?: string;                           // one line shown on top (e.g. why we came back)
  packIndex?: () => Promise<PackIndexEntry[]>;   // default: fetch('packs/index.json')
  renderPreview?: (canvas: HTMLCanvasElement, look: PlayerLook, t: number) => void;
                                             // renderer's renderCharacterPreview(canvas, vfs, look, t)
                                             // bound to the VFS; absent → a drawn placeholder
  idPaks?: IdPakLoader;                      // content part's id-pak loader (see below)
  cacheLocalPack?: (file: File) => Promise<{ id: string; name: string; bytes: number }>;
                                             // host's local .pk3/.pak → cached by sha256 (content part)
  models?: () => string[];                   // Player screen model list (default ['player'])
  skins?: () => string[];                    // Player screen skin list (default ['base'])
}

// PlayerLook (src/settings) = { model, skin, topcolor, bottomcolor } — the cvar values. The
// renderer's PlayerLook differs; adapt in main.ts (docs/proposals/menu.md has the snippet).

interface IdPakLoader {
  status(): Promise<{ loaded: boolean; files: { name: string; bytes: number }[] }>;
  load(files: File[]): Promise<{ ok: boolean; message: string }>;   // stores in IndexedDB
  forget(): Promise<void>;
}
```

Also exported from `./index.js`:

- `account` — the ARRR sign-in (`src/settings/account.ts`): `account.session()` for
  `connect({ identity })`; the menu paints it. Settings follow the account (see
  `src/settings/README.md`).
- `roomFromHash(location.hash)` — `#room=<roomId>` → `{ roomId, config }` or null. The
  menu handles the hash itself on `showMenu` (it opens the join dialog for that room); the
  game part may call it to skip the menu (e.g. `?autostart=1` tests).
- `roomLink(roomId)` — the shareable URL for a room (`…#room=…`), used by the game's
  scoreboard "copy link".

Rooms API (game part may use directly): `src/rooms/index.ts` — `encodeRoomId`,
`decodeRoomId`, `toServerinfo`, `MODES`, `modeDefaults`, `REGIONS`, `rememberNodeRtt`
(call it with `lockstep.roundTripMs` and the room's authority node once connected, so the
server list shows a real ping for that node next time).

Dev page (menu alone, no game): `npx vite --port 5192` → `http://localhost:5192/src/menu/dev.html`.
