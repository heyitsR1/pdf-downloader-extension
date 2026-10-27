#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "require('./manifest.json').version")
OUTPUT="pdf-downloader-extension-v${VERSION}.zip"

FILES=(
  manifest.json
  background.js
  content.js
  inject.js
  licensing.js
  modal.js
  popup.html
  popup.js
  style.css
  welcome.html
  welcome.css
  welcome.js
  mock-chrome.js
  jszip.min.js
  icon16.png
  icon48.png
  icon128.png
)

rm -f "$OUTPUT"
zip -X "$OUTPUT" "${FILES[@]}"
echo "Packaged: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
