#!/usr/bin/env python3
"""Build a copy of Redline_markup_studio with images or PDFs already loaded.

    python3 embed_images.py --out Redline_markup_studio.html --image a.png --image b.jpg

The result is one self-contained HTML file. Standard library only.
"""
import argparse
import base64
import json
import pathlib
import sys

APP_NAME = "Redline_markup_studio"
PRELOAD_MARK = "<!--REDLINE_MARKUP_STUDIO_PRELOAD-->"
STUDIO_HTML = pathlib.Path(__file__).resolve().parent.parent / "assets" / "Redline_markup_studio.html"
TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jfif": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
         ".bmp": "image/bmp", ".svg": "image/svg+xml", ".avif": "image/avif", ".ico": "image/x-icon", ".tif": "image/tiff", ".tiff": "image/tiff",
         ".heic": "image/heic", ".heif": "image/heif", ".pdf": "application/pdf"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True, help="HTML file to write")
    ap.add_argument("--image", action="append", default=[], help="image or PDF file to preload (repeatable)")
    args = ap.parse_args()

    html = STUDIO_HTML.read_text(encoding="utf-8")
    if PRELOAD_MARK not in html:
        print(f"{APP_NAME}: the studio page is missing its preload marker.", file=sys.stderr)
        return 1

    preload = []
    for item in args.image:
        path = pathlib.Path(item)
        mime = TYPES.get(path.suffix.lower())
        if not mime:
            print(f"{APP_NAME}: {path.name} is not a supported file (png, jpg, gif, webp, bmp, svg, avif, ico, tif, heic, pdf).", file=sys.stderr)
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
