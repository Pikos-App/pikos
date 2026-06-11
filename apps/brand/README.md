# Pikos logo package

Terracotta brand system. Warm-neutral surfaces. Designed for the Pikos Mac app
and its marketing site.

## What's here

```
src/
  pikos-master.svg           # Canonical source — the only SVG everything derives from
  render.py                  # Python renderer (cairosvg + Pillow)

svg/
  pikos-dark.svg             # Mark only, terracotta on transparent — for dark surfaces
  pikos-light.svg            # Mark only, deeper terracotta — for light surfaces
  pikos-symbol.svg           # Mark only, transparent bg — embed on custom surfaces
  pikos-mono.svg             # currentColor mark — for monochrome contexts
  pikos-small.svg            # Thicker strokes — for 16-32px rendering
  pikos-small-mono.svg       # Small-size mono variant

png/                         # Rasterized PNGs at standard sizes
  pikos-{16,32,48,64,128,256,512,1024}.png    # Master (container + mark)
  pikos-light-{64,128,256,512}.png            # Light-mode mark (no container)

macos/
  Pikos.iconset/             # Apple iconset spec — 10 PNGs ready for iconutil
  build-icns.sh              # Run on macOS to produce Pikos.icns

favicon/
  favicon.ico                # Multi-size ICO (16, 32, 48 packed)
  favicon-{16,32,48,180,192,512}.png
  head-snippet.html          # Drop-in <head> tags for the marketing site

contact-sheet.html           # Visual review page — open in a browser
```

## Design tokens

All assets use the Pikos brand system tokens:

| Token                | Value     | Usage                                                   |
|----------------------|-----------|---------------------------------------------------------|
| `--brand-500` (light) | `#a65544` | Mark on light surfaces (deeper terracotta for contrast) |
| `--brand-400` (dark)  | `#c06a58` | Mark on dark surfaces                                   |
| `--neutral-900`       | `#161613` | Squircle container / dark surface ground                |
| `--neutral-50`        | `#f8f8f6` | Light surface ground                                    |

The terracotta values are deliberate — muted, earthy, clearly distinct from the
app's amber semantic color. Do not substitute brighter or redder terracottas.

## Geometry

Single canonical geometry used across all rendering sizes.

- Canvas: 200×200 viewBox, rounded square `rx=44` (22% corner radius)
- Pages: 64×88, stroke-width 5 (or 7 for small-size variant)
- Diagonal offset: 16px x, 12px y per page step
- Total extent: 96×112 (48% width × 56% height) — breathing room around the mark

The same mark proportions scale to every output size — favicon, Dock icon,
marketing site nav. This gives a consistent visual identity at every render
size. All outputs derive from `src/pikos-master.svg`.

The pattern: three rounded-rectangle pages stacked diagonally, with opacity
cascade (0.45 / 0.75 / 1.0) from back to front.

## Usage

### Primary picks

- **Marketing site nav logo** → `svg/pikos-dark.svg` (on dark) or `svg/pikos-light.svg` (on light).
  Both have transparent backgrounds so the site's surface color shows through.
- **macOS app icon** → `macos/Pikos.iconset` + run `build-icns.sh` to produce `Pikos.icns`.
  Wire into `tauri.conf.json`.
- **Favicon** → `favicon/favicon.ico` + accompanying PNGs. Use `favicon/head-snippet.html`
  as a drop-in for the site's `<head>`.
- **Apple touch icon** → `favicon/favicon-180.png`.

### When to use each SVG variant

- `pikos-dark.svg` — **Primary mark.** Terracotta `#c06a58` on whatever dark surface you're
  placing it on. Use on dark backgrounds.
- `pikos-light.svg` — Light-mode variant. Deeper terracotta `#a65544` for contrast on light
  surfaces.
- `pikos-symbol.svg` — Same as pikos-dark but explicitly named for "embed on custom surface"
  contexts (e.g., emails, off-brand presentations).
- `pikos-mono.svg` — Uses `currentColor`, so the ink inherits from the parent element.
  Use for menu bar icons (template images), terminal ASCII, or anywhere you want the mark to
  match the surrounding text color.
- `pikos-small.svg` / `pikos-small-mono.svg` — Same geometry but with bumped stroke widths
  (5→7). Use when rendering at 16–32px so the page outlines don't disappear. Above ~48px,
  prefer the regular variants.

### Menu bar icon (macOS)

The macOS menu bar auto-tints template images to match the system's light/dark appearance.
Use `svg/pikos-mono.svg` rasterized to 32×32 (or appropriate @2x size) and mark it as a
Template image in your resource config. **Do not force terracotta** — it'll clash with the
menu bar's color and violate platform conventions.

## Regenerating

All PNG outputs are derived from the SVG sources by `src/render.py`.

```bash
pip install cairosvg Pillow
python3 src/render.py
```

This regenerates everything under `png/`, `macos/Pikos.iconset/`, and `favicon/`.

After regeneration, on macOS:

```bash
cd macos
./build-icns.sh
```

to produce `Pikos.icns`.

## Usage rules

**Do:**
- Use the warm-neutral container (`#161613`) with the terracotta mark everywhere the mark
  has a background
- Use transparent-background variants (`pikos-dark.svg` / `pikos-light.svg`) when placing
  on the app's or site's own surface color
- Preserve the diagonal offset and opacity cascade — they're load-bearing for "stacked
  pages" legibility

**Don't:**
- Recolor the mark to a different hue — terracotta is the brand identity, not decorative
- Add shadows, gradients, or bevels — the mark is flat by design
- Rotate or skew the mark — horizontal baseline is mandatory
- Place the mark on a terracotta background (brand-adjacent backgrounds kill the contrast).
  Use the light variant or mono variant in those cases.
- Use a brighter terracotta (`#c94a2e`, `#d46e4a`, or similar) — the muted values age better
  and stay clearly distinct from the app's amber attention color

## Terracotta's scope

Terracotta is the Pikos **identity** color. It appears on:

- The app icon (Dock, Launchpad, Spotlight, Alt-Tab)
- The About Pikos window (if added)
- The marketing site's logomark, Download button, and headline accent
- Favicon / Apple touch icon
- OG images (coming separately)

Terracotta **never** appears on functional UI inside the app — not on buttons, not as a
selection color, not as a link color. Inside the running app, teal means "active/link/current,"
amber means "soft attention," red means "urgent." The brand color stays out of those semantic
jobs.

See `pikos-brand-system.md` for the full system documentation.
