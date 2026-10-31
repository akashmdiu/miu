// Builds Miu's logo variants from the two drawn shapes (the cat mark and the
// monoline "miu"), so every variant shares the same geometry.
//   node assets/brand/build/variants.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = 'M12.5 26 C11 20 12 13 14.2 8.6 Q15.2 6.6 17.2 7.9 L26 14.6 Q32 12.8 38 14.6 L46.8 7.9 Q48.8 6.6 49.8 8.6 C52 13 53 20 51.5 26 C55 31 55.5 36 54.5 41 C52.5 51.5 43 56 32 56 C21 56 11.5 51.5 9.5 41 C8.5 36 9 31 12.5 26 Z';
const CUT = '<rect x="20.9" y="29.6" width="5.2" height="8.6" rx="2.6"/><rect x="37.9" y="29.6" width="5.2" height="8.6" rx="2.6"/><path d="M26.6 44.4 L30.2 48 L37 41.2" fill="none" stroke="#000" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>';
// "miu" with its baseline at y=46, x-height 18, stroke 5, starting at x=0.
const WORD = 'M0 46 V28 A7.5 7.5 0 0 1 15 28 V46 M15 28 A7.5 7.5 0 0 1 30 28 V46 M40.5 46 V21.5 M51 21.5 V38.5 A7.5 7.5 0 0 0 66 38.5 M66 21.5 V46';
const W = 'xmlns="http://www.w3.org/2000/svg"';

const mark = (c, id, t = '') => `<g${t ? ` transform="${t}"` : ''}><defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/><g fill="#000">${CUT}</g></mask></defs><path d="${HEAD}" fill="${c}" mask="url(#${id})"/></g>`;
const word = (c, t = '') => `<g${t ? ` transform="${t}"` : ''}><path d="${WORD}" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></g>`;
// The dot on the i is always the cat (a small solid head, no face at this size).
const iDot = (c, t = '') => `<g${t ? ` transform="${t}"` : ''}><path d="${HEAD}" fill="${c}" transform="translate(33.5 0.6) scale(0.22)"/></g>`;
const svg = (vb, body) => `<svg ${W} viewBox="${vb}"><title>Miu</title>${body}</svg>\n`;

const variants = {
  // The text alone.
  'miu-wordmark': (c) => svg('-3 2 72 47', word(c) + iDot(c)),
  // "miu." — a full stop the same size as the dot on the i.
  'miu-wordmark-dot': (c) => svg('-3 2 81 47', word(c) + iDot(c) + `<circle cx="75" cy="43.4" r="3.1" fill="${c}"/>`),
  // Icon and text side by side, and with the full stop.
  'miu-logo': (c) => svg('0 0 155 64', mark(c, 'a') + word(c, 'translate(82 0)') + iDot(c, 'translate(82 0)')),
  'miu-logo-dot': (c) => svg('0 0 164 64', mark(c, 'b') + word(c, 'translate(82 0)') + iDot(c, 'translate(82 0)') + `<circle cx="157" cy="43.4" r="3.1" fill="${c}"/>`),
  // Icon + text with the icon as large as in the dot logo: the text block (the
  // cat on the i to the baseline) is 10/14 of the icon's height, the gap 3/15
  // of its width, and the text block sits on the icon's middle.
  'miu-logo-big': (c) => {
    const ICON = { x: 8.5, y: 7.5, w: 47, h: 48.5 }, TEXT = { top: 2.25, h: 46.25, left: -2.5, w: 71 };
    const k = TEXT.h / (10 / 14) / ICON.h, H = ICON.h * k, gap = (ICON.w * k * 3) / 15;
    const tx = ICON.w * k + gap - TEXT.left, ty = (H - TEXT.h) / 2 - TEXT.top;
    const f = (n) => +n.toFixed(2);
    return svg(`0 0 ${f(tx + TEXT.left + TEXT.w)} ${f(H)}`, mark(c, 'g', `translate(${f(-ICON.x * k)} ${f(-ICON.y * k)}) scale(${f(k)})`) + word(c, `translate(${f(tx)} ${f(ty)})`) + iDot(c, `translate(${f(tx)} ${f(ty)})`));
  },
  // Icon above, text below.
  'miu-logo-stacked': (c) => svg('0 0 96 124', mark(c, 'c', 'translate(16 0)') + word(c, 'translate(14.5 72)') + iDot(c, 'translate(14.5 72)')),
};

// Dot versions, placed by hand on one grid (step 4, dot radius 1.5), so the
// eyes, the check and every stroke land on whole dots. X is a dot.
const CAT = [
  '.X...........X.',
  '.XX.........XX.',
  '.XXX.......XXX.',
  '.XXXXXXXXXXXXX.',
  'XXXXXXXXXXXXXXX',
  'XXX..XXXXX..XXX',
  'XXX..XXXXX..XXX',
  'XXXXXXXXXXXXXXX',
  'XXXXXXXXX.XXXXX',
  'XXXXX..X.XXXXXX',
  'XXXXXX..XXXXXXX',
  '.XXXXXXXXXXXXX.',
  '..XXXXXXXXXXX..',
  '....XXXXXXX....',
];
// "miu", two dots thick: a small dot cat over the i, a gap, six rows of letters.
const TEXT = [
  '.........X..X......',
  '.........XXXX......',
  '..........XX.......',
  '...................',
  '.XXXXXX...XX..XX..XX',
  'XX.XX.XX..XX..XX..XX',
  'XX.XX.XX..XX..XX..XX',
  'XX.XX.XX..XX..XX..XX',
  'XX.XX.XX..XX..XX..XX',
  'XX.XX.XX..XX...XXXX.',
];
const STEP = 4, R = 1.5;
const dots = (rows, ox, oy, c) => rows.flatMap((row, y) => [...row].map((ch, x) => (ch === 'X' ? `<circle cx="${ox + x * STEP + STEP / 2}" cy="${oy + y * STEP + STEP / 2}" r="${R}" fill="${c}"/>` : ''))).join('');
variants['miu-mark-dots'] = (c) => svg(`0 0 ${15 * STEP} ${14 * STEP}`, dots(CAT, 0, 0, c));
// Side by side: the whole text block, the dot on the i included, is centred
// on the cat's 14 rows.
const midRows = (rows) => ((CAT.length - rows.length) / 2) * STEP;
variants['miu-logo-dots'] = (c) => svg(`0 0 ${(15 + 3 + 20) * STEP} ${14 * STEP}`, dots(CAT, 0, 0, c) + dots(TEXT, (15 + 3) * STEP, midRows(TEXT), c));
// The same grid filled solid: every dot becomes a whole square, so the cat
// and the text read as one solid pixel shape.
const cells = (rows, ox, oy) => rows.flatMap((row, y) => [...row].map((ch, x) => (ch === 'X' ? `M${ox + x * STEP} ${oy + y * STEP}h${STEP}v${STEP}h-${STEP}z` : ''))).join('');
variants['miu-logo-pixel'] = (c) => svg(`0 0 ${(15 + 3 + 20) * STEP} ${14 * STEP}`, `<path d="${cells(CAT, 0, 0)}${cells(TEXT, (15 + 3) * STEP, midRows(TEXT))}" fill="${c}" shape-rendering="crispEdges"/>`);

const written = [];
for (const [name, make] of Object.entries(variants)) {
  for (const [tone, c] of [['black', '#0d0d0d'], ['white', '#ffffff']]) {
    const f = `${name}-${tone}.svg`;
    fs.writeFileSync(path.join(OUT, f), make(c));
    written.push(f);
  }
}
console.log(written.join('\n'));
