// Record a short flow in a real browser and save it as a GIF, for claims a
// screenshot cannot show (a toggle that saves, a notice that appears, a menu
// that opens). Used by `qa-evidence clip`.
//
//   node clip.mjs <steps.mjs> <out.gif> [WxH] [login-url]
//
// steps.mjs exports `default async ({ page }) => { ... }`. Keep it under
// 20 seconds: the GIF goes into the PR comment, and every second adds weight.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const [steps, out, size = '1280x800', auth] = process.argv.slice(2);
const [width, height] = size.split('x').map(Number);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-clip-'));
// Inside Codex's sandbox (QA_SANDBOXED) Chromium cannot start its own sandbox
// or helper processes, so it runs as one process without them.
const browser = await chromium.launch(process.env.QA_SANDBOXED ? { chromiumSandbox: false, args: ['--single-process', '--no-zygote', '--disable-gpu', '--use-mock-keychain'] } : {});
const context = await browser.newContext({ viewport: { width, height }, recordVideo: { dir: tmp, size: { width, height } }, storageState: process.env.QA_STORAGE_STATE || undefined });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

let error = null;
const limit = setTimeout(() => { error = 'the steps ran longer than 20 seconds'; page.close().catch(() => {}); }, 20000);
try {
  if (auth && /^https?:\/\//.test(auth)) await page.goto(auth, { waitUntil: 'load', timeout: 45000 });
  const run = (await import(pathToFileURL(path.resolve(steps)).href)).default;
  await run({ page });
  await page.waitForTimeout(600); // let the last state show in the GIF
} catch (e) { error ??= String(e.message || e); }
clearTimeout(limit);
const video = page.video();
await context.close();
await browser.close();

let seconds = null;
try {
  const webm = await video.path();
  // Two passes: a palette from the clip, then the GIF with it, 8 fps, 800 px wide.
  const vf = `fps=8,scale=${Math.min(width, 800)}:-1:flags=lanczos`;
  const pal = path.join(tmp, 'pal.png');
  const a = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-vf', `${vf},palettegen=stats_mode=diff`, pal]);
  const b = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-i', pal, '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`, out]);
  if (a.status !== 0 || b.status !== 0) throw new Error(`ffmpeg: ${String(a.stderr || b.stderr).trim().split('\n').pop()}`);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', webm], { encoding: 'utf8' });
  seconds = Number(probe.stdout.trim()) || null;
} catch (e) { error ??= String(e.message || e); }
fs.rmSync(tmp, { recursive: true, force: true });

const bytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
console.log(JSON.stringify({ steps: path.basename(steps), viewport: size, seconds, bytes, consoleErrors, error }, null, 2));
process.exit(error || !bytes ? 1 : 0);
