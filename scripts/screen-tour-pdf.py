#!/usr/bin/env python3
"""Lay screen tour screenshots out as a review PDF.

    ios-screen-tour-pdf.py <screenshots-dir> <output.pdf> [--subtitle TEXT] [--title TEXT]
        [--layout phone|window] [--not-captured TEXT ...] [--work-dir DIR]

The directory is either what `xcresulttool export attachments` writes (the iOS ScreenTour, read
through its manifest) or plain PNGs named `section|order|title.png` beside `missed*.txt` notes (the
desktop tour). Screenshots are scaled down with `sips` and an HTML page is printed to PDF with
headless Chrome. Nothing here needs Python packages beyond the standard library.
"""

import argparse
import datetime
import html
import json
import re
import subprocess
import sys
from pathlib import Path

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
NAME = re.compile(r"^(?P<section>[^|]+)\|(?P<order>\d+)\|(?P<title>.+?)(?:_\d+_[0-9A-Fa-f-]{36})?(?:\.\w+)?$")

# A landscape window shot three to a page would print its body text at about three points, so
# window shots go two to a portrait page instead.
LAYOUTS = {
    "phone": {
        "per_page": 3,
        "longest_side": 1400,
        "page_size": "11in 8.5in",
        "page_height": "7.55in",
        "row": "flex: 1; display: flex; gap: 0.35in; justify-content: center; align-items: flex-start;",
        "figure": "width: 3.05in;",
        "img": "height: 6.55in; width: auto; max-width: 100%; border-radius: 22px;",
    },
    "window": {
        "per_page": 2,
        "longest_side": 2000,
        "page_size": "8.5in 11in",
        "page_height": "10.05in",
        "row": "flex: 1; display: flex; flex-direction: column; gap: 0.2in; align-items: center;",
        "figure": "width: 7.1in;",
        "img": "width: auto; height: auto; max-width: 7.1in; max-height: 4.44in; border-radius: 8px;",
    },
}

# Surfaces the tour cannot reach from a simulator with the demo workspace, listed so the review
# knows they exist rather than assuming the PDF is exhaustive.
NOT_CAPTURED = [
    "The system's notification permission prompt, and delivered reminder banners with their Complete action",
    "Home and lock screen widgets, the Control Center button, the focus timer's Live Activity, Spotlight results, and Siri and Shortcuts",
    "A connected calendar account: its row, More menu, Change password sheet and sync problem alert (needs a CalDAV server)",
    "Error alerts that need a failure to appear: Something went wrong, Export failed, and the focus timer's notice",
]


def shot(name: str, path: Path):
    match = NAME.match(name)
    if not match:
        return None
    return {"section": match["section"], "order": int(match["order"]), "title": match["title"], "path": path}


def load_shots(source: Path):
    shots, missed = [], []
    manifest = source / "manifest.json"
    if manifest.exists():
        for test in json.loads(manifest.read_text()):
            for item in test.get("attachments", []):
                name = item.get("suggestedHumanReadableName", "")
                path = source / item["exportedFileName"]
                if name.startswith("missed"):
                    missed.extend(line for line in path.read_text().splitlines() if line.strip())
                elif found := shot(name, path):
                    shots.append(found)
    else:
        for note in sorted(source.glob("missed*.txt")):
            missed.extend(line for line in note.read_text().splitlines() if line.strip())
        shots = [found for path in source.glob("*.png") if (found := shot(path.name, path))]
    # By the section's leading number, not its name: past nine, a string sort reads "10" before "2".
    shots.sort(key=lambda s: (section_number(s["section"]), s["section"], s["order"]))
    return shots, missed


def scaled(shot, images: Path, longest_side: int) -> str:
    target = images / f"{shot['section'].split()[0]}-{shot['order']:02d}.jpg"
    subprocess.run(
        ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "82", "-Z", str(longest_side),
         str(shot["path"]), "--out", str(target)],
        check=True, capture_output=True,
    )
    return target.name


def section_number(section: str) -> int:
    head = section.split()[0]
    return int(head) if head.isdigit() else 0


def section_label(section: str) -> str:
    number, _, name = section.partition(" ")
    return f"{number}. {name}"


