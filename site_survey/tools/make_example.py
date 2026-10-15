"""Generate examples/example_property.json from known 'true' coordinates.

Readings are what a 20" transit would give: true angle + noise, rounded to 20".
Run with --truth to also print the true coordinates (used by tools/check.py).
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
    "C": (5155.80, 4891.45, "Chiseled X on concrete pad of shed, SE corner"),
    "D": (4991.30, 4878.60, "1/2\" rebar with yellow cap, SW corner by garden"),
    "M": (5096.40, 4979.10, "16d nail in top of deck post, NW post of rear deck"),
    # points of interest (E, N, type, depth, description)
    "W1": (5012.40, 5003.80, "water", "42 in", "Water meter box at street"),
    "W2": (5048.15, 4985.30, "water", "42 in", "Water line bend (45 deg)"),
    "W3": (5061.90, 4952.75, "water", "36 in", "Water line tee to hose bib"),
    "W4": (5068.40, 4931.20, "water", "36 in", "Water entry at house foundation"),
    "E1": (5128.90, 4996.50, "elec", "30 in", "Transformer pedestal"),
    "E2": (5101.25, 4964.10, "elec", "24 in", "Conduit bend"),
    "E3": (5084.60, 4938.40, "elec", "24 in", "House meter base, conduit up"),
    "ST": (5040.70, 4905.25, "sewer", "18 in to lid", "Septic tank inlet lid"),
    "DB": (5021.35, 4889.90, "sewer", "20 in", "Septic distribution box"),
    "WELL": (5118.60, 4910.30, "water", "", "Well head (casing)"),
    "LP": (5137.10, 4945.80, "gas", "", "Propane tank fill valve"),
}
STATIONS = [("A", "B"), ("B", "A"), ("C", "B"), ("D", "A"), ("M", "A")]   # (station, backsight)


def best_stations(pt):
    """Three stations whose sight lines to `pt` are best spread (angles mod 180)."""
    from itertools import combinations
    P = TRUE[pt][:2]
    best = None
    for trio in combinations([s for s, _ in STATIONS], 3):
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
        "landmarks": [{"id": k, "name": NAMES[k], "desc": TRUE[k][2]} for k in lm],
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
        "titleblock": {"project": "1234 Example Street", "drawn_by": "D. Panzino", "dwg_no": "S-001", "rev": "A"},
        "notes": ["Coordinates are local (assumed). Bearings are referenced to the line LM-A to LM-B.",
                  "Depths are to top of pipe/conduit, measured when the trench was open."],
    }
    sights = {s: [x for x, _ in STATIONS if x not in (s, b)] for s, b in STATIONS}   # landmarks see each other
    for pt in pts:
        for s in best_stations(pt):
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
    out = pathlib.Path(__file__).resolve().parents[1] / "examples" / "example_property.json"
    out.write_text(json.dumps(proj, indent=1))
    if "--truth" in sys.argv:
        print(json.dumps({k: v[:2] for k, v in TRUE.items()}))
    else:
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
