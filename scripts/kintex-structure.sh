#!/usr/bin/env bash
# Regenerates src/maps/agf-2026/structure.json from KINTEX's official CAD drawings.
# The Hall 1-5 links on https://www.kintex.com/web/ko/html/facility/exhibition_facility_01.do
# (KINTEX_cad.zip .. KINTEX_cad5.zip) all serve the same archive; it holds the whole
# KINTEX 1 building, so one download covers every hall.
set -euo pipefail
cd "$(dirname "$0")/.."
CACHE=.cache/kintex-cad
mkdir -p "$CACHE"

if [ ! -f "$CACHE/KINTEX_cad.zip" ]; then
  curl -sS -L -o "$CACHE/KINTEX_cad.zip" -w "KINTEX_cad.zip: HTTP %{http_code}, %{size_download} bytes\n" \
    https://www.kintex.com/download/1exhibition/KINTEX_cad.zip
fi

if [ ! -f "$CACHE/A3002-1F.dwg" ]; then
  # Entry names are CP949; pick the 1F plan (A3002 지상1층평면도) by its drawing number.
  python3 - "$CACHE" <<'EOF'
import sys, zipfile
cache = sys.argv[1]
z = zipfile.ZipFile(f"{cache}/KINTEX_cad.zip")
for i in z.infolist():
    name = i.filename.encode("cp437").decode("cp949")
    print("zip entry:", name, i.file_size)
    if name.startswith("A3002"):
        open(f"{cache}/A3002-1F.dwg", "wb").write(z.read(i))
EOF
fi

if [ ! -f "$CACHE/A3002-1F.dxf" ]; then
  # DWG 2004 (AC1018) -> DXF with LibreDWG.
  nix shell nixpkgs#libredwg -c dwg2dxf -y -o "$CACHE/A3002-1F.dxf" "$CACHE/A3002-1F.dwg"
fi

uv run -q --with ezdxf==1.4.5 --with shapely==2.2.0 python scripts/kintex-structure.py
