# Bundled decoders

Third-party libraries the studio loads only when a file needs them. They are unmodified copies from npm.

| File | Package | Used for | Licence |
| --- | --- | --- | --- |
| `pdf.min.js`, `pdf.worker.min.js` | pdfjs-dist 3.11.174 | PDF pages | Apache-2.0 (`LICENSE-pdfjs.txt`) |
| `UTIF.js` | utif 3.1.0 | TIFF images | MIT (`LICENSE-utif.txt`) |
| `pako_inflate.min.js` | pako 2.1.0 | compressed TIFFs | MIT and Zlib (`LICENSE-pako.txt`) |

HEIC/HEIF photos are decoded with heic2any 0.0.4, which is not bundled; the studio fetches it from cdnjs the first time one is opened.
