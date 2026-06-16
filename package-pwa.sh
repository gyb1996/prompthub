#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/docs"

rm -rf "$OUT"
mkdir -p "$OUT/icons"

cp "$ROOT/index.html" "$ROOT/styles.css" "$ROOT/app.js" "$OUT/"
cp "$ROOT/manifest.webmanifest" "$ROOT/service-worker.js" "$OUT/"
cp "$ROOT/.nojekyll" "$ROOT/README.md" "$OUT/"
cp "$ROOT/icons/"*.png "$OUT/icons/"

echo "Built GitHub Pages PWA files in:"
echo "  $OUT"
