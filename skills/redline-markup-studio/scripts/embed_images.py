#!/usr/bin/env python3
"""Build a copy of Redline_markup_studio with images already loaded.

    python3 embed_images.py --out Redline_markup_studio.html --image a.png --image b.jpg

The result is one self-contained HTML file. Standard library only.
"""
import argparse
import base64
import json
import mimetypes
import pathlib
import sys

APP_NAME = "Redline_markup_studio"
PRELOAD_MARK = "<!--REDLINE_MARKUP_STUDIO_PRELOAD-->"
STUDIO_HTML = pathlib.Path(__file__).resolve().parent.parent / "assets" / "Redline_markup_studio.html"
ALLOWED = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/svg+xml", "image/avif"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True, help="HTML file to write")
    ap.add_argument("--image", action="append", default=[], help="image file to preload (repeatable)")
    args = ap.parse_args()

    html = STUDIO_HTML.read_text(encoding="utf-8")
    if PRELOAD_MARK not in html:
        print(f"{APP_NAME}: the studio page is missing its preload marker.", file=sys.stderr)
        return 1

    preload = []
    for item in args.image:
        path = pathlib.Path(item)
        mime = mimetypes.guess_type(path.name)[0] or ""
        if mime not in ALLOWED:
            print(f"{APP_NAME}: {path.name} is not a supported image (png, jpg, gif, webp, bmp, svg, avif).", file=sys.stderr)
            return 1
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        preload.append({"name": path.name, "dataUrl": f"data:{mime};base64,{data}"})

    tag = "<script>window.REDLINE_MARKUP_STUDIO_PRELOAD=" + json.dumps(preload).replace("<", "\\u003c") + ";</script>"
    out = pathlib.Path(args.out)
    out.write_text(html.replace(PRELOAD_MARK, tag), encoding="utf-8")
    print(f"{APP_NAME}: wrote {out.resolve()} with {len(preload)} image(s) preloaded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
