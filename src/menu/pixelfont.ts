/**
 * The menu's pixel face: an original 5×7 bitmap alphabet (drawn for Quake Town, GPL-2.0-or-later),
 * rendered as crisp SVG and coloured like QuakeWorld's bronze console characters.
 *
 * `pixelText('Quake Town', { px: 10 })` → an <svg> whose width is the text's. Unknown
 * characters draw as a space. Lower case is drawn as upper case (Quake's menu font had none).
 */

const G: Record<string, string> = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.####|#....|#....|#....|#....|#....|.####',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####',
  F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.####|#....|#....|#..##|#...#|#...#|.####',
  H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '#####|..#..|..#..|..#..|..#..|..#..|#####',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#',
  X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  2: '.###.|#...#|....#|..##.|.#...|#....|#####',
  3: '####.|....#|....#|.###.|....#|....#|####.',
  4: '#..#.|#..#.|#..#.|#####|...#.|...#.|...#.',
  5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '.###.|#....|#....|####.|#...#|#...#|.###.',
  7: '#####|....#|...#.|..#..|..#..|..#..|..#..',
  8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  9: '.###.|#...#|#...#|.####|....#|....#|.###.',
  '-': '.....|.....|.....|.###.|.....|.....|.....',
  '.': '.....|.....|.....|.....|.....|.....|..#..',
  ':': '.....|..#..|.....|.....|.....|..#..|.....',
  '!': '..#..|..#..|..#..|..#..|..#..|.....|..#..',
  '?': '.###.|#...#|....#|..##.|..#..|.....|..#..',
  '/': '....#|....#|...#.|..#..|.#...|#....|#....',
  "'": '..#..|..#..|.#...|.....|.....|.....|.....',
  '>': '#....|.#...|..#..|...#.|..#..|.#...|#....',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
};

const ADVANCE = 6;    // 5 + 1 column of space
const HEIGHT = 7;

let gid = 0;

export interface PixelOpts {
  /** Size of one pixel in CSS px. */
  px?: number;
  /** 'bronze' (QW console gold), 'bone' (plain light), 'dim', or 'current' (currentColor). */
  tone?: 'bronze' | 'bone' | 'dim' | 'current';
  /** Hard drop shadow one pixel down-right. */
  shadow?: boolean;
  className?: string;
  /** Two-pixel vertical strokes (display sizes). */
  bold?: boolean;
}

const PITCH = 9;     // line height: 7 + 2 rows of space

/** The pixel path of `text` (runs of lit pixels as rects; "\n" starts a new line), and its size in pixels. */
export function pixelPath(text: string, bold = false): { d: string; w: number; h: number } {
  const adv = bold ? 9 : ADVANCE;
  const lines = text.toUpperCase().split('\n');
  let d = '';
  let w = 1;
  lines.forEach((line, li) => {
    const chars = [...line];
    w = Math.max(w, chars.length * adv - 1);
    chars.forEach((ch, i) => {
      const rows = (G[ch] ?? G[' ']).split('|');
      for (let y = 0; y < HEIGHT; y++) {
        // Bold: columns 0, 2 and 4 are two pixels wide (an 8-wide glyph), so strokes double
        // and every one-pixel counter stays open.
        const row = bold ? [...rows[y]].map((c, x) => (x % 2 === 0 ? c + c : c)).join('') : rows[y];
        let x = 0;
        while (x < row.length) {
          if (row[x] !== '#') { x++; continue; }
          let run = 1;
          while (x + run < row.length && row[x + run] === '#') run++;
          d += `M${i * adv + x} ${li * PITCH + y}h${run}v1h${-run}z`;
          x += run;
        }
      }
    });
  });
  return { d, w, h: (lines.length - 1) * PITCH + HEIGHT };
}

const SVGNS = 'http://www.w3.org/2000/svg';

export function pixelText(text: string, opts: PixelOpts = {}): SVGSVGElement {
  const px = opts.px ?? 3;
  const tone = opts.tone ?? 'bronze';
  const shadow = opts.shadow ?? tone === 'bronze';
  const { d, w, h } = pixelPath(text, opts.bold);
  const sw = w + (shadow ? 1 : 0);
  const sh = h + (shadow ? 1 : 0);
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${sw} ${sh}`);
  svg.setAttribute('width', String(sw * px));
  svg.setAttribute('height', String(sh * px));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', text);
  svg.classList.add('px');
  if (opts.className) svg.classList.add(...opts.className.split(' '));
  let fill = 'currentColor';
  if (tone === 'bronze') {
    const id = `pxg${++gid}`;
    // QW conchars' gold: pale at the top, burnt at the foot, in hard bands.
    // Bands of 2, 2, 2, 1 rows per line, repeating every line.
    const o = (r: number): string => (r / PITCH).toFixed(4);
    svg.innerHTML = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="${PITCH}" gradientUnits="userSpaceOnUse" spreadMethod="repeat">
      <stop offset="0" stop-color="#ffe9a8"/><stop offset="${o(2)}" stop-color="#ffe9a8"/>
      <stop offset="${o(2)}" stop-color="#f0b45a"/><stop offset="${o(4)}" stop-color="#f0b45a"/>
      <stop offset="${o(4)}" stop-color="#d07a2c"/><stop offset="${o(6)}" stop-color="#d07a2c"/>
      <stop offset="${o(6)}" stop-color="#9a4a1a"/><stop offset="1" stop-color="#9a4a1a"/></linearGradient></defs>`;
    fill = `url(#${id})`;
  } else if (tone === 'bone') fill = '#efe2c6';
  else if (tone === 'dim') fill = '#8c785f';
  if (shadow) {
    const s = document.createElementNS(SVGNS, 'path');
    s.setAttribute('d', d);
    s.setAttribute('transform', 'translate(1 1)');
    s.setAttribute('fill', '#0c0705');
    svg.appendChild(s);
  }
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', fill);
  svg.appendChild(p);
  return svg;
}
