#!/usr/bin/env python3
"""
Render the Pikos logo assets from a single SVG source.

Produces:
- png/                  Standard sizes: 1024, 512, 256, 128, 64, 48, 32, 16
                        Plus light-mode mark variants (transparent bg)
- macos/Pikos.iconset/  Apple iconset spec (10 PNGs: 1x + 2x for 5 sizes)
- favicon/              favicon.ico (multi-size) + PNGs for <head> tags

All outputs derive from src/pikos-master.svg — the same mark proportions
are used everywhere for consistency at every rendering size.

Requires: cairosvg, Pillow
"""

from pathlib import Path
import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
SVG = ROOT / "svg"
PNG = ROOT / "png"
ICONSET = ROOT / "macos" / "Pikos.iconset"
FAVICON = ROOT / "favicon"

for d in (PNG, ICONSET, FAVICON):
    d.mkdir(parents=True, exist_ok=True)


def render(svg_path: Path, out_path: Path, size: int) -> None:
    """Render SVG to PNG at target pixel size."""
    cairosvg.svg2png(
        url=str(svg_path),
        write_to=str(out_path),
        output_width=size,
        output_height=size,
    )
    print(f"  wrote {out_path.relative_to(ROOT)} ({size}×{size})")


MASTER = SRC / "pikos-master.svg"


# ═══════════════════════════════════════════════════════════════════
# 1. Standard PNG sizes (master with squircle container)
# ═══════════════════════════════════════════════════════════════════

print("Rendering PNG sizes (master with container)...")
for size in (1024, 512, 256, 128, 64, 48, 32, 16):
    render(MASTER, PNG / f"pikos-{size}.png", size)

# Light-mode mark (no container — transparent, for light app surfaces)
print("\nRendering light-mode mark sizes (transparent bg)...")
light = SVG / "pikos-light.svg"
for size in (512, 256, 128, 64):
    render(light, PNG / f"pikos-light-{size}.png", size)


# ═══════════════════════════════════════════════════════════════════
# 2. macOS iconset — same master, scaled
# ═══════════════════════════════════════════════════════════════════

print("\nRendering macOS iconset...")
ICONSET_SPECS = [
    ("icon_16x16.png",       16),
    ("icon_16x16@2x.png",    32),
    ("icon_32x32.png",       32),
    ("icon_32x32@2x.png",    64),
    ("icon_128x128.png",    128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png",    256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png",    512),
    ("icon_512x512@2x.png", 1024),
]
for name, size in ICONSET_SPECS:
    render(MASTER, ICONSET / name, size)


# ═══════════════════════════════════════════════════════════════════
# 3. Favicon set
# ═══════════════════════════════════════════════════════════════════

print("\nRendering favicon PNGs...")
FAVICON_SIZES = [16, 32, 48, 180, 192, 512]
for size in FAVICON_SIZES:
    render(MASTER, FAVICON / f"favicon-{size}.png", size)


# ═══════════════════════════════════════════════════════════════════
# 4. favicon.ico — multi-size ICO
# ═══════════════════════════════════════════════════════════════════

print("\nBuilding favicon.ico...")

def build_ico(png_paths: list[Path], out_path: Path) -> None:
    """Pack multiple PNG images into a single .ico file."""
    images = [Image.open(p).convert("RGBA") for p in png_paths]
    images[0].save(
        out_path,
        format="ICO",
        sizes=[(im.width, im.height) for im in images],
        append_images=images[1:] if len(images) > 1 else None,
    )
    print(f"  wrote {out_path.relative_to(ROOT)}")

build_ico(
    [FAVICON / f"favicon-{s}.png" for s in (16, 32, 48)],
    FAVICON / "favicon.ico",
)

print("\nDone.")
