#!/usr/bin/env python3
"""Makes booth logos (public/maps/agf-2026/logos/*.webp) transparent and trims them.

Booth signs size a logo by its image box, so every logo ends up tight to its
artwork plus PAD of its longer side.

- Opaque logo on a near-white backdrop: the backdrop is the near-white region
  flood-filled from the image border (scipy.ndimage.label), plus enclosed
  near-white areas with nothing inside them (glyph counters, see counters()),
  so a white disc or plate that holds artwork stays. The 2px ring next to it gets a soft
  alpha from its distance to the sampled backdrop colour, and that colour is
  un-premultiplied out of it so no white halo is left.
- Logo that already has alpha: its alpha is kept; edge pixels lighter than the
  artwork next to them (a white matte) take the artwork's colour. Codes marked fillHoles in LOGO are the
  ones whose source knocks the inner artwork out to transparency while the
  official logo has it white (B01: WEBTOON letters on the green bubble; B09:
  the ANIPLEX letter tiles; C18: the Della Key face; E01: MEGABOX letters on
  the purple tiles); their enclosed transparent holes are composited onto white.
- Fully transparent pixels take the nearest artwork colour (no fringe when the
  texture is filtered).
- Opaque logo on a non-white backdrop: the coloured rectangle is the logo's own
  plate (checked against the official logo), so it is kept as is, except codes
  marked keyPlate in LOGO, whose backdrop is keyed out like a white one.

Originals live in .cache/logos-original/; if fetch-logos.mjs re-wrote a file
(its hash differs from what we last wrote) the new file becomes the original.
Idempotent. Run: npm run logos:bg
"""
import hashlib, json, shutil
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage

root = Path(__file__).resolve().parent.parent
pub = root / "public/maps/agf-2026/logos"
orig = root / ".cache/logos-original"
orig.mkdir(parents=True, exist_ok=True)
state_path = orig / "done.json"
state = json.loads(state_path.read_text()) if state_path.exists() else {}
TOL = 30           # RGB distance from the backdrop colour that counts as backdrop
ALPHA_MIN = 16     # alpha below this does not count as artwork when trimming
PAD = 0.02         # transparent margin around the trimmed artwork, share of the longer side
# Per-logo decisions, each checked against the official logo:
#   fillHoles     source with alpha whose enclosed transparent holes are white artwork
#   keyPlate      opaque non-white backdrop that is not part of the logo; key it out
#   keepEnclosed  opaque logo whose empty enclosed backdrop-coloured areas are artwork, not counters
#   original      only the outer backdrop goes: all enclosed white stays, no speck removal
#   keepEnclosedBox  the same as keepEnclosed, only inside (x0, y0, x1, y1) given as shares of the image
LOGO = {
    "B01": {"fillHoles": True},  # WEBTOON: white letters on the green bubble
    "B09": {"fillHoles": True},  # ANIPLEX: letters on white tiles
    "C18": {"fillHoles": True},  # Della Key: white face inside the outline
    "E01": {"fillHoles": True},  # MEGABOX: white letters on purple tiles
    "A17": {"keyPlate": True},   # NIKKE: white wordmark, the black box is a backdrop
    "A16": {"keepEnclosed": True},  # illustrated title: white in the character art
    "A21": {"keepEnclosed": True},  # illustrated key art: white clothing and highlights
    "A28": {"keepEnclosed": True},  # 미술관에 남자가 너무 많아!: white-filled outlined letters
    "A30": {"keepEnclosed": True},  # WHIF: white letters with a coloured outline
    "C04": {"keepEnclosed": True},  # YNK: white letters on the blue plate
    "E03": {"keepEnclosed": True},  # illustration: white fur and faces
    # 러브 딜리버리 주희 애프터 스토리: white bevels and the script's white outline carry the
    # lettering, and no cleaner official asset exists (STOVE only has composited key art).
    "A31": {"original": True, "tol": 8},  # pale hearts/lettering sit within TOL=30 of white
    "C02": {"keepEnclosedBox": (0, 0, 0.21, 1)},  # the gold SMC badge (left 21%) keeps its white text
    # Counters punched by the default rule, confirmed by the user:
    #   A01 viviON (the O), C02 서울미디어코믹스 (glyph counters; the gold SMC badge
    #   holds text, so it stays), B08 KADOKAWA (navy only, no white).
}