def build_html(shots, missed, subtitle, images: Path, title: str, doc_title: str, layout, not_captured) -> str:
    sections = []
    for shot in shots:
        if not sections or sections[-1][0] != shot["section"]:
            sections.append((shot["section"], []))
        sections[-1][1].append(shot)

    contents = "".join(
        f"<li><b>{html.escape(section_label(name))}</b> "
        f"<span>{html.escape(', '.join(s['title'] for s in items))}</span></li>"
        for name, items in sections
    )
    gaps = "".join(f"<li>{html.escape(item)}</li>" for item in not_captured)
    missed_block = (
        "<h3>Missed on this run</h3><ul class='gaps'>"
        + "".join(f"<li>{html.escape(m)}</li>" for m in missed)
        + "</ul>"
        if missed
        else ""
    )
    today = datetime.date.today().strftime("%B %-d, %Y")

    per_page = layout["per_page"]
    pages = []
    for name, items in sections:
        for start in range(0, len(items), per_page):
            chunk = items[start:start + per_page]
            figures = "".join(
                f"<figure><img src='images/{scaled(s, images, layout['longest_side'])}'>"
                f"<figcaption><span class='num'>{name.split()[0]}.{s['order']:02d}</span>"
                f"{html.escape(s['title'])}</figcaption></figure>"
                for s in chunk
            )
            heading = html.escape(section_label(name)) + ("" if start == 0 else " <span class='cont'>continued</span>")
            pages.append(f"<section class='page'><h2>{heading}</h2><div class='row'>{figures}</div></section>")

    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(doc_title)}</title>
<style>
@page {{ size: {layout['page_size']}; margin: 0.45in 0.5in; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif; color: #24221f; }}
.page {{ page-break-after: always; height: {layout['page_height']}; display: flex; flex-direction: column; }}
.page:last-child {{ page-break-after: auto; }}
h1 {{ font-size: 30px; font-weight: 650; letter-spacing: -0.4px; margin: 0.6in 0 6px; }}
h2 {{ font-size: 11px; font-weight: 650; letter-spacing: 1.1px; text-transform: uppercase; color: #1f7a6d; margin: 0 0 10px; }}
h2 .cont {{ color: #9a958d; font-weight: 500; letter-spacing: 0.4px; text-transform: none; }}
h3 {{ font-size: 11px; font-weight: 650; letter-spacing: 1.1px; text-transform: uppercase; color: #6f6a62; margin: 22px 0 8px; }}
.sub {{ color: #6f6a62; font-size: 13px; margin: 0 0 4px; }}
.contents {{ list-style: none; padding: 0; margin: 0; columns: 2; column-gap: 0.5in; font-size: 11.5px; line-height: 1.45; }}
.contents li {{ break-inside: avoid; margin-bottom: 10px; }}
.contents b {{ display: block; font-weight: 650; color: #24221f; }}
.contents span {{ color: #6f6a62; }}
.gaps {{ margin: 0; padding-left: 16px; font-size: 11px; line-height: 1.5; color: #4d4943; }}
.row {{ {layout['row']} }}
figure {{ margin: 0; {layout['figure']} display: flex; flex-direction: column; align-items: center; }}
img {{ {layout['img']} border: 1px solid #dedad3; }}
figcaption {{ margin-top: 8px; font-size: 11px; line-height: 1.35; text-align: center; color: #24221f; }}
.num {{ color: #9a958d; font-variant-numeric: tabular-nums; margin-right: 6px; }}
</style></head><body>
<section class="page">
  <h1>{html.escape(title)}</h1>
  <p class="sub">{html.escape(subtitle)}</p>
  <p class="sub">{len(shots)} screenshots · captured {today} · demo workspace</p>
  <h3>Contents</h3><ul class="contents">{contents}</ul>
  <h3>Not in this document</h3><ul class="gaps">{gaps}</ul>
  {missed_block}
</section>
{''.join(pages)}
</body></html>"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("screenshots", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--subtitle", default="")
    parser.add_argument("--title", default="Pikos for iPhone, every screen")
    parser.add_argument("--layout", choices=sorted(LAYOUTS), default="phone")
    parser.add_argument("--not-captured", action="append", dest="not_captured",
                        help="a surface the tour cannot reach; repeat for each (replaces the iOS list)")
    parser.add_argument("--work-dir", type=Path, help="where the scaled images and HTML go (default: beside the PDF)")
    args = parser.parse_args()

    shots, missed = load_shots(args.screenshots)
    if not shots:
        print("no tour screenshots in the export", file=sys.stderr)
        return 1

    work = (args.work_dir or args.output.parent).resolve()
    images = work / "images"
    images.mkdir(parents=True, exist_ok=True)
    page = work / "index.html"
    page.write_text(build_html(shots, missed, args.subtitle, images, args.title, args.output.stem,
                               LAYOUTS[args.layout], args.not_captured or NOT_CAPTURED))

    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
         f"--print-to-pdf={args.output}", page.as_uri()],
        check=True, capture_output=True,
    )
    print(f"{len(shots)} screenshots, {len(missed)} missed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
