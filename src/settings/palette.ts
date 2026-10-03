/**
 * The Quake palette and QW's player colour rows.
 *
 * The 256 colours are LibreQuake's gfx/palette.lmp (BSD-3-Clause, see
 * assets-licenses/LibreQuake-COPYING.txt) — the same palette id's Quake uses, so
 * `crosshaircolor` indices and topcolor/bottomcolor rows mean what they meant in QW.
 *
 * Player colours (QW `topcolor`/`bottomcolor` 0..13) pick a 16-colour row: the shirt/pants
 * texels 16..31 / 96..111 of a player skin are remapped to row*16.. (rows 8..13 run
 * bright→dark in the palette, so QW reverses them; R_TranslatePlayerSkin).
 *
 * Licence: GPL-2.0-or-later (code); palette data BSD-3-Clause (LibreQuake).
 */
const HEX =
  '0000000f0f0f1f1f1f2f2f2f3f3f3f4b4b4b5b5b5b6b6b6b7b7b7b8b8b8b9b9b9babababbbbbbbcbcbcbdbdbdbebebeb' +
  '0f0b07170f0b1f170b271b0f2f2313372b173f2f174b371b533b1b5b431f634b1f6b531f73571f7b5f238367238f6f23' +
  '0b0b0f13131b1b1b272727332f2f3f37374b3f3f574747674f4f735b5b7f63638b6b6b977373a37b7baf8383bb8b8bcb' +
  '0000000707000b0b001313001b1b002323002b2b072f2f073737073f3f074747074b4b0b53530b5b5b0b63630b6b6b0f' +
  '0700000f00001700001f00002700002f00003700003f00004700004f00005700005f00006700006f00007700007f0000' +
  '1313001b1b002323002f2b00372f004337004b3b075743075f47076b4b0b77530f8357138b5b13975f1ba3631faf6723' +
  '2313072f170b3b1f0f4b2313572b17632f1f7337237f3b2b8f43339f4f33af632fbf772fcf8f2bdfab27efcb1ffff31b' +
  '0b07001b13002b230f372b1347331b533723633f2b6f47337f533f8b5f479b6b53a77b5fb7876bc3937bd3a38be3b397' +
  'ab8ba39f7f979373878b677b7f5b6f7753636b4b575f3f4b5737434b2f3743272f371f232b171b231313170b0b0f0707' +
  'bb739faf6b8fa35f839757778b4f6b7f4b5f7343536b3b4b5f333f532b3747232b3b1f232f171b231313170b0b0f0707' +
  'dbc3bbcbb3a7bfa39baf978ba3877b977b6f876f5f7b63536b57475f4b3b533f33433327372b1f271f171b130f0f0b07' +
  '6f837b677b6f5f7367576b5f4f6357475b4f3f5347374b3f2f43372b3b2f2333271f2b1f1723170f1b130b130b070b07' +
  'fff31befdf17dbcb13cbb70fbba70fab970b9b83078b73077b63076b53005b47004b37003b2b002b1f001b0f000b0700' +
  '0000ff0b0bef1313df1b1bcf2323bf2b2baf2f2f9f2f2f8f2f2f7f2f2f6f2f2f5f2b2b4f23233f1b1b2f13131f0b0b0f' +
  '2b00003b00004b07005f07006f0f007f1707931f07a3270bb7330fc34b1bcf632bdb7f3be3974fe7ab5fefbf77f7d38b' +
  'a77b3bb79b37c7c337e7e3577fbfffabe7ffd7ffff6700008b0000b30000d70000ff0000fff393fff7c7ffffff9f5b53'
;

let rgb: Uint8Array | null = null;
function table(): Uint8Array {
  if (!rgb) {
    rgb = new Uint8Array(768);
    for (let i = 0; i < 768; i++) rgb[i] = parseInt(HEX.slice(i * 2, i * 2 + 2), 16);
  }
  return rgb;
}

/** Palette index → [r, g, b]. */
export function paletteRgb(i: number): [number, number, number] {
  const t = table();
  const k = (Math.max(0, Math.min(255, Math.floor(i))) * 3);
  return [t[k], t[k + 1], t[k + 2]];
}

/** Palette index → '#rrggbb'. */
export function paletteCss(i: number): string {
  return '#' + paletteRgb(i).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** The 768-byte palette, for the renderer if it wants it without the VFS. */
export function paletteBytes(): Uint8Array { return table().slice(); }

/** Names for QW's 14 colour rows (as players call them). */
export const PALETTE_ROW_NAMES: readonly string[] = [
  'White', 'Brown', 'Light blue', 'Green', 'Red', 'Olive', 'Orange', 'Peach',
  'Purple', 'Magenta', 'Tan', 'Teal', 'Yellow', 'Blue',
];

export const PLAYER_COLOR_ROWS = 14;

/** The 16 colours of row `row` (0..13), darkest first, as QW draws them on a player. */
export function rowRamp(row: number): string[] {
  const base = Math.max(0, Math.min(13, Math.floor(row))) * 16;
  const out: string[] = [];
  for (let k = 0; k < 16; k++) out.push(paletteCss(row < 8 ? base + k : base + 15 - k));
  return out;
}

/** One swatch colour for a row (a bright mid-tone). */
export function rowSwatch(row: number): string {
  return rowRamp(row)[11];
}

/** The 14 rows with their names and swatches, for pickers. */
export const PALETTE_ROWS = PALETTE_ROW_NAMES.map((name, row) => ({ row, name }));
