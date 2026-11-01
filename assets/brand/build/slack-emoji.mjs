// Miu's Slack emoji: the mark on a tile, with its own expressions and a few
// work badges. Every shape is drawn here from the mark's HEAD; nothing comes
// from an emoji font. 128×128 PNGs into assets/brand/slack-emoji/, plus a
// blinking GIF. Needs Playwright's Chromium and ffmpeg.
//
//   node assets/brand/build/slack-emoji.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'slack-emoji');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/\.(png|gif)$/.test(f)) fs.rmSync(path.join(OUT, f));

const HEAD = 'M12.5 26 C11 20 12 13 14.2 8.6 Q15.2 6.6 17.2 7.9 L26 14.6 Q32 12.8 38 14.6 L46.8 7.9 Q48.8 6.6 49.8 8.6 C52 13 53 20 51.5 26 C55 31 55.5 36 54.5 41 C52.5 51.5 43 56 32 56 C21 56 11.5 51.5 9.5 41 C8.5 36 9 31 12.5 26 Z';
// ink is the dashboard's own background (--main in lib/dashboard.html), and
// line its card border, so the emoji sit like a piece of the app.
const C = { ink: '#181818', line: '#2e2e2e', face: '#ececec', ok: '#2f9e5f', warn: '#d08a1e', bad: '#d9474f', run: '#4f7dff', pink: '#f08aa6', blue: '#5aa9ff', red: '#f05a6a', gold: '#f5c242' };
const st = (d, c = 'F', w = 3) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const heart = (x, y, s, fill) => `<path transform="translate(${x} ${y}) scale(${s})" d="M0 3 C-4 -1 -8 1.5 -6.5 5 C-5.5 7.5 -2 9.5 0 11 C2 9.5 5.5 7.5 6.5 5 C8 1.5 4 -1 0 3 Z" fill="${fill}"/>`;

