# Authorized PDF Watermark Cleanup Studio v2

A GitHub Pages-ready, browser-only PDF cleanup utility for PDFs you own or are explicitly authorized to modify.

## What changed in v2

- Scans direct page content streams **and nested Form XObjects**.
- Uses a small PDF content tokenizer instead of broad regex replacement.
- Removes only allowlisted watermark/domain signatures.
- Handles `Tj`, `TJ`, `'` and `"` text-show operations.
- Treats mixed-content `TJ` arrays conservatively instead of deleting nearby question text.
- Keeps images and page pixels untouched.
- Runs a second structural verification pass before enabling download.
- Uses PDF.js as an additional page-count/text-content cross-check when available.
- No rasterization, screenshot conversion, or image erasing.

## Important limitation

A watermark that is baked into a scanned page image cannot be safely separated from the underlying questions by this static object-level method. Such pages are intentionally left unchanged rather than risking damage to text, diagrams, or answers.

A separate source-specific image restoration workflow would require testing against that exact PDF family and should never be enabled blindly.

## GitHub Pages

Upload these files to the repository root:

```text
index.html
app.js
styles.css
README.md
404.html
.nojekyll
assets/logo.png
```

Then enable **Settings → Pages → Deploy from a branch → main → /(root)**.

The app uses CDN-hosted `pdf-lib` and PDF.js, so GitHub Pages does not need PHP, Node.js, Python, a database, or an API key.

## Allowlist

Configured signatures currently include:

- `tamilguru.lk`
- `pastpapers.wiki`
- `e-kalvi.com`
- `alevelapi.com`
- `gurupiyasa.guru`

For your own authorized source, add precise signatures in `CONFIG.targets` near the top of `app.js`. Avoid generic words that could appear in normal document text.

## Safety behavior

1. The original `File` object is never modified.
2. The app analyzes before changing anything.
3. Candidate objects are shown in the UI.
4. Only high-confidence allowlisted text objects are eligible.
5. Mixed `TJ` arrays are left alone when removal could affect other text.
6. Images are never pixel-erased.
7. The cleaned file is rescanned.
8. Download is blocked if a signature remains or the page count changes.

## Browser compatibility

Modern Chromium/Chrome, Edge, Firefox and Safari versions are recommended. PDF.js is loaded as an ES module from cdnjs; if it is unavailable, the conservative pdf-lib structural scan still works.

## Authorized use

Use this project only for PDFs you own or have permission to modify. Do not use it to remove attribution or access-control marks from documents without authorization.


### Tested watermark pattern
The detector includes support for PDFs where the visible `More Past Papers at` watermark is stored as a UTF-16BE-style hexadecimal text object (for example, code `0003` is used as a space). The removal is limited to that text object; page images are not raster-erased.

## v3 patch — encoded TamilGuru watermark
The sample 2019 Engineering Technology PDF uses an encoded text watermark object rather than a watermark image. The visible phrase `More Past Papers at` is stored as hexadecimal text with a simple shifted character mapping. v3 recognizes this pattern and removes only the matching text-show operation, leaving the scanned page image, questions, diagrams, and layout untouched.
