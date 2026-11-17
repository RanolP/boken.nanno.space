"""Extracts the KINTEX 1 hall shell (perimeter walls with their openings, Hall 1-5 movable
partitions) from KINTEX's official 1F CAD plan and writes it in AGF 2026 plan px.

Input: .cache/kintex-cad/A3002-1F.dxf (scripts/kintex-structure.sh downloads and converts it).
Output: src/maps/agf-2026/structure.json.

CAD facts this relies on (A3002 지상1층평면도, units mm, Y up):
- layer 4-WALL-MOVE holds the movable hall partitions: four lines across the halls at
  Y = 144430 .. 333430 (63 m apart) and one A/B split line along the halls. Their extent is
  the hall interior: X 293536 (lobby side) .. 463600 (loading-dock side), Y 81830 (Hall 5
  end) .. 396030 (Hall 1 end), i.e. 170.1 x 314.2 m.
- Hall 1 is at high Y (text 전시장1 at Y 366136), Hall 5 at low Y.
An opening is a run along the hall edge where a short probe outward from the hall face
crosses no wall-material geometry.
"""

import json
import math
import sys
from pathlib import Path

import ezdxf

ROOT = Path(__file__).resolve().parent.parent
DXF = ROOT / ".cache/kintex-cad/A3002-1F.dxf"
OUT = ROOT / "src/maps/agf-2026/structure.json"

WALL_LAYERS = {
    "4-WALL", "2-시멘트판넬", "2-블록", "2-벽돌", "4-DRYWALL", "(공통) wall-비내력벽",
    "4-COL", "4-COL-H", "4-내화피복", "2-커튼월", "2-유리", "3-AL판넬", "4-CONC", "2-석고보드", "4-WIN",
}
PROBE_IN, PROBE_OUT = 300.0, 2500.0  # mm behind / beyond the hall face
STEP = 100.0  # mm between probes
MIN_OPENING = 1200.0  # mm; narrower gaps are drafting noise

# AGF 2026 plan anchors (source px of 2_floor_plan_2026.jpg, 15396 x 9075), measured by
# finding the dark restroom pictograms that flank each "Hall N" label on the bottom row:
# label centre = midpoint of its pictogram pair (Hall 5 has one, so left pictogram + mean
# half-gap 609.8 px). Row y = pictogram centre row.
PLAN_HALL_LABELS = {1: 1383.5, 2: 4454.5, 3: 7480.5, 4: 10496.5, 5: 13466.3}
PLAN_LABEL_ROW = 8404.0
# Those pictograms stand for the lobby-side restroom strip; its fixtures (layer 6-변기)
# sit at CAD X 284996 .. 291884.
CAD_RESTROOM_X = 289000.0


def segments(msp):
    def emit(e):
        t = e.dxftype()
        if t == "LINE":
            yield (e.dxf.start.x, e.dxf.start.y, e.dxf.end.x, e.dxf.end.y)
        elif t == "LWPOLYLINE":
            p = [(q[0], q[1]) for q in e.get_points()]
            if e.closed:
                p.append(p[0])
            for a, b in zip(p, p[1:]):
                yield (a[0], a[1], b[0], b[1])
        elif t == "ARC":
            s, en = e.start_point, e.end_point
            yield (s.x, s.y, en.x, en.y)
        elif t == "INSERT":
            try:
                for v in e.virtual_entities():
                    yield from emit(v)
            except Exception as err:  # broken blocks in the drawing; skip with a note
                print(f"skip INSERT {e.dxf.name}: {err}", file=sys.stderr)

    for e in msp:
        if e.dxf.layer in WALL_LAYERS:
            yield from emit(e)


def cross(ax, ay, bx, by, cx, cy, dx, dy):
    def orient(px, py, qx, qy, rx, ry):
        return (qx - px) * (ry - py) - (qy - py) * (rx - px)

    d1 = orient(ax, ay, bx, by, cx, cy)
    d2 = orient(ax, ay, bx, by, dx, dy)
    d3 = orient(cx, cy, dx, dy, ax, ay)
    d4 = orient(cx, cy, dx, dy, bx, by)
    return (d1 * d2 <= 0) and (d3 * d4 <= 0) and not (d1 == d2 == 0)


