"""Generate examples/example_property.json from known 'true' coordinates.

Readings are what a 20" transit would give: true angle + noise, rounded to 20".
Only sight lines that clear the house and shed are booked. Four landmarks get
a phone-grade latitude/longitude (1.5 m noise) of a made-up placement in
Central Park's Sheep Meadow, with grid north GRID_AZ off true north.
Run with --truth to also print the true coordinates and georeference
(used by tools/check.py).
"""
import json
import math
import pathlib
import random
import sys

random.seed(7)
TRUE = {
    # landmarks (E, N, description)
    "A": (5000.00, 5000.00, "1/2\" rebar with yellow cap, 2 ft E of driveway apron, NW corner"),
    "B": (5142.37, 5008.12, "1/2\" rebar with yellow cap at NE fence corner post"),
    "C": (5155.80, 4891.45, "Chiseled X on concrete pad of shed, NE corner"),
    "D": (4991.30, 4878.60, "1/2\" rebar with yellow cap, SW corner by garden"),
    "M": (5096.40, 4979.10, "16d nail in top of deck post, NW post of rear deck"),
    # points of interest (E, N, type, depth, description)
    "W1": (5012.40, 5003.80, "water", "42 in", "Water meter box at street"),
    "W2": (5048.15, 4985.30, "water", "42 in", "Water line bend (45 deg)"),
    "W3": (5061.90, 4952.75, "water", "36 in", "Water line tee to hose bib"),
    "W4": (5068.40, 4931.20, "water", "36 in", "Water entry at house foundation, SW corner"),
    "E1": (5128.90, 4996.50, "elec", "30 in", "Transformer pedestal"),
    "E2": (5121.00, 4958.00, "elec", "24 in", "Conduit bend"),
    "E3": (5106.70, 4944.00, "elec", "24 in", "House meter base on east wall, conduit up"),
    "ST": (5040.70, 4905.25, "sewer", "18 in to lid", "Septic tank inlet lid"),
    "DB": (5021.35, 4889.90, "sewer", "20 in", "Septic distribution box"),
    "WELL": (5118.60, 4910.30, "water", "", "Well head (casing)"),
    "LP": (5137.10, 4945.80, "gas", "", "Propane tank fill valve"),
}
STATIONS = [("A", "B"), ("B", "A"), ("C", "B"), ("D", "A"), ("M", "A")]   # (station, backsight)
HOUSE = [(5070.0, 4932.0), (5106.0, 4932.0), (5106.0, 4962.0), (5070.0, 4962.0)]
SHED = [(5140.0, 4880.0), (5152.0, 4880.0), (5152.0, 4889.0), (5140.0, 4889.0)]
DECK = ["M", (5110.0, 4979.1), (5110.0, 4962.0), (5096.4, 4962.0)]    # low: doesn't block
BLOCKING = [HOUSE, SHED]
LAT0, LON0 = 40.772790, -73.975520     # where LM-A is (made up)
GRID_AZ = -3.5                         # true azimuth of grid north, degrees
GPS_SIGMA = 1.5                        # metres per axis


def blocked(a, b, tol=0.25):
    """Does the sight line a-b pass through a building (same rule as the app)?"""
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy)
    for poly in BLOCKING:
        for i in range(len(poly)):
            c, d = poly[i], poly[(i + 1) % len(poly)]
            ex, ey = d[0] - c[0], d[1] - c[1]
            den = dx * ey - dy * ex
            if abs(den) < 1e-12:
                continue
            cx, cy = c[0] - a[0], c[1] - a[1]
            t, u = (cx * ey - cy * ex) / den, (cx * dy - cy * dx) / den
            if tol / L < t < 1 - tol / L and 0 <= u <= 1:
                return True
    return False


def latlon(k):
    """Phone-grade lat/lon of point k: grid -> true rotation, tangent plane at LM-A, plus noise."""
    e, n = ((TRUE[k][0] - TRUE["A"][0]) * 0.3048, (TRUE[k][1] - TRUE["A"][1]) * 0.3048)
    th = math.radians(GRID_AZ)
    E = math.cos(th) * e + math.sin(th) * n + random.gauss(0, GPS_SIGMA)
    N = -math.sin(th) * e + math.cos(th) * n + random.gauss(0, GPS_SIGMA)
    a, e2 = 6378137.0, 6.69437999014e-3
    s = math.sin(math.radians(LAT0))
    w = 1 - e2 * s * s
    kE = a / math.sqrt(w) * math.cos(math.radians(LAT0)) * math.pi / 180
    kN = a * (1 - e2) / (w * math.sqrt(w)) * math.pi / 180
    return f"{LAT0 + N / kN:.6f}", f"{LON0 + E / kE:.6f}"


def best_stations(pt):
    """Up to three stations with a clear line to `pt`, best spread (angles mod 180)."""
    from itertools import combinations
    P = TRUE[pt][:2]
    clear = [s for s, _ in STATIONS if not blocked(TRUE[s][:2], P)]
    if len(clear) <= 3:
        return clear
    best = None
    for trio in combinations(clear, 3):
        dirs = [az(TRUE[s][:2], P) % math.pi for s in trio]
        spread = min(min(abs(a - b), math.pi - abs(a - b)) for a, b in combinations(dirs, 2))
        if not best or spread > best[0]:
            best = (spread, trio)
    return best[1]