// Face parts, in the logo's own 64-unit space. F is the tile colour, so the
// features read as cut-outs, like the logo.
const eyes = {
  normal: '<rect x="20.9" y="29.6" width="5.2" height="8.6" rx="2.6" fill="F"/><rect x="37.9" y="29.6" width="5.2" height="8.6" rx="2.6" fill="F"/>',
  happy: st('M20.4 35.2 Q23.5 29.8 26.6 35.2') + st('M37.4 35.2 Q40.5 29.8 43.6 35.2'),
  closed: st('M20.4 33 Q23.5 36.4 26.6 33') + st('M37.4 33 Q40.5 36.4 43.6 33'),
  wink: '<rect x="20.9" y="29.6" width="5.2" height="8.6" rx="2.6" fill="F"/>' + st('M37.4 35.2 Q40.5 29.8 43.6 35.2'),
  x: st('M21 31 L26 36 M26 31 L21 36', 'F', 2.8) + st('M38 31 L43 36 M43 31 L38 36', 'F', 2.8),
  wide: '<circle cx="23.5" cy="33.6" r="4" fill="F"/><circle cx="40.5" cy="33.6" r="4" fill="F"/><circle cx="24.6" cy="32.4" r="1.3" fill="#ececec"/><circle cx="41.6" cy="32.4" r="1.3" fill="#ececec"/>',
  side: '<rect x="23" y="29.6" width="5.2" height="8.6" rx="2.6" fill="F"/><rect x="40" y="29.6" width="5.2" height="8.6" rx="2.6" fill="F"/>',
  heart: heart(23.5, 29, 0.62, C.red) + heart(40.5, 29, 0.62, C.red),
  shades: '<rect x="15.5" y="28" width="14.5" height="10" rx="3.4" fill="#0d0d0d"/><rect x="34" y="28" width="14.5" height="10" rx="3.4" fill="#0d0d0d"/><rect x="29" y="30.4" width="6" height="2.6" fill="#0d0d0d"/>' + st('M18.5 31 L22 31', '#ffffff55', 1.6) + st('M37 31 L40.5 31', '#ffffff55', 1.6),
  thinking: '<rect x="20.9" y="31" width="5.2" height="6.4" rx="2.6" fill="F"/>' + st('M37.4 34 L43.6 33', 'F', 3),
};
const mouths = {
  check: st('M26.6 44.4 L30.2 48 L37 41.2', 'F', 3.4),
  smile: '<path d="M25.4 42 Q32 51.5 38.6 42 Z" fill="F" stroke="F" stroke-width="1.6" stroke-linejoin="round"/>',
  grin: st('M26 43.4 Q32 49 38 43.4', 'F', 3.2),
  frown: st('M26.4 47.6 Q32 41.8 37.6 47.6', 'F', 3.2),
  o: '<ellipse cx="32" cy="45.6" rx="3.2" ry="3.9" fill="F"/>',
  small: '<ellipse cx="32" cy="45" rx="2" ry="1.6" fill="F"/>',
  flat: st('M27.4 45.4 L36.6 44.2', 'F', 3),
  smirk: st('M26.8 45.2 Q33 47.8 38.2 42.8', 'F', 3),
  wavy: st('M25.6 46 Q28.2 43.4 30.8 46 Q33.4 48.6 36 46 Q37.4 44.6 38.6 45', 'F', 2.8),
};
const extras = {
  brows: st('M18.6 25.2 L27 28.8', 'F', 2.8) + st('M45.4 25.2 L37 28.8', 'F', 2.8),
  cheeks: `<ellipse cx="17.2" cy="41.4" rx="3.6" ry="2.3" fill="${C.pink}"/><ellipse cx="46.8" cy="41.4" rx="3.6" ry="2.3" fill="${C.pink}"/>`,
  tear: `<path d="M19.6 38.6 Q17.6 42.4 19.6 44 Q21.6 42.4 19.6 38.6 Z" fill="${C.blue}"/>`,
  tears: `<path d="M21 36.5 L21 50" stroke="${C.blue}" stroke-width="2.6" stroke-linecap="round"/><path d="M43 36.5 L43 50" stroke="${C.blue}" stroke-width="2.6" stroke-linecap="round"/>`,
  sweat: `<path d="M49 18 Q46 23 49 25.5 Q52 23 49 18 Z" fill="${C.blue}"/>`,
};
// Things on the tile, outside the face (tile space, 0..64).
const badge = (bg, inner) => `<circle cx="51" cy="51" r="11.5" fill="${bg}" stroke="#181818" stroke-width="2.2"/>${inner}`;
const txt = (x, y, s, t, fill = '#fff') => `<text x="${x}" y="${y}" font-family="Helvetica Neue, Helvetica, Arial" font-weight="800" font-size="${s}" text-anchor="middle" fill="${fill}">${t}</text>`;
const banner = (bg, t) => `<rect x="3" y="45" width="58" height="15" rx="5" fill="${bg}" stroke="#181818" stroke-width="2"/>${txt(32, 56.6, 11, t)}`;
const props = {
  question: badge(C.run, txt(51, 56.2, 15, '?')),
  zzz: txt(50, 18, 11, 'z', '#fff') + txt(56.5, 10, 8, 'z', '#fff'),
  fire: badge('#ff7a1a', `<path d="M51 42 C55 46 57 49 56 53 C55 57 47 58 46 53 C45.4 50 47.5 48.8 48 46.6 C49.2 48.6 50 49 50.6 48.6 C51.6 47 51.2 44.4 51 42 Z" fill="#ffd34d"/>`),
  coffee: badge('#7a4a2a', `<rect x="44.5" y="46" width="11" height="10" rx="2" fill="#fff"/><path d="M55.5 48 Q59.5 48 59 51.5 Q58.5 54 55.5 54" fill="none" stroke="#fff" stroke-width="1.8"/>` + st('M47.5 42.5 Q48.8 44 47.5 45 M51.5 42.5 Q52.8 44 51.5 45', '#fff', 1.4)),
  plus1: badge(C.ok, txt(51, 55.8, 12, '+1')),
  bug: badge(C.bad, `<ellipse cx="51" cy="52" rx="4.6" ry="5.6" fill="#171717"/><circle cx="51" cy="45.8" r="2.6" fill="#171717"/>` + st('M45 49 L47 50.4 M45 54 L46.6 53.4 M57 49 L55 50.4 M57 54 L55.4 53.4', '#171717', 1.6)),
  eyes: '',
  party: `<polygon points="21,13 35,13 26,-1" fill="${C.gold}" stroke="#181818" stroke-width="1.6" transform="rotate(-14 28 8)"/>` + `<circle cx="25.2" cy="-1.6" r="2.6" fill="${C.red}" transform="rotate(-14 28 8)"/>` + `<rect x="47" y="6" width="3" height="5" fill="${C.red}" transform="rotate(30 48 8)"/><rect x="54" y="16" width="3" height="5" fill="${C.blue}" transform="rotate(-20 55 18)"/><rect x="7" y="20" width="3" height="5" fill="${C.ok}" transform="rotate(20 8 22)"/><circle cx="57" cy="8" r="1.6" fill="${C.gold}"/>`,
  lgtm: banner(C.ok, 'LGTM'),
  ship: banner(C.run, 'SHIP IT'),
  onit: banner(C.ink, 'ON IT'),
  qa: banner(C.warn, 'QA'),
};

