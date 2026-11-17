"""Projective bake of the KINTEX hall photos onto the road-view surfaces.

For every calibrated photo in scripts/kintex-textures.json this solves a pinhole camera (focal, position,
yaw/pitch/roll in the three.js YXZ convention the road-view rig uses) from hand-marked point and line
correspondences, then bakes one texture per surface (each hall's floor, each hall's ceiling at 15 m, each
outer wall run) at a fixed metres-per-texel: every texel's 3D point is projected through each camera that
can see it and the photo is sampled there. So standing at a solved pose with the solved field of view, the
app shows the photo's content where the photo has it. Texels no photo covers keep a procedural fallback
baked into the same image. Writes public/maps/agf-2026/textures/*.webp + manifest.json.

Run: npm run textures:kintex   (photos are read from .cache/kintex-photos, which stays out of git)
"""

import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
PHOTOS = ROOT / ".cache/kintex-photos"
CORR = ROOT / "scripts/kintex-textures.json"
STRUCT = ROOT / "src/maps/agf-2026/structure.json"
MAP = ROOT / "src/maps/agf-2026/map.json"
OUT = ROOT / "public/maps/agf-2026/textures"

FLOOR_M_PER_TEXEL = 0.08
CEIL_M_PER_TEXEL = 0.12
WALL_M_PER_TEXEL = 0.1
MAX_TEX = 4096
# A photo pixel covering more than this many metres of surface is too coarse to be worth more than the fallback.
MAX_FOOTPRINT_M = 8.0
FEATHER_PX = 40
WEBP_Q = 82


# ---------- camera ----------

def rot(yaw, pitch, roll):
    """Camera-to-world rotation for a three.js Euler(pitch, yaw, roll, 'YXZ')."""
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cr, sr = math.cos(roll), math.sin(roll)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Ry @ Rx @ Rz


