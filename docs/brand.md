# Miu brand: logo, colour, type

How Miu's logo is built and the rules that keep it consistent. Read this before you change the logo, add a variant, or put the logo somewhere new.

Everything lives in [assets/brand/](../assets/brand/):

- the SVG files
- `preview.html`, which shows every variant on light and dark (also served at `/brand` on the dashboard)
- `build/variants.mjs`, which generates the SVGs

## Rules

1. **The dot on the i is always the cat.** Every variant with the letters "miu" puts a small cat head where the dot of the i would be. No plain-dot version exists; one was made and removed on request.
2. **Black and white only.** Logos come in two tones: `#0d0d0d` on light backgrounds and `#ffffff` on dark ones. No brand colour (see [Colour](#colour)).
3. **No fonts in a logo.** Every letter is a drawn path or a set of dots, so the logo looks the same on every machine and needs no font file.
4. **Change only the variant you were asked to change.** The variants share code, so check in `preview.html` that the others did not move.
5. **Never hand-edit a generated SVG.** Change `build/variants.mjs`, run it, and look at the preview.

## The two drawn shapes

Every variant is built from two shapes in `build/variants.mjs`. Change them there and every variant follows.

### The cat (the mark)

The cat is drawn on a 64 × 64 grid as a single solid path (`HEAD`).

- **Head:** a rounded body with two pointed ears. It sits in the box x 8.5–55.5, y 7.5–56.
- **Face:** cut out of the head with an SVG mask (`CUT`), so the face is a gap in the shape rather than a second colour. It works on any background.
  - **Eyes:** two upright rounded bars, 5.2 × 8.6, centred at x 23.5 and x 40.5.
  - **Mouth:** a check mark (✓), the idea behind the brand: Miu checks a claim and confirms it. Stroke 3.4, round ends.

Below about 24 px the face is hard to read. The cat on the i uses the head alone, with no face, for that reason.

### The letters ("miu")

Lowercase monoline letters drawn as strokes (`WORD`), not taken from a font:

- stroke 5, round caps and joins
- baseline at y 46, x-height 18 (the tops of the arches sit at y 20.5)
- **m:** a stem and two arches of radius 7.5
- **i:** one stem
- **u:** an arch of radius 7.5 opening upwards, plus a right stem down to the baseline
- letters start at x 0 and end at x 66

The cat on the i is `HEAD` scaled to 0.22 at `translate(33.5 0.6)` in the letters' coordinates (`iDot`). It is the only place the letters and the cat meet.

## Variants

| File (`-black` / `-white`) | What it is | Built from |
|---|---|---|
| `miu-mark` | The cat alone | `HEAD` + `CUT` |
| `miu-logo` | Cat and "miu" side by side; the letters start at x 82 | mark + letters |
| `miu-logo-big` | Same, with the cat larger: the letters' block (top of the cat on the i to the baseline) is 10/14 of the cat's height, the gap is 3/15 of the cat's width, and the block sits on the cat's middle. These proportions come from the dot logo. | mark scaled + letters |
| `miu-logo-dot` | `miu-logo` followed by a full stop, the same size as the old i-dot | |
| `miu-logo-stacked` | Cat above, "miu" below | |
| `miu-wordmark`, `miu-wordmark-dot` | "miu" and "miu." without the cat | letters |
| `miu-logo-dots` | Cat and "miu" made of dots, with a small dot cat on the i; the letters' block is centred on the cat's 14 rows | dot grid |
| `miu-logo-pixel` | The same grid with every dot filled as a square: a solid pixel logo | dot grid |
| `miu-mark-dots` | The dot cat alone | dot grid |
| `miu-favicon.svg` | The mark, switching between black and white with the browser's light or dark mode (`prefers-color-scheme` inside the SVG) | mark |
| `miu-avatar-512.png` | The black mark centred on white, 512 × 512, for the GitHub App's picture | rendered from `miu-mark-black.svg` |

### The dot grid

The dot and pixel variants are **placed by hand**, not sampled from the drawn shapes. Sampling a curved outline onto a grid left the eyes and the check as ragged holes. Hand placement puts each feature on whole dots.

- **Grid:** step 4, dot radius 1.5. In the code, `X` is a dot.
- **`CAT`:** 15 columns × 14 rows.
  - eyes: 2 × 2 gaps at columns 3–4 and 10–11, rows 5–6
  - check: a one-dot-wide gap across rows 8–10
- **`TEXT`:** 20 columns × 10 rows.
  - a 4 × 3 dot cat over the i
  - one empty row
  - six rows of letters, two dots thick
- **Solid pixel version:** the same arrays, with each `X` drawn as a 4 × 4 square (`cells`, `shape-rendering="crispEdges"`).

The dot logo needs size. At 30 px tall it is clear on a 2× (retina) screen and blurs on a 1× screen. Use the solid mark or `miu-logo-big` below that size.

## Colour

Miu follows the Codex desktop look: black, white and greys, with colour only where it carries a meaning.

| Use | Value |
|---|---|
| Logo on light | `#0d0d0d` |
| Logo on dark | `#ffffff` |
| Dashboard background | `--main #181818`, sidebar `--side #1b1b1b`, raised `--raise #232323` |
| Text | `--ink #ececec`, secondary `--ink2 #c9c9c9`, muted `--muted #9a9a9a` |
| Primary buttons, switches | `--accent #ececec` with `--accent-ink #0d0d0d` (white on dark) |
| Result colours (the only colour) | OK `--ok #6fcf97`, partial `--warn #e8b056`, NOT OK `--bad #f07178`, queued `--run #8fb3ff` |
| A test running | `--running #7559f2` (purple), used only for the running dot and spinner |

The user turned down a purple or blue brand colour. Do not bring one back for the logo or the buttons. The dashboard declares `color-scheme: dark`, so native scrollbars and controls are drawn dark.

## Type

- **Logos:** no typeface; the letters are drawn (see above).
- **Dashboard:** the system UI font, `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", sans-serif` (the `--font` token).
- **Code and ids:** the system monospace font.

There is no web font to load.

## Where the logo is used

| Place | Variant |
|---|---|
| Dashboard sidebar | `miu-logo-big-white`, inlined at 24 px tall (the dot and pixel logos were tried there and set aside) |
| Dashboard, sidebar collapsed | `miu-mark-white` on the show-sidebar button (`MIU_MARK`, mask id `miu-show`); hover or keyboard focus swaps it for the expand icon |
| Dashboard browser tab | `miu-favicon.svg`, inlined as a data URI |
| GitHub App page (`/github-app`) | `miu-logo-big-white` |
| README heading | `miu-logo-big-black` and `-white`, switched by `<picture>` with `prefers-color-scheme` |
| GitHub App picture | `miu-avatar-512.png`, uploaded by hand in the App's settings, because GitHub has no API for it |

An inlined SVG must keep a unique mask id: the sidebar copy renames `g` to `miu-side`.

## Changing the logo

1. Edit `build/variants.mjs`. Shapes are `HEAD`, `CUT` and `WORD`; the dot art is `CAT` and `TEXT`; each variant is an entry in `variants`.
2. Run `node assets/brand/build/variants.mjs`. It rewrites every SVG in `assets/brand/`.
3. Open `assets/brand/preview.html`, or `/brand` on the dashboard. Check light and dark, the size where the logo will be used, and 1× and 2×. Check that the variants you did not mean to change did not move.
4. If the mark changed:
   - rebuild `miu-avatar-512.png` (render `miu-mark-black.svg` at 340 px centred on a 512 px white square)
   - upload it in the GitHub App's settings again
5. If an inlined copy changed (the sidebar, the favicon), update it in `lib/dashboard.html` too. Those copies are not regenerated on their own.
6. Copy the result to whoever asked for it. The user keeps a copy in `~/Downloads/miu-logo`.
