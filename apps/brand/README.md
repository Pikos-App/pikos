# Pikos brand

The Pikos mark and the rules for using it. Everything derives from `src/pikos-master.svg`.

- `src/`: the master SVG and `render.py`, which renders the raster outputs from it.
- `svg/`: the mark on a transparent ground, in the variants below.
- `oauth/`: the consent-screen image. It's committed because it's uploaded to a third party and reviewed there, so the exact bytes stay in the repo.
- `contact-sheet.html`: every variant side by side, for review in a browser.

The PNG, iconset, and favicon outputs aren't tracked. Regenerate them, then copy what an app needs into that app's own asset directory:

```bash
pip install cairosvg Pillow
python3 src/render.py
```

## Colors

| Token           | Value     | Use                                           |
| --------------- | --------- | --------------------------------------------- |
| `--brand-500`   | `#a65544` | Mark on light surfaces (deeper, for contrast) |
| `--brand-400`   | `#c06a58` | Mark on dark surfaces                         |
| `--neutral-900` | `#161613` | Container and dark ground                     |
| `--neutral-50`  | `#f8f8f6` | Light ground                                  |

The terracotta is muted and earthy on purpose, and clearly distinct from the app's amber attention color. Don't substitute a brighter or redder one.

## The mark

Three rounded-rectangle pages stacked diagonally, with opacity 0.45, 0.75, and 1.0 from back to front. The offset and the cascade are what read as "stacked pages", so keep both. The geometry is the same at every size; only stroke width changes (5, or 7 in the small variants).

## Which file

- `pikos-dark.svg`: the primary mark, for dark surfaces.
- `pikos-light.svg`: the deeper terracotta, for light surfaces.
- `pikos-symbol.svg`: the dark mark for custom surfaces such as emails and presentations.
- `pikos-mono.svg`: uses `currentColor`, so it takes the surrounding text color. Use it for template images and anywhere the mark should match the text.
- `pikos-small.svg` and `pikos-small-mono.svg`: heavier strokes for 16 to 32px. Above about 48px, use the regular variants.

The transparent variants go on the app's or site's own surface. Wherever the mark has to carry its own background, use the master with the `#161613` container.

The macOS menu bar tints template images to match the system appearance. Use `pikos-mono.svg` there, never terracotta.

The Google consent screen needs a square image of at least 120 px. Use `oauth/pikos-oauth-120.png`, which has the container, because the mark alone reads as floating debris on the white consent card.

## Don't

- Recolor the mark, or use a brighter terracotta.
- Add shadows, gradients, or bevels. The mark is flat.
- Rotate or skew it.
- Place it on a terracotta background. Use the light or mono variant there.

## Where terracotta appears

Terracotta is the identity color: the app icon, the favicon, and the marketing site's logomark, Download button, and headline accent. It never appears in the app's functional UI, not on buttons, selection, or links. Inside the app, teal means active or current, amber means soft attention, and red means urgent.