def project(p, P, W, H):
    """World points (N,3) -> (u, v, depth) for params P = [f, X, Y, Z, yaw, pitch, roll]. depth > 0 is in front."""
    f, X, Y, Z, yaw, pitch, roll = P
    R = rot(yaw, pitch, roll)
    c = (np.asarray(p, float) - [X, Y, Z]) @ R  # world -> camera (R orthonormal)
    d = -c[..., 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        u = W / 2 + f * c[..., 0] / d
        v = H / 2 - f * c[..., 1] / d
    return u, v, d


def residuals(P, ph, W, H):
    r = []
    for x, y, z, u, v in ph["points"]:
        pu, pv, _ = project([[x, y, z]], P, W, H)
        r += [pu[0] - u, pv[0] - v]
    for ln in ph["lines"]:
        a, b = np.array(ln["a"], float), np.array(ln["b"], float)
        # Sample the 3D line densely and keep the in-front part, so the 2D line is right even if one end is behind.
        t = np.linspace(0, 1, 50)[:, None]
        pu, pv, d = project(a + (b - a) * t, P, W, H)
        ok = d > 0.5
        if ok.sum() < 2:
            r += [1e3] * len(ln["uv"])
            continue
        p0 = np.array([pu[ok][0], pv[ok][0]])
        p1 = np.array([pu[ok][-1], pv[ok][-1]])
        n = np.array([-(p1 - p0)[1], (p1 - p0)[0]])
        n /= np.linalg.norm(n) + 1e-9
        for q in ln["uv"]:
            r.append(float((np.array(q) - p0) @ n))
    return np.array(r)


def solve(ph, W, H, hall_rect):
    hx = (hall_rect[0] + hall_rect[1]) / 2
    yaw0 = ph.get("facing", math.pi)
    z0 = 15.0 if math.cos(yaw0) < 0 else 155.0
    P = np.array([600.0, hx, 1.5, z0, yaw0, 0.0, 0.0])
    f_prior = ph.get("focalPrior", [600.0, 150.0])

    def full(P):
        r = residuals(P, ph, W, H)
        # Weak focal prior: an axial corridor view alone cannot separate focal length from distance (dolly zoom).
        return np.append(r, (P[0] - f_prior[0]) / f_prior[1] * 3.0)

    lam = 1e-2
    r = full(P)
    for _ in range(300):
        J = np.zeros((len(r), len(P)))
        steps = [1.0, 0.01, 0.01, 0.01, 1e-4, 1e-4, 1e-4]
        for i, s in enumerate(steps):
            Q = P.copy()
            Q[i] += s
            J[:, i] = (full(Q) - r) / s
        A = J.T @ J
        g = J.T @ r
        while True:
            dP = -np.linalg.solve(A + lam * np.diag(np.diag(A) + 1e-9), g)
            Pn = P + dP
            rn = full(Pn)
            if rn @ rn < r @ r:
                P, r, lam = Pn, rn, max(lam / 3, 1e-7)
                break
            lam *= 4
            if lam > 1e8:
                break
        if lam > 1e8 or np.abs(dP).max() < 1e-7:
            break
    res = residuals(P, ph, W, H)
    return P, float(np.sqrt(np.mean(res**2)))


# ---------- surfaces ----------

def hall_polys(struct, m):
    """Each hall's CAD floor polygon in metres (x, z), ordered west to east."""
    polys = [np.array(h["polygon"], float) * m for h in struct["halls"]]
    return sorted(polys, key=lambda p: p[:, 0].min())


def halls(struct, m):
    """Each hall's bounding rect (x0, x1, z0, z1) in metres; the polygons themselves come from hall_polys."""
    return [(p[:, 0].min(), p[:, 0].max(), p[:, 1].min(), p[:, 1].max()) for p in hall_polys(struct, m)]


def in_poly(x, z, poly):
    """Vectorised even-odd point-in-polygon for arrays x, z against an (N, 2) ring."""
    inside = np.zeros(np.shape(x), bool)
    for (ax, az), (bx, bz) in zip(poly, np.roll(poly, -1, 0)):
        if az == bz:
            continue
        cross = (z >= min(az, bz)) & (z < max(az, bz))
        xi = ax + (z - az) * (bx - ax) / (bz - az)
        inside ^= cross & (x < xi)
    return inside


def surfaces(struct, m, H_CEIL, plan_wh):
    hs = halls(struct, m)
    polys = hall_polys(struct, m)
    outline = np.array(struct["outline"], float) * m
    # One floor plane for the whole plan (halls + lobby band), so nothing overlaps it: every floor feature is baked in.
    fx0, fx1 = min(0.0, hs[0][0]), max(plan_wh[0], hs[-1][1])
    out = [{"id": "floor", "kind": "floor", "hall": 0, "rect": [fx0, 0.0, fx1, plan_wh[1]], "mpt": FLOOR_M_PER_TEXEL}]
    for i, (x0, x1, z0, z1) in enumerate(hs):
        # rect = the polygon's bounds, so UV = world position over it; the app cuts the mesh to the polygon.
        out.append({"id": f"hall{i + 1}-ceiling", "kind": "ceiling", "hall": i + 1, "rect": [x0, z0, x1, z1], "y": H_CEIL,
                    "polygon": polys[i].round(3).tolist(), "mpt": CEIL_M_PER_TEXEL})
    X0, X1, Z0, Z1 = hs[0][0], hs[-1][1], min(h[2] for h in hs), max(h[3] for h in hs)
    def on_outline(q):
        for a, b in zip(outline, np.roll(outline, -1, 0)):
            d, r = b - a, q - a
            L = np.linalg.norm(d)
            if abs(d[0] * r[1] - d[1] * r[0]) / L < 0.05 and -0.05 <= r @ d / L <= L + 0.05:
                return True
        return False
    # Outer walls as inward faces, one per hall polygon edge on the building outline (partition edges are not walls):
    # u runs along the wall (west to east, or dock to lobby), v up.
    for i, poly in enumerate(polys):
        for a, b in zip(poly, np.roll(poly, -1, 0)):
            if not on_outline((a + b) / 2):
                continue
            a, b = sorted([a.tolist(), b.tolist()])  # x ascending, then z ascending
            if a[1] == b[1]:
                name = "lobby" if abs(a[1] - Z1) < 0.05 else "dock" if abs(a[1] - Z0) < 0.05 else "notch-lobby"
            else:
                name = "end" if min(abs(a[0] - X0), abs(a[0] - X1)) < 0.05 else "notch-end"
            out.append({"id": f"hall{i + 1}-wall-{name}", "kind": "wall", "hall": i + 1, "p0": a, "p1": b, "h": H_CEIL, "mpt": WALL_M_PER_TEXEL})
    return out, hs, polys


def texel_grid(s):
    """World points (h, w, 3) at texel centres, row 0 = texture top (v = 1 in three.js after flipY)."""
    mpt = s["mpt"]
    if s["kind"] in ("floor", "ceiling"):
        x0, z0, x1, z1 = s["rect"]
        w = min(MAX_TEX, round((x1 - x0) / mpt))
        h = min(MAX_TEX, round((z1 - z0) / mpt))
        xs = x0 + (np.arange(w) + 0.5) * (x1 - x0) / w
        zs = z0 + (np.arange(h) + 0.5) * (z1 - z0) / h  # row 0 = z0 (north/dock); the app maps v from the rect
        X, Zg = np.meshgrid(xs, zs)
        Y = np.full_like(X, 0.0 if s["kind"] == "floor" else s["y"])
        normal = np.array([0, 1.0, 0]) if s["kind"] == "floor" else np.array([0, -1.0, 0])
        return np.stack([X, Y, Zg], -1), normal, (w, h)
    p0, p1 = np.array(s["p0"]), np.array(s["p1"])
    L = float(np.linalg.norm(p1 - p0))
    w = min(MAX_TEX, round(L / mpt))
    h = min(MAX_TEX, round(s["h"] / mpt))
    t = (np.arange(w) + 0.5) / w
    ys = s["h"] - (np.arange(h) + 0.5) * s["h"] / h  # row 0 = top
    T, Yg = np.meshgrid(t, ys)
    X = p0[0] + (p1 - p0)[0] * T
    Zg = p0[1] + (p1 - p0)[1] * T
    return np.stack([X, Yg, Zg], -1), None, (w, h)


def wall_normal(s, polys):
    """Inward normal of an outer wall: points into its hall's polygon."""
    p0, p1 = np.array(s["p0"]), np.array(s["p1"])
    d = p1 - p0
    n = np.array([-d[1], d[0]]) / np.linalg.norm(d)
    q = (p0 + p1) / 2 + n * 0.5
    if not in_poly(np.array([q[0]]), np.array([q[1]]), polys[s["hall"] - 1])[0]:
        n = -n
    return np.array([n[0], 0, n[1]])


# ---------- fallback ----------

def fallback(kind, pts, rng):
    """Procedural stand-in for texels no photo covers, drawn in world metres so it lines up across surfaces."""
    h, w = pts.shape[:2]
    noise = cv2.resize(rng.standard_normal((max(2, h // 24), max(2, w // 24))).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
    fine = rng.standard_normal((h, w)).astype(np.float32)
    if kind == "floor":
        base = np.array([172, 170, 164], np.float32)  # BGR, matched to the photos' concrete
        img = base + (noise * 7 + fine * 3)[..., None]
        # 7.5 m saw-cut joints in world metres.
        for axis in (0, 2):
            c = pts[..., axis] / 7.5
            img[np.abs(c - np.round(c)) * 7.5 < 0.02] *= 0.72
        return img
    if kind == "ceiling":
        # Dark deck with faint roof-truss chords every 3 m across the hall (constant x), as in the photos.
        img = np.array([52, 48, 46], np.float32) + (noise * 4)[..., None]
        c = pts[..., 0] / 3.0
        img[np.abs(c - np.round(c)) * 3.0 < 0.08] *= 1.25
        return img
    # Plain wall tone; tone_match carries the photo's banding along the wall.
    return np.array([150, 175, 190], np.float32) + (noise * 3)[..., None]


FLOOR_ALBEDO_SRGB = 172  # epoxy-sealed grey concrete; same base as the floor fallback
DELIGHT_SIGMA_M = 6.0  # wider than any floor marking, narrower than the light pools and exposure falloff


def srgb_to_lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return 255.0 * np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def delight(photo, covered, mpt):
    """Turn the projected photo into albedo for a lit material: in linear light, divide out the low-frequency
    shading (the hall's light pools, camera exposure and vignetting) and rescale to a fixed concrete albedo, so the
    renderer's own lights shade it once. Normalised convolution keeps uncovered texels out of the blur."""
    lin = srgb_to_lin(photo).astype(np.float32)
    lum = (lin @ np.array([0.0722, 0.7152, 0.2126], np.float32))  # BGR Rec.709 luminance
    cw = covered.astype(np.float32)
    sig = DELIGHT_SIGMA_M / mpt
    num = cv2.GaussianBlur(lum * cw, (0, 0), sig)
    den = cv2.GaussianBlur(cw, (0, 0), sig)
    shade = num / np.maximum(den, 1e-6)
    target = srgb_to_lin(np.float32(FLOOR_ALBEDO_SRGB))
    out = lin / np.maximum(shade, 1e-4)[..., None] * target
    return np.where(covered[..., None], lin_to_srgb(out), photo).astype(np.float32)


# ---------- multi-photo blend ----------

SEAM_M = 1.5  # photo -> fallback ramp width on the surface, in metres
TONE_SIGMA_M = 4.0  # neighbourhood the fallback borrows its tone from


def nc_blur(img, wt, sx_px, sy_px=None):
    """Normalised-convolution Gaussian blur (sigma sx along u, sy along v), done on a downsampled copy for speed.
    Returns (mean, support)."""
    sy_px = sx_px if sy_px is None else sy_px
    h, w = wt.shape
    k = max(1, int(min(sx_px, sy_px) / 4))
    small = lambda a: cv2.resize(a, (max(2, w // k), max(2, h // k)), interpolation=cv2.INTER_AREA)
    big = lambda a: cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR)
    num = cv2.GaussianBlur(small((img * wt[..., None]).astype(np.float32)), (0, 0), sx_px / k, sigmaY=sy_px / k)
    den = cv2.GaussianBlur(small(wt.astype(np.float32)), (0, 0), sx_px / k, sigmaY=sy_px / k)
    return big(num / np.maximum(den, 1e-6)[..., None]), big(den)


def tone_match(fb, photo, covered, mpt, kind):
    """Scale the fallback per channel to the photo's local tone near the coverage edge (global median further out),
    so where the photo fades out the fallback carries on at the same brightness and white balance. On a wall the
    neighbourhood is long along the wall and short up it, so horizontal bands (brick base, panels, fascia) run on."""
    g = np.median(photo[covered], 0) / np.maximum(np.median(fb[covered], 0), 1)
    cw = covered.astype(np.float32)
    sx, sy = (TONE_SIGMA_M * 3 / mpt, 0.4 / mpt) if kind == "wall" else (TONE_SIGMA_M / mpt, TONE_SIGMA_M / mpt)
    mp, den = nc_blur(photo, cw, sx, sy)
    mf, _ = nc_blur(fb, cw, sx, sy)
    a = np.clip(den * 4, 0, 1)[..., None]
    return fb * (mp / np.maximum(mf, 1) * a + g[None, None, :] * (1 - a))


def visible_in_hall(pts, cam_xz, poly, eps=0.05):
    """First-hit visibility inside a hall: walls and partitions run floor to ceiling, so a texel is the first hit of
    the camera ray iff the texel (nudged eps toward the camera) is inside the hall polygon and the plan-view segment
    to the camera stays inside it. The polygon is concave only at the notch, so samples along the segment suffice."""
    x, z = pts[..., 0], pts[..., 2]
    dx, dz = cam_xz[0] - x, cam_xz[1] - z
    n = np.maximum(np.hypot(dx, dz), 1e-6)
    ok = in_poly(x + dx / n * eps, z + dz / n * eps, poly)
    for f in np.linspace(0.05, 0.85, 10):  # the stretch nearest the camera is skipped: a camera may stand in a doorway
        ok &= in_poly(x + dx * f, z + dz * f, poly)
    return ok


def project_cams(s, pts, normal, cams, polys):
    """Yield (camera, sampled BGR, weight) for every camera that sees part of surface s."""
    for c in cams:
        # Visibility: the halls are separated by full-height movable partitions in every photo, so a camera sees
        # only its own hall; within it, first hit by visible_in_hall (a camera solved just behind its hall's dock
        # wall, e.g. through a dock door, still sees in).
        if s["hall"] and c["hall"] != s["hall"]:
            continue
        inside = visible_in_hall(pts, (c["P"][1], c["P"][3]), polys[c["hall"] - 1])
        u, v, d = project(pts, c["P"], c["W"], c["H"])
        ok = inside & (d > 0.3) & (u >= 0) & (u < c["W"] - 1) & (v >= 0) & (v < c["H"] - 1)
        if not ok.any():
            continue
        ray = pts - c["P"][1:4]
        dist = np.linalg.norm(ray, axis=-1)
        cosv = np.abs((ray / dist[..., None]) @ normal)
        # Surface metres covered by one photo pixel: distance / f, stretched by obliqueness.
        foot = dist / c["P"][0] / np.maximum(cosv, 0.02)
        ok &= foot < MAX_FOOTPRINT_M
        mu = np.where(ok, u, -1).astype(np.float32)
        mv = np.where(ok, v, -1).astype(np.float32)
        col = cv2.remap(c["img"], mu, mv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        fe = cv2.remap(c["feather"], mu, mv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        # View-dependent weight: favour head-on, finely resolved samples away from the frame and mask edges.
        wgt = np.where(ok, fe * cosv / np.maximum(foot, 1e-3), 0).astype(np.float32)
        yield c, col, wgt


def solve_gains(cams, surfs, polys):
    """Per-photo BGR exposure / white-balance gain from overlaps: least squares on log mean colour differences over
    the texels two photos share (on a 4x coarser grid), each connected group of photos anchored to mean log gain 0."""
    n = len(cams)
    for c in cams:
        c["gain"] = np.ones(3, np.float32)
    rows, rhs, wts = [], [], []
    for s in surfs:
        s2 = dict(s, mpt=s["mpt"] * 4)
        pts, normal, _ = texel_grid(s2)
        if normal is None:
            normal = wall_normal(s, polys)
        samples = [(cams.index(c), col, wgt) for c, col, wgt in project_cams(s2, pts, normal, cams, polys)]
        for a in range(len(samples)):
            for b in range(a + 1, len(samples)):
                (i, ci, wi), (j, cj, wj) = samples[a], samples[b]
                both = (wi > 0) & (wj > 0)
                if both.sum() < 50:
                    continue
                r = np.zeros(n)
                r[i], r[j] = 1, -1  # log g_i - log g_j = log mean_j - log mean_i
                rows.append(r)
                rhs.append(np.log(np.maximum(cj[both], 1)).mean(0) - np.log(np.maximum(ci[both], 1)).mean(0))
                wts.append(math.sqrt(both.sum()))
    adj = {k: {k} for k in range(n)}
    for r in rows:
        i, j = np.flatnonzero(r)
        adj[i].add(j)
        adj[j].add(i)
    seen, anchors = set(), []
    for k in range(n):
        if k in seen:
            continue
        grp, stack = [], [k]
        while stack:
            q = stack.pop()
            if q not in seen:
                seen.add(q)
                grp.append(q)
                stack += list(adj[q])
        a = np.zeros(n)
        a[grp] = 1e3 / len(grp)
        anchors.append(a)
    A = np.vstack([np.array(rows).reshape(-1, n) * np.array(wts).reshape(-1, 1)] + anchors)
    B = np.vstack([np.array(rhs).reshape(-1, 3) * np.array(wts).reshape(-1, 1), np.zeros((len(anchors), 3))])
    logg = np.linalg.lstsq(A, B, rcond=None)[0]
    for c, lg in zip(cams, logg):
        c["gain"] = np.exp(lg).astype(np.float32)
        print(f"{c['id']}: gain BGR {np.round(c['gain'], 3).tolist()}")


# ---------- CAD floor layers ----------

# (albedo BGR, roughness 0-1, metalness 0-1)
STEEL_COVER = ((112, 114, 116), 0.45, 0.9)  # trench checker-plate covers
STEEL_SEAM = ((107, 100, 95), 0.5, 0.5)  # movable-partition floor tracks (Building.tsx roadSeamMat #5f646b)
JOINT = ((70, 72, 74), 0.6, 0.0)  # saw-cut / expansion joints and trench edge lines
EPOXY_ROUGH = 0.8
PARTITION_W_M = 0.3


def floor_features(struct, m, rect, w, h):
    """Rasterise trenches, trench lines, joints and partition seams at true metres into the floor grid.
    Returns (BGRA albedo overlay, ORM image as BGR = (metalness, roughness, occlusion) for three.js B/G/R channels)."""
    x0, z0, x1, z1 = rect
    sx, sz = w / (x1 - x0), h / (z1 - z0)
    to_px = lambda x, z: (int(round((x * m - x0) * sx)), int(round((z * m - z0) * sz)))  # plan px -> texel
    alb = np.zeros((h, w, 4), np.uint8)
    rough = np.full((h, w), int(EPOXY_ROUGH * 255), np.uint8)
    metal = np.zeros((h, w), np.uint8)

    def paint(draw, mat):
        mask = np.zeros((h, w), np.uint8)
        draw(mask)
        on = mask > 0
        alb[on, :3] = mat[0]
        alb[on, 3] = 255
        rough[on] = int(mat[1] * 255)
        metal[on] = int(mat[2] * 255)

    det = struct["details"]
    for p in struct["partitions"]:
        t = max(1, round(PARTITION_W_M * sx))
        paint(lambda k, p=p, t=t: cv2.line(k, to_px(*p["a"]), to_px(*p["b"]), 255, t), STEEL_SEAM)
    for r in det["trenches"]:
        paint(lambda k, r=r: cv2.rectangle(k, to_px(r[0], r[1]), to_px(r[2], r[3]), 255, -1), STEEL_COVER)
    for ln in det["trenchLines"] + det["joints"]:
        paint(lambda k, ln=ln: cv2.line(k, to_px(*ln["a"]), to_px(*ln["b"]), 255, 1), JOINT)
    orm = np.dstack([metal, rough, np.full((h, w), 255, np.uint8)])
    return alb, orm


# ---------- bake ----------

CAMERAS = ROOT / "src/maps/agf-2026/photo-cameras.json"


def write_cameras(corr, cams):
    """Write every solved photo camera to CAMERAS, the durable output (the baked textures are interim; the 3D
    reconstruction uses these to overlay / compare a photo from its own camera). Schema, all metres / radians / px:
      {"note": str, "convention": str, "cameras": [{
        "id": "hall2_slide8",            # photo file .cache/kintex-photos/<id>.jpg (KINTEX copyright, not in git)
        "hall": 2,
        "image": {"w": 1000, "h": 667},   # px of the photo the pose was solved on
        "intrinsics": {"fx": f, "fy": f, "cx": w/2, "cy": h/2, "vfovDeg": ..},  # pinhole, square px, no distortion
        "position": [x, y, z],           # world metres: x east along the plan, y up, z plan-down (dock z=0.45)
        "rotation": {"euler": {"order": "YXZ", "x": pitch, "y": yaw, "z": roll},  # three.js Euler on a camera
                     "quaternion": [x, y, z, w], "matrix": 3x3 camera-to-world, rows},
        "reprojRmsPx": 3.82, "usable": true,   # usable = rms <= 8, the bake's threshold
        "correspondences": {             # what the pose was solved from, as in scripts/kintex-textures.json
          "points": [[X, Y, Z, u, v]], "lines": [{"a": [X,Y,Z], "b": [X,Y,Z], "uv": [[u, v], ...]}],
          "masks": [[[u, v], ...]], "focalPrior": [f, sigma] | null}}]}
    Camera looks down its local -z with +y up (three.js); image v grows downward: u = cx + f*xc/-zc, v = cy - f*yc/-zc.
    """
    by_id = {p["id"]: p for p in corr["photos"]}
    out = []
    for c in cams:
        f, X, Y, Z, yaw, pitch, roll = (float(v) for v in c["P"])
        R = rot(yaw, pitch, roll)
        # Quaternion of R (R is a proper rotation).
        w = math.sqrt(max(0.0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
        qx = math.copysign(math.sqrt(max(0.0, 1 + R[0, 0] - R[1, 1] - R[2, 2])) / 2, R[2, 1] - R[1, 2])
        qy = math.copysign(math.sqrt(max(0.0, 1 - R[0, 0] + R[1, 1] - R[2, 2])) / 2, R[0, 2] - R[2, 0])
        qz = math.copysign(math.sqrt(max(0.0, 1 - R[0, 0] - R[1, 1] + R[2, 2])) / 2, R[1, 0] - R[0, 1])
        ph = by_id[c["id"]]
        out.append({
            "id": c["id"], "hall": c["hall"], "image": {"w": c["W"], "h": c["H"]},
            "intrinsics": {"fx": round(f, 2), "fy": round(f, 2), "cx": c["W"] / 2, "cy": c["H"] / 2,
                           "vfovDeg": round(math.degrees(2 * math.atan(c["H"] / 2 / f)), 3)},
            "position": [round(X, 4), round(Y, 4), round(Z, 4)],
            "rotation": {"euler": {"order": "YXZ", "x": round(pitch, 6), "y": round(yaw, 6), "z": round(roll, 6)},
                         "quaternion": [round(v, 7) for v in (qx, qy, qz, w)],
                         "matrix": np.round(R, 7).tolist()},
            "reprojRmsPx": round(float(c["rms"]), 3), "usable": bool(c["rms"] <= 8),
            "correspondences": {"points": ph.get("points", []), "lines": ph.get("lines", []), "masks": ph.get("masks", []),
                                "focalPrior": ph.get("focalPrior")},
        })
    doc = {"note": "Photo cameras solved by scripts/kintex-textures.py from KINTEX hall photos (Copyright (c) KINTEX "
                   "All rights reserved; images not included). Schema: see write_cameras() in that script.",
           "convention": "three.js world, metres; camera Euler YXZ, looks down local -z; pinhole, no distortion",
           "cameras": out}
    CAMERAS.write_text(json.dumps(doc, indent=1) + "\n")
    print(f"wrote {len(out)} cameras to {CAMERAS.relative_to(ROOT)}")


def main():
    struct = json.loads(STRUCT.read_text())
    m = struct["fit"]["metersPerPx"]
    H_CEIL = struct["ceilingM"]
    corr = json.loads(CORR.read_text())
    plan = json.loads(MAP.read_text())["source"]
    surfs, hs, polys = surfaces(struct, m, H_CEIL, (plan["widthPx"] * m, plan["heightPx"] * m))

    cams = []
    report = {"photos": [], "surfaces": []}
    for ph in corr["photos"]:
        img = cv2.imread(str(PHOTOS / f"{ph['id']}.jpg"))
        if img is None:
            sys.exit(f"missing photo {ph['id']} in {PHOTOS}; download it from KINTEX first")
        H, W = img.shape[:2]
        hall = hs[ph["hall"] - 1]
        P, rms = solve(ph, W, H, hall)
        f, X, Y, Z, yaw, pitch, roll = P
        fov = math.degrees(2 * math.atan(H / 2 / f))
        print(f"{ph['id']}: rms {rms:.2f}px f {f:.0f}px (vfov {fov:.1f} deg) pos ({X:.2f}, {Y:.2f}, {Z:.2f}) yaw {yaw:.4f} pitch {pitch:.4f} roll {roll:.4f}")
        mask = np.ones((H, W), np.uint8)
        for poly in ph.get("masks", []):
            cv2.fillPoly(mask, [np.array(poly, np.int32)], 0)
        # Feather toward the frame edge and mask edges so photos blend without seams.
        feather = cv2.distanceTransform(np.pad(mask, 1), cv2.DIST_L2, 5)[1:-1, 1:-1]
        feather = np.clip(feather / FEATHER_PX, 0, 1).astype(np.float32)
        cam = {"id": ph["id"], "hall": ph["hall"], "P": P, "img": img.astype(np.float32), "feather": feather, "W": W, "H": H, "rms": rms}
        cams.append(cam)
        report["photos"].append({"file": f"{ph['id']}.jpg", "hall": ph["hall"], "usable": rms <= 8, "reproj_rms_px": round(rms, 2),
                                 "pose": {"x": round(X, 3), "y": round(Y, 3), "z": round(Z, 3), "yaw": round(yaw, 5), "pitch": round(pitch, 5), "roll": round(roll, 5), "focalPx": round(f, 1), "vfovDeg": round(fov, 2), "imageW": W, "imageH": H}})
    write_cameras(corr, cams)
    if "--cameras-only" in sys.argv:
        return
    cams = [c for c in cams if c["rms"] <= 8]

    OUT.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(20261118)
    manifest = {"note": "Baked by scripts/kintex-textures.py from KINTEX hall photos (Copyright (c) KINTEX All rights reserved). UV = world position over the surface rect; no tiling.", "surfaces": [], "cameras": report["photos"]}
    solve_gains(cams, surfs, polys)
    for c, r in zip(cams, [p for p in report["photos"] if p["usable"]]):
        r["gainBGR"] = [round(float(g), 3) for g in c["gain"]]
    for s in surfs:
        pts, normal, (w, h) = texel_grid(s)
        if normal is None:
            normal = wall_normal(s, polys)
        acc = np.zeros((h, w, 3), np.float32)
        wsum = np.zeros((h, w), np.float32)
        for c, col, wgt in project_cams(s, pts, normal, cams, polys):
            acc += col * c["gain"][None, None, :] * wgt[..., None]
            wsum += wgt
        covered = wsum > 0
        photo = acc / np.maximum(wsum, 1e-9)[..., None]
        if s["kind"] == "floor" and covered.any():
            photo = delight(photo, covered, s["mpt"])
        fb = fallback(s["kind"], pts, rng)
        if covered.any():
            fb = tone_match(fb, photo, covered, s["mpt"], s["kind"])
        # Blend: the photo eases into the fallback over SEAM_M of surface, measured inward from the coverage edge.
        inside_m = cv2.distanceTransform(np.pad(covered.astype(np.uint8), 1), cv2.DIST_L2, 5)[1:-1, 1:-1] * s["mpt"]
        t = np.clip(inside_m / SEAM_M, 0, 1)
        cov = (t * t * (3 - 2 * t)).astype(np.float32)
        entry = {"id": s["id"], "kind": s["kind"], "file": f"{s['id']}.webp", "metersPerTexel": s["mpt"], "size": [w, h]}
        if s["kind"] == "floor":
            # CAD floor layers at true metres. Albedo: drawn into the fallback only (the photo already shows the real
            # covers and joints); roughness/metalness: everywhere, since the photo cannot say what is steel.
            feat_rgb, orm = floor_features(struct, m, s["rect"], w, h)
            fb = np.where(feat_rgb[..., 3:] > 0, feat_rgb[..., :3], fb)
            orm_path = OUT / "floor-orm.webp"
            cv2.imwrite(str(orm_path), orm, [cv2.IMWRITE_WEBP_QUALITY, 101])  # 101 = lossless
            entry["ormFile"] = orm_path.name
        out = photo * cov[..., None] + fb * (1 - cov[..., None])
        out = np.clip(out, 0, 255).astype(np.uint8)
        path = OUT / f"{s['id']}.webp"
        cv2.imwrite(str(path), out, [cv2.IMWRITE_WEBP_QUALITY, WEBP_Q])
        # Coverage over the texels the app shows: a ceiling's hall polygon, else the whole surface.
        shown = in_poly(pts[..., 0], pts[..., 2], np.array(s["polygon"])) if "polygon" in s else np.ones_like(covered)
        pct = 100 * (covered & shown).sum() / shown.sum()
        kb = path.stat().st_size / 1024
        if s["kind"] == "wall":
            entry.update({"p0": s["p0"], "p1": s["p1"], "height": s["h"]})
        else:
            entry.update({"rect": s["rect"], "y": s.get("y", 0)})
            if "polygon" in s:
                entry["polygon"] = s["polygon"]  # optional: [[x, z], ...] metres; the app cuts the quad to it
        entry["coveragePct"] = round(pct, 2)
        manifest["surfaces"].append(entry)
        report["surfaces"].append({"id": s["id"], "coverage_pct": round(pct, 2), "file": entry["file"], "size_kb": round(kb)})
        print(f"{s['id']}: {w}x{h} coverage {pct:.1f}% {kb:.0f} KB")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    total = sum(p.stat().st_size for p in OUT.glob("*.webp")) / 1e6
    print(f"total {total:.1f} MB")


if __name__ == "__main__":
    main()
