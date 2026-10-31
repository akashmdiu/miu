// Screenshot a URL with Playwright and print console errors and failed
// requests as JSON. Used by `qa-evidence shot`.
//
//   node shot.mjs <url> <out.png> [WxH] [login-url]
//
// login-url: a one-time sign-in link from rexenv's scratch_login_url. It is
// opened first, so the screenshot is taken signed in to wp-admin. For the Hub,
// set QA_STORAGE_STATE to a Playwright storage-state file instead.
//
// QA_MARKS (JSON, from `qa-evidence shot --mark "<css>|<note>"`) draws a box
// around each element and puts its note next to it, numbered, so the
// screenshot says where to look and why. The first mark is scrolled into view.
import { chromium } from 'playwright';

const [url, out, size = '1280x800', auth] = process.argv.slice(2);
const [width, height] = size.split('x').map(Number);

// Inside Codex's sandbox (QA_SANDBOXED) Chromium cannot start its own sandbox
// or helper processes, so it runs as one process without them.
const browser = await chromium.launch(process.env.QA_SANDBOXED ? { chromiumSandbox: false, args: ['--single-process', '--no-zygote', '--disable-gpu', '--use-mock-keychain'] } : {});
const context = await browser.newContext({
  viewport: { width, height },
  storageState: process.env.QA_STORAGE_STATE || undefined,
});
const page = await context.newPage();
const consoleErrors = [];
const failed = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText} ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

let status = null;
let error = null;
let marks = [];

// Box + numbered note for each mark. Yellow with a dark edge reads on light
// and dark admin screens alike.
async function drawMarks(page, list) {
  if (!list.length) return [];
  return page.evaluate(async (list) => {
    const found = [];
    const layer = document.createElement('div');
    layer.setAttribute('data-qa-marks', '');
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    document.body.appendChild(layer);
    let first = null;
    list.forEach((m, i) => {
      let el = null;
      try { el = document.querySelector(m.selector); } catch { /* bad selector */ }
      if (!el) { found.push({ ...m, n: i + 1, found: false }); return; }
      first ??= el;
      found.push({ ...m, n: i + 1, found: true });
    });
    first?.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((r) => setTimeout(r, 150));
    for (const f of found) {
      if (!f.found) continue;
      const el = document.querySelector(f.selector);
      const r = el.getBoundingClientRect(), x = r.left + scrollX, y = r.top + scrollY, pad = 4;
      const box = document.createElement('div');
      box.style.cssText = `position:absolute;left:${x - pad}px;top:${y - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;border:3px solid #FFC83D;border-radius:8px;box-shadow:0 0 0 2px rgba(0,0,0,.55),0 0 0 9999px rgba(0,0,0,.08)`;
      const tag = document.createElement('div');
      tag.textContent = f.n + (f.note ? '  ' + f.note : '');
      const above = r.top > 34;
      tag.style.cssText = `position:absolute;left:${Math.max(4, x - pad)}px;top:${above ? y - pad - 30 : y + r.height + pad + 6}px;max-width:360px;background:#FFC83D;color:#111;font:600 13px/1.3 -apple-system,system-ui,sans-serif;padding:5px 9px;border-radius:7px;box-shadow:0 2px 8px rgba(0,0,0,.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
      layer.append(box, tag);
      // Keep the note on the page: near the right edge it moves left.
      const maxLeft = scrollX + document.documentElement.clientWidth - tag.offsetWidth - 6;
      if (parseFloat(tag.style.left) > maxLeft) tag.style.left = Math.max(scrollX + 4, maxLeft) + 'px';
    }
    return found;
  }, list);
}
try {
  if (auth && /^https?:\/\//.test(auth)) {
    await page.goto(auth, { waitUntil: 'load', timeout: 45000 });
  }
  const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  status = res?.status() ?? null;
  marks = await drawMarks(page, JSON.parse(process.env.QA_MARKS || '[]'));
  await page.screenshot({ path: out, fullPage: false });
} catch (e) {
  error = String(e.message || e);
}
const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth).catch(() => null);
await browser.close();

console.log(JSON.stringify({ url, status, viewport: size, marks, scrollWidth, overflowX: scrollWidth ? scrollWidth > width : null, consoleErrors, failed, error }, null, 2));
process.exit(error ? 1 : 0);
