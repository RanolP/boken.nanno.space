"""Crops map markers (pictograms, printed labels, frame strips) out of an official floor plan.

Usage: python scripts/crop-markers.py scripts/<map>-markers.json   (run via `npm run markers`)

The config lists each icon's crop rect in plan px; map.json places icons with its `markers`.
`knockout` picks which white turns transparent so the icon sits on the 3D floor:
  none  - keep every pixel (the crop is fully painted, e.g. a grey pictogram square)
  edge  - white connected to the crop border (outside a shape; white text inside stays)
  white - every near-white pixel (dark text whose letter counters must not show as white)
Anti-aliased edge pixels are un-mixed against white so edges stay crisp without a halo.
"""
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent
BG_TOL = 12  # max channel distance from white still counted as paper (JPEG noise)
BAND = 3  # px around the knocked-out paper re-blended as anti-aliased edge


def knockout(rgb: np.ndarray, mode: str) -> np.ndarray:
    dist = (255 - rgb).max(axis=2)
    if mode == "none":
        return np.dstack([rgb, np.full(dist.shape, 255)]).astype(np.uint8)
    paper = dist <= BG_TOL
    if mode == "edge":
        labels, _ = ndimage.label(paper)
        border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
        paper = np.isin(labels, border[border > 0])
    elif mode != "white":
        raise SystemExit(f"unknown knockout {mode!r}")
    band = ndimage.binary_dilation(paper, iterations=BAND) & ~paper
    core = ~paper & ~band
    if not core.any():
        raise SystemExit("crop has no solid pixels; check its rect")
    # Each band pixel takes the colour of its nearest solid pixel and an alpha that
    # explains its observed colour as that colour blended over white.
    _, (iy, ix) = ndimage.distance_transform_edt(~core, return_indices=True)
    fg = rgb[iy, ix]
    fg_dist = np.maximum((255 - fg).max(axis=2), 1)
    alpha = np.where(paper, 0.0, np.where(band, np.clip(dist / fg_dist, 0, 1), 1.0))
    out = np.where(band[..., None], fg, rgb)
    return np.dstack([out, np.round(alpha * 255)]).astype(np.uint8)


def main() -> None:
    cfg_path = Path(sys.argv[1])
    cfg = json.loads(cfg_path.read_text())
    cache = ROOT / cfg["cache"]
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading {cfg['plan']}")
        urllib.request.urlretrieve(cfg["plan"], cache)
    plan = np.asarray(Image.open(cache).convert("RGB")).astype(np.int32)
    out_dir = ROOT / cfg["out"]
    out_dir.mkdir(parents=True, exist_ok=True)
    for icon in cfg["icons"]:
        x, y, w, h = icon["crop"]
        if x < 0 or y < 0 or x + w > plan.shape[1] or y + h > plan.shape[0]:
            raise SystemExit(f"{icon['name']}: crop {icon['crop']} outside plan {plan.shape[1]}x{plan.shape[0]}")
        img = Image.fromarray(knockout(plan[y : y + h, x : x + w], icon["knockout"]), "RGBA")
        scale = min(1.0, cfg["maxPx"] / max(w, h))
        if scale < 1:
            img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        path = out_dir / f"{icon['name']}.webp"
        img.save(path, "WEBP", lossless=True, method=6)
        print(f"{path.relative_to(ROOT)}  {img.width}x{img.height}  ({icon['knockout']})")


if __name__ == "__main__":
    main()
