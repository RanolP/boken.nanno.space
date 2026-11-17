#!/usr/bin/env bash
# Regenerates public/fonts/boken-labels.woff: Noto Sans KR Bold subset to the
# glyphs used by every src/maps/*/map.json plus printable ASCII.
# troika (drei <Text>) reads woff/ttf/otf but not woff2.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=.cache/NotoSansKR-Bold.otf
if [ ! -f "$SRC" ]; then
  mkdir -p .cache
  curl -fsSL -o "$SRC" https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/KR/NotoSansKR-Bold.otf
fi
TXT=.cache/label-chars.txt
{ printf '%s' ' !"#$%&'"'"'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}~'
  jq -r '.. | strings' src/maps/*/map.json; } > "$TXT"
uv run --with fonttools --with brotli pyftsubset "$SRC" --text-file="$TXT" \
  --flavor=woff --layout-features='*' --output-file=public/fonts/boken-labels.woff
ls -l public/fonts/boken-labels.woff