class Grid:
    CELL = 2000.0

    def __init__(self, segs):
        self.cells = {}
        for s in segs:
            x0, x1 = sorted((s[0], s[2]))
            y0, y1 = sorted((s[1], s[3]))
            for i in range(int(x0 // self.CELL), int(x1 // self.CELL) + 1):
                for j in range(int(y0 // self.CELL), int(y1 // self.CELL) + 1):
                    self.cells.setdefault((i, j), []).append(s)

    def hits(self, ax, ay, bx, by):
        seen = set()
        for i in range(int(min(ax, bx) // self.CELL), int(max(ax, bx) // self.CELL) + 1):
            for j in range(int(min(ay, by) // self.CELL), int(max(ay, by) // self.CELL) + 1):
                for s in self.cells.get((i, j), ()):
                    if id(s) in seen:
                        continue
                    seen.add(id(s))
                    if cross(ax, ay, bx, by, *s):
                        return True
        return False

    def first(self, ax, ay, bx, by):
        """Distance from (ax, ay) to the nearest crossing on the way to (bx, by), or None."""
        dx, dy, best = bx - ax, by - ay, None
        for i in range(int(min(ax, bx) // self.CELL), int(max(ax, bx) // self.CELL) + 1):
            for j in range(int(min(ay, by) // self.CELL), int(max(ay, by) // self.CELL) + 1):
                for x1, y1, x2, y2 in self.cells.get((i, j), ()):
                    ex, ey = x2 - x1, y2 - y1
                    den = dx * ey - dy * ex
                    if den == 0:
                        continue
                    t = ((x1 - ax) * ey - (y1 - ay) * ex) / den
                    u = ((x1 - ax) * dy - (y1 - ay) * dx) / den
                    if 0 <= t <= 1 and 0 <= u <= 1 and (best is None or t < best):
                        best = t
        return None if best is None else best * math.hypot(dx, dy)


# Outline: the partition extent is only the halls' bounding box. A ray cast outward from RAY_IN inside each
# bounding-box face finds the inner wall face; where that sits more than MIN_INSET inside the face, the hall
# is cut back (the service-room notches at the lobby-side corners of Hall 1 and Hall 5, 18 x 9 m each).
RAY_IN = 35000.0
MIN_INSET = 500.0
MIN_RUN = 2000.0  # mm; shorter runs of one depth are door frames, pilasters and rays glancing a corner


def outline(grid, X0, X1, Y0, Y1):
    """Hall floor polygon (shapely, CAD mm): the partition bounding box minus every inward wall offset."""
    from shapely.geometry import box
    from shapely.ops import unary_union

    cuts = []
    for (ax, ay), (bx, by), (nx, ny) in (
        ((X0, Y1), (X0, Y0), (-1, 0)), ((X0, Y0), (X1, Y0), (0, -1)), ((X1, Y0), (X1, Y1), (1, 0)), ((X1, Y1), (X0, Y1), (0, 1)),
    ):
        length = math.hypot(bx - ax, by - ay)
        tx, ty = (bx - ax) / length, (by - ay) / length
        inset = []
        for k in range(int(length // STEP) + 1):
            px, py = ax + tx * k * STEP, ay + ty * k * STEP
            h = grid.first(px - nx * RAY_IN, py - ny * RAY_IN, px + nx * PROBE_OUT, py + ny * PROBE_OUT)
            inset.append(None if h is None else max(0.0, round((RAY_IN - h) / 250) * 250))
        runs = []
        for k, v in enumerate(inset):
            if runs and runs[-1][2] == v:
                runs[-1][1] = k
            else:
                runs.append([k, k, v])
        for k0, k1, v in runs:
            if v is None or v < MIN_INSET or (k1 - k0) * STEP < MIN_RUN:
                continue
            t0, t1 = max(0.0, (k0 - 0.5) * STEP), min(length, (k1 + 0.5) * STEP)
            # A run that stops short of a corner only by glancing hits reaches the corner.
            t0 = 0.0 if t0 < MIN_RUN else t0
            t1 = length if length - t1 < MIN_RUN else t1
            pts = [(ax + tx * t, ay + ty * t) for t in (t0, t1)]
            pts += [(x - nx * v, y - ny * v) for x, y in pts]
            xs, ys = [q[0] for q in pts], [q[1] for q in pts]
            cuts.append([min(xs), min(ys), max(xs), max(ys), nx != 0])
            print(f"outline: inset {v / 1000:.2f} m along {(t1 - t0) / 1000:.1f} m of the face through ({ax:.0f}, {ay:.0f})")
    # A notch is seen from both faces it touches; each face's ray depth is exact (one wall face), its run ends
    # only to the probe STEP, so snap run ends onto the depth lines the other face measured.
    xl = sorted({c[i] for c in cuts if c[4] for i in (0, 2)} - {X0, X1})  # X depth lines, from lobby/dock rays
    yl = sorted({c[i] for c in cuts if not c[4] for i in (1, 3)} - {Y0, Y1})

    def snap(v, lines):
        near = min(lines, key=lambda q: abs(q - v), default=v)
        return near if abs(near - v) < 500 else v

    cuts = [
        box(c[0], snap(c[1], yl), c[2], snap(c[3], yl)) if c[4] else box(snap(c[0], xl), c[1], snap(c[2], xl), c[3])
        for c in cuts
    ]
    poly = box(X0, Y0, X1, Y1).difference(unary_union(cuts)) if cuts else box(X0, Y0, X1, Y1)
    return poly.simplify(1.0)


def fit_similarity(src, dst):
    """Least-squares similarity (rotation, uniform scale, translation) src -> dst, both y-up."""
    n = len(src)
    sx = sum(p[0] for p in src) / n
    sy = sum(p[1] for p in src) / n
    dx = sum(p[0] for p in dst) / n
    dy = sum(p[1] for p in dst) / n
    a = b = den = 0.0
    for (x, y), (u, v) in zip(src, dst):
        x, y, u, v = x - sx, y - sy, u - dx, v - dy
        a += x * u + y * v
        b += x * v - y * u
        den += x * x + y * y
    a, b = a / den, b / den  # u = a x - b y, v = b x + a y
    return lambda x, y: (a * (x - sx) - b * (y - sy) + dx, b * (x - sx) + a * (y - sy) + dy), math.hypot(a, b)


# Interior details: what a visitor sees inside the AGF plan extent besides the hall shell. Within the
# plan image that is the five halls plus the lobby-side service band (CAD X ~283..293.5 k: stairs,
# lifts, restrooms, storage), whose rooms sit between the hall wall and the lobby. Escalators
# (5-ESCALATOR, CAD X 250..261 k) lie 14+ m past the plan's lobby edge, so none are in the extent.
DETAIL_LAYERS = {
    "column": {"4-COL", "4-COL-H", "ST-COL-H", "ST-col", "s-col02", "s-col03", "ST-COL-PIPE", "4-내화피복"},
    "innerWall": {"4-WALL", "4-DRYWALL", "2-시멘트판넬", "(공통) wall-비내력벽", "2-블록", "2-벽돌", "4-CONC", "P_WALL"},
    "stair": {"4-STAIR"},
    "elevator": {"5-ELEVATOR", "4-ELE2", "4-ELE3", "4-ELE4", "4-ELE6"},
    "trench": {"5-트랜치", "5-트렌치", "7-트렌치"},
    "joint": {"2-E.J", "2-ej"},
    "glazing": {"4-창호", "2-유리", "4-WIN", "2-커튼월"},
    "mullion": {"3-멀리온"},
    "hydrant": {"4-소화전"},
    "shutter": {"5-방화삿터", "5-방화샷터"},
    "handrail": {"4-HANDRAIL"},
}
RISER_M = 0.17  # typical riser; the plan gives tread lines only
# 1-TEXT abbreviations and annotations that are not room names.
NOT_ROOM = {"AV", "AD", "PD", "T", "E", "UP", "DN", "E.J"}


def detail_entities(msp, layers):
    """(kind, layer, dxftype, points) for every entity on a detail layer, block references expanded."""
    kind_of = {lay: k for k, ls in DETAIL_LAYERS.items() for lay in ls}

    def pts(e):
        t = e.dxftype()
        if t == "LINE":
            return [(e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)]
        if t == "LWPOLYLINE":
            p = [(q[0], q[1]) for q in e.get_points()]
            return p + [p[0]] if e.closed else p
        if t in ("CIRCLE", "ARC"):
            c, r = e.dxf.center, e.dxf.radius
            return [(c.x - r, c.y - r), (c.x + r, c.y + r)]
        return []

    def walk(e, inherited, depth):
        lay = e.dxf.layer if e.dxf.layer != "0" or inherited is None else inherited
        if e.dxftype() == "INSERT":
            if depth > 4:
                return
            try:
                for v in e.virtual_entities():
                    yield from walk(v, lay, depth + 1)
            except Exception as err:
                print(f"skip INSERT {e.dxf.name}: {err}", file=sys.stderr)
            return
        if lay in kind_of:
            p = pts(e)
            if p:
                yield kind_of[lay], lay, e.dxftype(), p

    for e in msp:
        yield from walk(e, None, 0)


def bbox_of(p):
    xs, ys = [q[0] for q in p], [q[1] for q in p]
    return [min(xs), min(ys), max(xs), max(ys)]


def cluster(boxes, grow):
    """Unions boxes that touch within `grow` mm; returns the merged boxes."""
    parent = list(range(len(boxes)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, a in enumerate(boxes):
        for j in range(i + 1, len(boxes)):
            b = boxes[j]
            if a[0] - grow <= b[2] and b[0] - grow <= a[2] and a[1] - grow <= b[3] and b[1] - grow <= a[3]:
                parent[find(i)] = find(j)
    groups = {}
    for i, b in enumerate(boxes):
        g = groups.setdefault(find(i), [math.inf, math.inf, -math.inf, -math.inf])
        g[0], g[1], g[2], g[3] = min(g[0], b[0]), min(g[1], b[1]), max(g[2], b[2]), max(g[3], b[3])
    return list(groups.values())


def details(msp, px, hall):
    """`hall` is the hall floor polygon (shapely, CAD mm)."""
    from shapely.geometry import Point
    from shapely.prepared import prep

    shrunk = {}
    plan = json.loads((ROOT / "src/maps/agf-2026/map.json").read_text())["source"]
    W, H = plan["widthPx"], plan["heightPx"]

    def in_plan(x, y):
        u, v = px(x, y)
        return 0 <= u <= W and 0 <= v <= H

    def rect(b):
        (u0, v0), (u1, v1) = px(b[0], b[1]), px(b[2], b[3])
        return [min(u0, u1), min(v0, v1), max(u0, u1), max(v0, v1)]

    def in_hall(x, y, margin=500):
        if margin not in shrunk:
            shrunk[margin] = prep(hall.buffer(-margin, join_style="mitre"))
        return shrunk[margin].contains(Point(x, y))

    by_kind = {k: [] for k in DETAIL_LAYERS}
    layer_counts = {}
    for kind, lay, t, p in detail_entities(msp, DETAIL_LAYERS):
        b = bbox_of(p)
        if not in_plan((b[0] + b[2]) / 2, (b[1] + b[3]) / 2):
            continue
        by_kind[kind].append((lay, t, p, b))
        layer_counts[lay] = layer_counts.get(lay, 0) + 1
    print("detail entities in plan extent:", dict(sorted(layer_counts.items(), key=lambda kv: -kv[1])))

    def segs(items, min_len):
        out = []
        for lay, t, p, b in items:
            if t in ("CIRCLE", "ARC"):
                continue
            for a, c in zip(p, p[1:]):
                if math.hypot(c[0] - a[0], c[1] - a[1]) >= min_len:
                    out.append({"a": px(*a), "b": px(*c)})
        return out

    # Columns: steel H sections, their fireproofing and concrete encasing overlap; one box per cluster.
    col_boxes = [b for lay, t, p, b in by_kind["column"] if 250 <= max(b[2] - b[0], b[3] - b[1]) <= 1300]
    round_boxes = [b for lay, t, p, b in by_kind["column"] if t == "CIRCLE"]
    columns = []
    for b in cluster(col_boxes, 50):
        # The halls are column-free; the 8 posts the drawing has on the movable-partition lines
        # (s-col02/s-col03) are not on the AGF plan, so they stay out until confirmed on site.
        if max(b[2] - b[0], b[3] - b[1]) > 1500 or in_hall((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 2000):
            continue
        rnd = any(all(abs(r[i] - b[i]) < 10 for i in range(4)) for r in round_boxes)  # the cluster is just a circle
        columns.append({"r": rect(b), "round": rnd})

    # Walls of the service-band rooms: each drawn face becomes a thin slab; the perimeter is already in `walls`.
    inner = [it for it in by_kind["innerWall"] if not in_hall((it[3][0] + it[3][2]) / 2, (it[3][1] + it[3][3]) / 2, -300)]
    inner_walls = segs(inner, 300)

    # Stairs: tread lines cluster into flights; a flight rises away from the end nearer its UP label.
    labels = [(e.dxf.text, e.dxf.insert.x, e.dxf.insert.y) for e in msp.query('TEXT[layer=="1-TEXT"]') if e.dxf.text in ("UP", "DN")]
    treads = [(p, b) for lay, t, p, b in by_kind["stair"] if t in ("LINE", "LWPOLYLINE") and 800 <= max(b[2] - b[0], b[3] - b[1]) <= 2100 and min(b[2] - b[0], b[3] - b[1]) <= 150]
    stair_steps, stair_rects = [], []
    # A flight is a run of equal-span parallel treads at most 400 mm apart (the two flights of a dog-leg
    # stair are only 150 mm apart side by side, so they are told apart by tread span, not distance).
    flights = {}
    for p, b in treads:
        along_y = (b[2] - b[0]) > (b[3] - b[1])  # a tread drawn along X means the run goes along Y
        span = (round(b[0], -2), round(b[2], -2)) if along_y else (round(b[1], -2), round(b[3], -2))
        flights.setdefault((along_y, span), {})[round((b[1] + b[3]) / 2 if along_y else (b[0] + b[2]) / 2, -1)] = b
    runs = []
    for (along_y, span), at in flights.items():
        cur = []
        for pos in sorted(at):
            if cur and pos - cur[-1][0] > 400:
                runs.append((along_y, cur))
                cur = []
            cur.append((pos, at[pos]))
        runs.append((along_y, cur))
    for along_y, cur in runs:
        if len(cur) < 4:
            continue
        mine = [b for pos, b in cur]
        fb = [min(b[0] for b in mine), min(b[1] for b in mine), max(b[2] for b in mine), max(b[3] for b in mine)]
        stair_rects.append(rect(fb))
        key = (lambda b: (b[1] + b[3]) / 2) if along_y else (lambda b: (b[0] + b[2]) / 2)
        cx, cy = (fb[0] + fb[2]) / 2, (fb[1] + fb[3]) / 2
        near = min(labels, key=lambda lb: math.hypot(lb[1] - cx, lb[2] - cy), default=None)
        if near is None or near[0] != "UP" or math.hypot(near[1] - cx, near[2] - cy) > 4000:
            continue  # down flights (to B1) stay as floor-level tread lines
        start = near[2] if along_y else near[1]
        if abs(key(mine[-1]) - start) < abs(key(mine[0]) - start):
            mine.reverse()
        for i, (a, c) in enumerate(zip(mine, mine[1:])):
            lo, hi = sorted((key(a), key(c)))
            b = [fb[0], lo, fb[2], hi] if along_y else [lo, fb[1], hi, fb[3]]
            stair_steps.append({"r": rect(b), "topM": round((i + 1) * RISER_M, 2)})

    # Lift shafts: car, doors and counterweight of one lift cluster together.
    elevators = [rect(b) for b in cluster([it[3] for it in by_kind["elevator"] if max(it[3][2] - it[3][0], it[3][3] - it[3][1]) <= 4000], 150) if 1200 <= min(b[2] - b[0], b[3] - b[1]) and max(b[2] - b[0], b[3] - b[1]) <= 6000]

    trench_rects, trench_lines = [], []
    for lay, t, p, b in by_kind["trench"]:
        if min(b[2] - b[0], b[3] - b[1]) >= 300 and t == "LWPOLYLINE":
            trench_rects.append(rect(b))
        else:
            trench_lines += segs([(lay, t, p, b)], 1000)
    joints = segs(by_kind["joint"], 1000)

    glazing = segs(by_kind["glazing"], 400)
    mullions = [rect(b) for lay, t, p, b in by_kind["mullion"] if t == "LWPOLYLINE" and max(b[2] - b[0], b[3] - b[1]) <= 400]
    hydrants = [rect(b) for b in cluster([it[3] for it in by_kind["hydrant"]], 50) if 400 <= max(b[2] - b[0], b[3] - b[1]) <= 1500]
    shutters = segs(by_kind["shutter"], 1000)
    handrails = segs(by_kind["handrail"], 500)

    rooms = []
    for e in msp.query('TEXT[layer=="1-TEXT"]'):
        s, p = e.dxf.text.strip(), e.dxf.insert
        if s and s not in NOT_ROOM and in_plan(p.x, p.y) and not s.startswith(("트렌치", "소화전", "(", "φ", "오버헤드", "롤", "방화셔터", "이동칸막이", "지하공동구", "2층", "상부")):
            rooms.append({"at": px(p.x, p.y), "text": s})

    out = {
        "note": "Interior details from the same drawing, clipped to the plan image. Rects are [x0, y0, x1, y1] plan px; heights in m. Room heights above the service band are not in the drawing.",
        "columns": columns,
        "innerWalls": inner_walls,
        "stairs": stair_rects,
        "stairSteps": stair_steps,
        "elevators": elevators,
        "trenches": trench_rects,
        "trenchLines": trench_lines,
        "joints": joints,
        "glazing": glazing,
        "mullions": mullions,
        "hydrants": hydrants,
        "shutters": shutters,
        "handrails": handrails,
        "rooms": rooms,
    }
    print("details:", {k: len(v) for k, v in out.items() if isinstance(v, list)})
    return out


# Hall exits on the lobby face (one bay per hall): what the visitor sees from the hall floor.
# - Each bay is a recess in the hall face. Its back wall (layers 4-DRYWALL / 4-WALL, drawn as two
#   faces 200 mm apart, ~6.3 m behind the face) holds the double doors: its gaps of 1.5 m or more.
# - The bay is flanked by fireproofed steel columns (4-내화피복) standing in the face line. In Halls 2-4
#   they are free-standing and stone clad (2-재료기타 box plus the drywall casing: X face-1450 .. face+100,
#   0.8 m wide); in Halls 1 and 5 the same column sits in the wall beside the bay.
# - The steel box above each bay is drawn on 0-상부입면선 (upper-level outline) as a polygon on the hall
#   side of the face; Hall 5 has none in the drawing.
EXIT_LAYERS = {"4-DRYWALL", "4-WALL", "4-내화피복", "0-상부입면선"}
PILLAR_BACK, PILLAR_FRONT, PILLAR_HALF = 1450.0, 100.0, 400.0  # mm, from the 2-재료기타 + casing extent in Halls 2-4
MIN_DOOR = 1500.0
# Halls whose exit is modelled in road view (src/venue-view/HallExit.tsx MODELLED_HALLS); only these get
# collision walls, so the walker is never stopped by a door it cannot see.
MODELLED_EXIT_HALLS = {1}


def exit_entities(msp):
    def walk(e, inherited, depth):
        lay = e.dxf.layer if e.dxf.layer != "0" or inherited is None else inherited
        t = e.dxftype()
        if t == "INSERT":
            if depth <= 4:
                try:
                    for v in e.virtual_entities():
                        yield from walk(v, lay, depth + 1)
                except Exception:
                    pass
            return
        if lay not in EXIT_LAYERS:
            return
        if t == "LINE":
            yield lay, [(e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)]
        elif t == "LWPOLYLINE":
            yield lay, [(q[0], q[1]) for q in e.get_points()]

    for e in msp:
        yield from walk(e, None, 0)


def exits(msp, px, X0, bays, hall_of):
    """`bays`: (y0, y1) CAD ranges of the lobby-face gaps, one per hall."""
    ents = list(exit_entities(msp))
    out = []
    for y0, y1 in bays:
        # Back wall: the wall-layer lines running along Y inside the bay, 2..8 m behind the face; the face
        # nearest the hall is the X with the most drawn length.
        runs = {}
        for lay, p in ents:
            if lay not in ("4-DRYWALL", "4-WALL"):
                continue
            for (ax, ay), (bx, by) in zip(p, p[1:]):
                if abs(ax - bx) < 1 and X0 - 8000 < ax < X0 - 2000:
                    lo, hi = max(min(ay, by), y0), min(max(ay, by), y1)
                    if hi > lo:
                        runs.setdefault(round(ax), []).append((lo, hi))
        xb = max(runs, key=lambda x: sum(h - l for l, h in runs[x]))
        xb = max(x for x in runs if abs(x - xb) <= 250)  # its hall-side face
        stubs = sorted(runs.get(xb, []) + runs.get(xb - 200, []))
        doors, cur = [], y0
        for lo, hi in stubs:
            if lo - cur >= MIN_DOOR:
                doors.append((cur, lo))
            cur = max(cur, hi)
        if y1 - cur >= MIN_DOOR:
            doors.append((cur, y1))
        pillars = []
        for lay, p in ents:
            if lay != "4-내화피복":
                continue
            b = bbox_of(p)
            cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            if X0 - 800 < cx < X0 and y0 - 1000 < cy < y1 + 1000 and not any(abs(cy - q) < 100 for q in pillars):
                pillars.append(cy)
        canopy = None
        for lay, p in ents:
            if lay == "0-상부입면선" and len(p) >= 4 and min(x for x, _ in p) > X0 - 50:
                ys = [y for _, y in p]
                if min(ys) < y1 and max(ys) > y0:
                    canopy = [px(x, y) for x, y in p]
        out.append({
            "hall": hall_of((y0 + y1) / 2),
            "a": px(X0, y0),
            "b": px(X0, y1),
            "back": {"depthM": round((X0 - xb) / 1000, 2), "thicknessM": 0.2},
            "doors": [{"a": px(xb, lo), "b": px(xb, hi)} for lo, hi in doors],
            "pillars": [
                [min(u0, u1), min(v0, v1), max(u0, u1), max(v0, v1)]
                for (u0, v0), (u1, v1) in (
                    (px(X0 - PILLAR_BACK, cy - PILLAR_HALF), px(X0 + PILLAR_FRONT, cy + PILLAR_HALF)) for cy in sorted(pillars)
                )
            ],
            **({"canopy": canopy} if canopy else {}),
        })
        print(f"exit hall {out[-1]['hall']}: bay Y {y0:.0f}..{y1:.0f}, back X {xb}, doors {[(round(a), round(b)) for a, b in doors]}, pillars {[round(c) for c in pillars]}, canopy {bool(canopy)}")
    return out


def main():
    if not DXF.exists():
        sys.exit(f"missing {DXF}; run scripts/kintex-structure.sh")
    doc = ezdxf.readfile(DXF)
    msp = doc.modelspace()

    moves = []
    for e in msp.query('LWPOLYLINE[layer=="4-WALL-MOVE"]'):
        p = [(q[0], q[1]) for q in e.get_points()]
        moves.append((p[0], p[-1]))
    xs = [c for m in moves for c in (m[0][0], m[1][0])]
    ys = [c for m in moves for c in (m[0][1], m[1][1])]
    X0, X1, Y0, Y1 = min(xs), max(xs), min(ys), max(ys)
    print(f"hall interior X {X0:.0f}..{X1:.0f} ({(X1 - X0) / 1000:.2f} m), Y {Y0:.0f}..{Y1:.0f} ({(Y1 - Y0) / 1000:.2f} m)")
    cuts = sorted({round(m[0][1]) for m in moves if abs(m[0][1] - m[1][1]) < 1})
    print("hall partitions at Y", cuts, "widths m", [round((b - a) / 1000, 2) for a, b in zip([Y0] + cuts, cuts + [Y1])])

    grid = Grid(list(segments(msp)))

    from shapely.geometry import Polygon, box
    from shapely.geometry.polygon import orient

    hall_poly = orient(outline(grid, X0, X1, Y0, Y1), 1.0)
    ring = list(hall_poly.exterior.coords)[:-1]
    # Start the ring at the lobby / Hall 1 corner so the edge order reads like the old rectangle's.
    k = min(range(len(ring)), key=lambda i: ring[i][0] - ring[i][1])
    ring = ring[k:] + ring[:k]
    print("outline vertices (CAD mm):", [(round(x), round(y)) for x, y in ring])

    # Perimeter edges, each with its outward normal (counter-clockwise ring: normal = (ty, -tx)) and a side name
    # by the face it looks out of.
    side_of = {(-1, 0): "lobby", (0, -1): "hall5-end", (1, 0): "dock", (0, 1): "hall1-end"}
    edges = []
    for (ax, ay), (bx, by) in zip(ring, ring[1:] + ring[:1]):
        length = math.hypot(bx - ax, by - ay)
        nx, ny = (by - ay) / length, -(bx - ax) / length
        edges.append((side_of.get((round(nx), round(ny)) if abs(abs(nx) - 1) < 1e-6 or abs(abs(ny) - 1) < 1e-6 else None, "angled"), (ax, ay), (bx, by), (nx, ny)))
    walls, openings = [], []
    for side, (ax, ay), (bx, by), (nx, ny) in edges:
        length = math.hypot(bx - ax, by - ay)
        tx, ty = (bx - ax) / length, (by - ay) / length
        n = int(length // STEP)
        blocked = []
        for k in range(n + 1):
            t = k * STEP
            px, py = ax + tx * t, ay + ty * t
            blocked.append(grid.hits(px - nx * PROBE_IN, py - ny * PROBE_IN, px + nx * PROBE_OUT, py + ny * PROBE_OUT))
        # Runs of free probes become openings; everything else stays wall.
        runs, start = [], None
        for k, b in enumerate(blocked + [True]):
            if not b and start is None:
                start = k
            if b and start is not None:
                t0, t1 = start * STEP, (k - 1) * STEP + STEP
                if t1 - t0 >= MIN_OPENING:
                    runs.append((max(0.0, t0 - STEP / 2), min(length, t1 - STEP / 2)))
                start = None
        cur = 0.0
        for t0, t1 in runs:
            if t0 > cur:
                walls.append((side, cur, t0, (ax, ay), (tx, ty)))
            w = (t1 - t0) / 1000
            kind = "dock" if side == "dock" and w >= 4 else "entrance" if w >= 3 else "door"
            openings.append((side, t0, t1, (ax, ay), (tx, ty), kind))
            cur = t1
        if cur < length:
            walls.append((side, cur, length, (ax, ay), (tx, ty)))
        print(side, "openings (CAD start x,y -> width m):", [
            (round(ax + tx * o[1]), round(ay + ty * o[1]), round((o[2] - o[1]) / 1000, 1)) for o in openings if o[3] == (ax, ay)
        ])

    # CAD -> plan px. Fit in a y-up frame (u, -v) so the result is a proper rotation.
    centers = {1: (cuts[3] + Y1) / 2, 2: (cuts[2] + cuts[3]) / 2, 3: (cuts[1] + cuts[2]) / 2, 4: (cuts[0] + cuts[1]) / 2, 5: (Y0 + cuts[0]) / 2}
    src = [(CAD_RESTROOM_X, centers[h]) for h in range(1, 6)]
    dst = [(PLAN_HALL_LABELS[h], -PLAN_LABEL_ROW) for h in range(1, 6)]
    f, scale = fit_similarity(src, dst)
    m_per_px = 1 / (scale * 1000)
    res = []
    for s, d in zip(src, dst):
        u, v = f(*s)
        res.append(math.hypot(u - d[0], v - d[1]) * m_per_px)
    rms = math.sqrt(sum(r * r for r in res) / len(res))
    print(f"fit: {m_per_px:.5f} m/px, residuals m {[round(r, 2) for r in res]}, rms {rms:.2f} m")

    def px(x, y):
        u, v = f(x, y)
        return [round(u, 1), round(-v, 1)]

    def seg(o, t0, t1):
        (ax, ay), (tx, ty) = o
        return px(ax + tx * t0, ay + ty * t0), px(ax + tx * t1, ay + ty * t1)

    corners = {"lobby-hall1": px(X0, Y1), "lobby-hall5": px(X0, Y0), "dock-hall5": px(X1, Y0), "dock-hall1": px(X1, Y1)}
    print("hall corners in plan px:", corners)

    out = {
        "source": {
            "drawing": "KINTEX A3002 지상1층평면도 (KINTEX_cad.zip)",
            "url": "https://www.kintex.com/download/1exhibition/KINTEX_cad.zip",
        },
        "fit": {
            "method": "least-squares similarity from the 5 hall centres (CAD 4-WALL-MOVE partitions) to the 5 'Hall N' label centres on the plan",
            "metersPerPx": round(m_per_px, 5),
            "residualsM": [round(r, 2) for r in res],
            "rmsM": round(rms, 2),
        },
        "ceilingM": 15,
        "walls": [
            dict(zip(("a", "b"), seg((o, t), t0, t1)), side=side, heightM=15, thicknessM=0.4)
            for side, t0, t1, o, t in walls
        ],
        "openings": [
            {
                **dict(zip(("a", "b"), seg((o, t), t0, t1))),
                "side": side,
                "kind": kind,
                "widthM": round((t1 - t0) / 1000, 1),
                # Dock doors are 5.7 x 6 m (KINTEX organizer manual); other door heights are not in the drawing.
                **({"heightM": 6} if kind == "dock" else {}),
            }
            for side, t0, t1, o, t, kind in openings
        ],
        "partitions": [
            {"a": px(*a), "b": px(*b), "kind": "movable"} for a, b in moves
        ],
        # Hall floor polygons: the outline cut at the cross partitions (Hall 1 at high CAD Y). The A/B split
        # along the halls is a partition inside each hall, not a hall boundary.
        "outline": [px(x, y) for x, y in ring],
        "halls": [
            {"id": f"hall{n}", "polygon": [px(x, y) for x, y in list(orient(hall_poly.intersection(box(X0 - 1, y0, X1 + 1, y1)), 1.0).exterior.coords)[:-1]]}
            for n, (y0, y1) in enumerate(reversed(list(zip([Y0] + cuts, cuts + [Y1]))), start=1)
        ],
    }
    out["details"] = details(msp, px, hall_poly)

    # Hall exits: lobby entrances closer than 1 m (the column stubs between them) form one bay.
    bays = []
    for side, t0, t1, (ax, ay), (tx, ty), kind in openings:
        if side != "lobby" or kind != "entrance":
            continue
        ya, yb = sorted((ay + ty * t0, ay + ty * t1))
        if bays and min(abs(ya - bays[-1][1]), abs(bays[-1][0] - yb)) < 1000:
            bays[-1] = (min(bays[-1][0], ya), max(bays[-1][1], yb))
        else:
            bays.append((ya, yb))
    edges = [Y0] + cuts + [Y1]
    hall_of = lambda y: 5 - next(i for i in range(5) if edges[i] <= y <= edges[i + 1])
    out["exits"] = exits(msp, px, X0, bays, hall_of)
    # The doors are drawn closed and the pillars are solid, so both join `walls` (what the walker collides
    # with); side "exit-door" / "exit-pillar" tells the renderer to draw them as exit parts, not wall.
    half = 0.4 / m_per_px
    hall_x = {int(h["id"][4:]): (min(p[0] for p in h["polygon"]), max(p[0] for p in h["polygon"])) for h in out["halls"]}
    for e in out["exits"]:
        if e["hall"] not in MODELLED_EXIT_HALLS:
            continue
        for d in e["doors"]:
            out["walls"].append({"a": d["a"], "b": d["b"], "side": "exit-door", "heightM": 3, "thicknessM": e["back"]["thicknessM"]})
        for x0, y0, x1, y1 in e["pillars"]:
            cx = round((x0 + x1) / 2, 1)
            out["walls"].append({"a": [cx, round(y0 + half, 1)], "b": [cx, round(y1 - half, 1)], "side": "exit-pillar", "heightM": 6, "thicknessM": 0.8})
    for o in out["openings"]:
        in_modelled = any(hall_x[h][0] <= o["a"][0] <= hall_x[h][1] for h in MODELLED_EXIT_HALLS)
        if o["side"] == "lobby" and o["kind"] == "door" and in_modelled:
            out["walls"].append({"a": o["a"], "b": o["b"], "side": "exit-door", "heightM": 3, "thicknessM": 0.2})
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(out['walls'])} walls, {len(out['openings'])} openings, {len(out['partitions'])} partitions")


if __name__ == "__main__":
    main()