const SET = [
  // name, tile, eyes, mouth, extras, props
  ['miu', C.ink, 'normal', 'check'],
  ['miu-happy', C.ink, 'happy', 'smile'],
  ['miu-love', C.ink, 'heart', 'smile'],
  ['miu-wink', C.ink, 'wink', 'check'],
  ['miu-cool', C.ink, 'shades', 'smirk'],
  ['miu-blush', C.ink, 'happy', 'grin', ['cheeks']],
  ['miu-sad', C.ink, 'normal', 'frown', ['tear']],
  ['miu-cry', C.ink, 'closed', 'frown', ['tears']],
  ['miu-angry', C.bad, 'normal', 'frown', ['brows']],
  ['miu-shock', C.ink, 'wide', 'o'],
  ['miu-nervous', C.ink, 'normal', 'wavy', ['sweat']],
  ['miu-thinking', C.ink, 'thinking', 'flat', [], 'question'],
  ['miu-sleepy', C.ink, 'closed', 'small', [], 'zzz'],
  ['miu-eyes', C.ink, 'side', 'flat'],
  ['miu-party', C.ink, 'happy', 'smile', [], 'party'],
  ['miu-dead', C.ink, 'x', 'o'],
  ['miu-lgtm', C.ink, 'happy', 'check', [], 'lgtm'],
  ['miu-ship-it', C.ink, 'shades', 'smirk', [], 'ship'],
  ['miu-on-it', C.ink, 'normal', 'flat', [], 'onit'],
  ['miu-qa', C.ink, 'normal', 'check', [], 'qa'],
  ['miu-bug', C.ink, 'wide', 'o', [], 'bug'],
  ['miu-fire', C.ink, 'happy', 'grin', [], 'fire'],
  ['miu-coffee', C.ink, 'closed', 'grin', [], 'coffee'],
  ['miu-plus1', C.ink, 'happy', 'check', [], 'plus1'],
  ['miu-ok', C.ok, 'normal', 'check'],
  ['miu-partial', C.warn, 'normal', 'flat'],
  ['miu-notok', C.bad, 'x', 'frown'],
  ['miu-running', C.run, 'side', 'check'],
  ['miu-light', C.face, 'normal', 'check'],
];

const svg = (tile, e, m, ex = [], prop) => {
  const face = tile === C.face ? '#171717' : '#ececec';
  const F = tile === C.face ? C.face : tile;
  const parts = [eyes[e], mouths[m], ...ex.map((k) => extras[k])].join('').replaceAll('"F"', `"${F}"`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="128" height="128">
<rect x="0.5" y="0.5" width="63" height="63" rx="14" fill="${tile}"${tile === C.ink ? ` stroke="${C.line}" stroke-width="1.2"` : ''}/>
<g transform="translate(5 ${prop && ['lgtm', 'ship', 'onit', 'qa'].includes(prop) ? 1.5 : 4.5}) scale(0.845)"><path d="${HEAD}" fill="${face}"/>${parts}</g>
${prop ? props[prop] : ''}</svg>`;
};

const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 128, height: 128 } });
const shoot = async (s, file) => { await p.setContent(`<body style="margin:0;background:transparent">${s}</body>`); await p.waitForTimeout(60); await p.screenshot({ path: file, omitBackground: true }); };
for (const [name, tile, e, m, ex, prop] of SET) await shoot(svg(tile, e, m, ex, prop), path.join(OUT, name + '.png'));
// miu-blink: open, open, closed, open; a loop of 2 seconds.
const fr = path.join(OUT, '.frames'); fs.mkdirSync(fr);
const seq = [...Array(16).fill('normal'), 'closed', 'closed', ...Array(6).fill('normal')];
for (const [i, e] of seq.entries()) await shoot(svg(C.ink, e, 'check'), path.join(fr, `${String(i).padStart(3, '0')}.png`));
await b.close();
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', '12', '-i', path.join(fr, '%03d.png'), '-vf', 'split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse', '-loop', '0', path.join(OUT, 'miu-blink.gif')]);
fs.rmSync(fr, { recursive: true });
console.log(fs.readdirSync(OUT).filter((f) => /\.(png|gif)$/.test(f)).length, 'emoji in', OUT);