NAMES = {"A": "LM-A", "B": "LM-B", "C": "LM-C", "D": "LM-D", "M": "LM-M"}


def az(a, b):
    return math.atan2(b[0] - a[0], b[1] - a[1]) % (2 * math.pi)


def dms(rad, step=20):
    sec = round(math.degrees(rad) * 3600 / step) * step % (360 * 3600)
    d, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{int(d)} {int(m):02d} {int(s):02d}"


def main():
    lm = [k for k in TRUE if len(TRUE[k]) == 3]
    pts = [k for k in TRUE if len(TRUE[k]) == 5]
    proj = {
        "name": "Example property",
        "location": "1234 Example Street",
        "surveyor": "D. Panzino",
        "units": "ft",
        "angleSigma": 20,
        "circle": "cw",
        "datum": {"origin": "A", "originN": 5000, "originE": 5000, "orient": "B",
                  "bearing": "N " + dms(az(TRUE["A"], TRUE["B"]), 1) + " E"},
        "landmarks": [{"id": k, "name": NAMES[k], "desc": TRUE[k][2], "gsrc": "phone"} for k in lm],
        "points": [{"id": k, "name": k, "type": TRUE[k][2], "depth": TRUE[k][3], "desc": TRUE[k][4]} for k in pts],
        "setups": [],
        "baselines": [
            {"id": "BL1", "a": "A", "b": "B", "dist": f"{math.dist(TRUE['A'][:2], TRUE['B'][:2]) + 0.01:.2f}", "note": "Steel tape, 2 measurements averaged"},
            {"id": "BL2", "a": "C", "b": "D", "dist": f"{math.dist(TRUE['C'][:2], TRUE['D'][:2]) - 0.02:.2f}", "note": "Steel tape"},
        ],
        "lines": [
            {"id": "LW", "name": "Water service", "type": "water", "pts": ["W1", "W2", "W3", "W4"], "depth": "36-42 in", "desc": "1\" PE"},
            {"id": "LE", "name": "Electric service", "type": "elec", "pts": ["E1", "E2", "E3"], "depth": "24-30 in", "desc": "2\" PVC, 200A"},
            {"id": "LS", "name": "Septic", "type": "sewer", "pts": ["W4", "ST", "DB"], "depth": "", "desc": "4\" PVC"},
            {"id": "LG", "name": "Well line", "type": "water", "pts": ["WELL", "W4"], "depth": "48 in", "desc": "1\" PE"},
        ],
        "obstacles": [
            {"id": "OH", "name": "House", "kind": "building", "pts": [list(v) for v in HOUSE], "desc": "Two storey, built 1978"},
            {"id": "OD", "name": "Deck", "kind": "structure", "blocks": False, "pts": [v if isinstance(v, str) else list(v) for v in DECK],
             "desc": "Rear deck, 3 ft high, open below the rail"},
            {"id": "OS", "name": "Shed", "kind": "structure", "pts": [list(v) for v in SHED], "desc": "10x12 shed on the concrete pad"},
        ],
        "geo": {"source": "esri", "opacity": 0.6, "show": True},
        "titleblock": {"project": "1234 Example Street", "drawn_by": "D. Panzino", "dwg_no": "S-001", "rev": "A"},
        "notes": ["Coordinates are local (assumed). Bearings are referenced to the line LM-A to LM-B.",
                  "Depths are to top of pipe/conduit, measured when the trench was open."],
    }
    # landmarks sight every other landmark they can see
    sights = {s: [x for x, _ in STATIONS if x not in (s, b) and not blocked(TRUE[s][:2], TRUE[x][:2])] for s, b in STATIONS}
    for pt in pts:
        st = best_stations(pt)
        if len(st) < 2:
            sys.exit(f"{pt} is visible from {st} only")
        for s in st:
            sights[s].append(pt)
    for i, (s, b) in enumerate(STATIONS):
        fs = sights[s]
        S, B = TRUE[s][:2], TRUE[b][:2]
        readings = []
        for f in fs:
            F = TRUE[f][:2]
            ang = (az(S, F) - az(S, B)) % (2 * math.pi) + math.radians(random.gauss(0, 12 / 3600))
            readings.append({"id": f"{s}{f}", "target": f, "reading": dms(ang), "dist": "", "note": ""})
        proj["setups"].append({"id": f"S{i + 1}", "date": f"2026-10-{10 + i:02d}", "station": s, "backsight": b,
                               "bsReading": "0 00 00", "note": "Zeroed on backsight", "readings": readings})
    for l in proj["landmarks"]:
        if l["id"] != "M":              # no fix on the deck post
            l["lat"], l["lon"] = latlon(l["id"])
    out = pathlib.Path(__file__).resolve().parents[1] / "examples" / "example_property.json"
    out.write_text(json.dumps(proj, indent=1))
    if "--truth" in sys.argv:
        print(json.dumps({"coords": {k: v[:2] for k, v in TRUE.items()}, "gridAz": GRID_AZ, "lat0": LAT0, "lon0": LON0,
                          "obstacles": {"House": HOUSE, "Shed": SHED}}))
    else:
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