def h(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def fill_holes_white(rgb, al):
    """Composites transparent regions enclosed by the artwork onto white."""
    solid = al > 127
    inside = ndimage.binary_fill_holes(solid)
    holes = inside & ~solid
    # The antialiased rim of each hole too, but not the logo's outer edge.
    band = ndimage.binary_dilation(holes, iterations=2) & inside
    a = al[band, None] / 255
    rgb[band] = rgb[band] * a + 255 * (1 - a)
    al[band] = 255
    return int(holes.sum())


def darken_light_edges(rgb, al):
    """Source alpha whose edge pixels were matted against white shows a light rim
    on dark ground. A partly transparent pixel lighter than the nearest solid
    pixel takes that pixel's colour; its alpha alone carries the coverage."""
    solid = al >= 240
    if not solid.any():
        return
    _, (iy, ix) = ndimage.distance_transform_edt(~solid, return_indices=True)
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    m = (al > 0) & ~solid & (lum > lum[iy, ix] + 10)
    rgb[m] = rgb[iy[m], ix[m]]


def counters(lab, edge_labels, cand):
    """Enclosed backdrop-coloured areas with nothing inside them: the counters of
    glyphs and strokes (the O of viviON), which show the backdrop through the
    logo. An enclosed area that holds artwork of its own (a white disc with
    letters in it, like DAEWON's) is a plate and stays."""
    out = np.zeros(lab.shape, bool)
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        if sl is None or i in edge_labels:
            continue
        comp = lab[sl] == i
        inner = ndimage.binary_fill_holes(comp) & ~comp
        if not (inner & ~cand[sl]).any():
            out[sl] |= comp
    return out


def key_backdrop(rgb, any_colour=False, keep_enclosed=False, drop_specks=True, tol=TOL):
    """Alpha for an opaque logo on a uniform (near-white unless any_colour) backdrop; rgb is decontaminated in place.
    A lower tol keeps pale artwork (near-white fills) opaque and keys only the pure backdrop."""
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bgc = np.median(border, axis=0)
    if (not any_colour and np.linalg.norm(bgc - 255) > TOL) or (np.linalg.norm(border - bgc, axis=1) <= TOL).mean() < 0.3:
        return None
    dist = np.linalg.norm(rgb - bgc, axis=2)
    lab, _ = ndimage.label(dist <= tol)
    edge_labels = np.setdiff1d(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])), [0])
    bg = np.isin(lab, edge_labels)
    if keep_enclosed is not True:
        c = counters(lab, edge_labels, dist <= tol)
        if keep_enclosed:  # (x0, y0, x1, y1) as shares of the image: enclosed areas there stay
            hh, ww = c.shape
            x0, y0, x1, y1 = keep_enclosed
            c[round(y0 * hh):round(y1 * hh), round(x0 * ww):round(x1 * ww)] = False
        bg |= c
    ring = ndimage.binary_dilation(bg, iterations=2) & ~bg
    alpha = np.ones_like(dist)
    alpha[bg] = 0
    # An edge pixel is a mix of the backdrop and the nearest solid ink; its alpha
    # is how far it sits from the backdrop along that line, so a dark ink's
    # half-covered pixels get alpha 0.5 rather than 1 (which left a light fringe).
    _, (iy, ix) = ndimage.distance_transform_edt(bg | ring, return_indices=True)
    reach = np.maximum(np.linalg.norm(rgb[iy, ix] - bgc, axis=2), tol + 1)
    alpha[ring] = np.clip((dist[ring] - tol / 2) / (reach[ring] - tol / 2), 0, 1)
    m = ring & (alpha > 0) & (alpha < 1)
    rgb[m] = np.clip((rgb[m] - bgc * (1 - alpha[m, None])) / alpha[m, None], 0, 255)
    # Stray light specks (JPEG noise near the backdrop colour) left as tiny islands.
    lab2, n2 = ndimage.label(alpha > 0)
    if drop_specks and n2:
        size = ndimage.sum_labels(np.ones_like(dist), lab2, np.arange(1, n2 + 1))
        far = ndimage.maximum(dist, lab2, np.arange(1, n2 + 1))
        speck = np.isin(lab2, 1 + np.nonzero((size <= 12) & (far < 3 * tol))[0])
        alpha[speck] = 0
    return alpha * 255


def trim(rgb, al):
    ys, xs = np.nonzero(al >= ALPHA_MIN)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    pad = max(1, round(PAD * max(y1 - y0, x1 - x0)))
    out = np.zeros((y1 - y0 + 2 * pad, x1 - x0 + 2 * pad, 4), np.float32)
    out[pad:-pad, pad:-pad, :3] = rgb[y0:y1, x0:x1]
    out[pad:-pad, pad:-pad, 3] = al[y0:y1, x0:x1]
    # Transparent pixels take the colour of the nearest artwork pixel, so texture
    # filtering at the edge blends towards the artwork rather than a stray backdrop.
    _, (iy, ix) = ndimage.distance_transform_edt(out[..., 3] < ALPHA_MIN, return_indices=True)
    out[..., :3] = out[iy, ix, :3]
    return out


def process(code, im):
    opt = LOGO.get(code, {})
    a = np.asarray(im.convert("RGBA")).astype(np.float32)
    rgb, al = a[..., :3].copy(), a[..., 3].copy()
    border_al = np.concatenate([al[0], al[-1], al[:, 0], al[:, -1]])
    if (border_al < 250).mean() > 0.5 or (al < 250).mean() > 0.02:
        kind = "had_alpha"
        if opt.get("fillHoles"):
            kind += f"+holes_filled({fill_holes_white(rgb, al)}px)"
        darken_light_edges(rgb, al)
    else:
        keyed = key_backdrop(rgb, opt.get("keyPlate", False), opt.get("keepEnclosed") or opt.get("original") or opt.get("keepEnclosedBox"),
                             not opt.get("original"), opt.get("tol", TOL))
        if keyed is None:
            return "kept_own_plate", None
        al, kind = keyed, "keyed_backdrop"
    res = trim(rgb, al).round().clip(0, 255).astype(np.uint8)
    return kind, Image.fromarray(res, "RGBA")


report = {}
for p in sorted(pub.glob("*.webp")):
    code = p.stem
    o = orig / p.name
    if not o.exists() or state.get(code) != h(p):
        shutil.copy2(p, o)
    kind, img = process(code, Image.open(o))
    if img is None:
        shutil.copy2(o, p)
    else:
        img.save(p, "WEBP", lossless=True, exact=True)
    report.setdefault(kind.split("(")[0], []).append(code)
    state[code] = h(p)
state_path.write_text(json.dumps(state, indent=1))
for k, v in report.items():
    print(f"{k} ({len(v)}): {' '.join(v)}")
