"""Build an ANSI B (11 x 17 in, portrait) DXF panel directory drawing.

All geometry is in inches, drawn 1:1 in model space. A paper-space layout
("ANSI B") with a 1:1 viewport is also created so the sheet plots at full
scale from CAD without any page setup.
"""
from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass

import ezdxf
from ezdxf.enums import TextEntityAlignment
from ezdxf.fonts import fonts

from .model import FEATURE_TEXT, Breaker, Panel, Pole

# Liberation Sans is metric-compatible with Arial; use it for measuring and
# previewing when Arial is not installed. The DXF itself references Arial.
fonts.font_manager.add_synonyms({
    "liberationsans-regular.ttf": "arial.ttf",
    "liberationsans-bold.ttf": "arialbd.ttf",
})

SHEET_W, SHEET_H = 11.0, 17.0
FRAME = 0.40          # outer border offset from sheet edge
BAND = 0.25           # zone-marking band width
IX0, IY0 = FRAME + BAND, FRAME + BAND
IX1, IY1 = SHEET_W - IX0, SHEET_H - IY0

TB_W, TB_H = 4.6, 1.55   # title block
HEADER_H = 0.95

# panel graphic
BUS_HALF = 0.20
BUS_GAP = 0.04
BKR_W = 0.85
DEADFRONT_PAD = 0.11
ENCL_PAD = 0.07

LAYERS = {
    # name: (color, lineweight in 1/100 mm, linetype)
    "FRAME": (7, 60, "CONTINUOUS"),
    "FRAME-THIN": (7, 18, "CONTINUOUS"),
    "TITLE": (7, 35, "CONTINUOUS"),
    "TITLE-GRID": (7, 18, "CONTINUOUS"),
    "TEXT": (7, 25, "CONTINUOUS"),
    "TEXT-MINOR": (8, 18, "CONTINUOUS"),
    "ENCLOSURE": (7, 50, "CONTINUOUS"),
    "DEADFRONT": (7, 25, "CONTINUOUS"),
    "BUS": (7, 35, "CONTINUOUS"),
    "BREAKER": (7, 35, "CONTINUOUS"),
    "HANDLE": (7, 25, "CONTINUOUS"),
    "TIE": (7, 50, "CONTINUOUS"),
    "FILLER": (8, 18, "DASHED"),
    "HATCH": (8, 9, "CONTINUOUS"),
    "SHADE": (254, 0, "CONTINUOUS"),
    "TABLE": (7, 35, "CONTINUOUS"),
    "TABLE-GRID": (8, 13, "CONTINUOUS"),
}

STYLE_REG, STYLE_BOLD = "PANEL-STD", "PANEL-BOLD"
FONT_FILE = {STYLE_REG: "arial.ttf", STYLE_BOLD: "arialbd.ttf"}
LINE_SPACING = 1.55   # baseline-to-baseline as a multiple of cap height

A = TextEntityAlignment


# --------------------------------------------------------------------------
# low-level drawing helpers
# --------------------------------------------------------------------------
class Sheet:
    def __init__(self) -> None:
        doc = ezdxf.new("R2013", setup=True, units=ezdxf.units.IN)
        doc.header["$MEASUREMENT"] = 0
        doc.header["$LWDISPLAY"] = 1
        doc.header["$LTSCALE"] = 0.25
        doc.header["$PSLTSCALE"] = 0
        for name, (color, lw, lt) in LAYERS.items():
            layer = doc.layers.add(name, color=color, linetype=lt)
            layer.dxf.lineweight = lw
        doc.layers.get("SHADE").plot = True
        doc.styles.add(STYLE_REG, font="arial.ttf")
        doc.styles.add(STYLE_BOLD, font="arialbd.ttf")
        self.doc = doc
        self.msp = doc.modelspace()
        self._fonts: dict[str, fonts.AbstractFont] = {}

    # measurement -------------------------------------------------------
    def width(self, s: str, h: float, style: str = STYLE_REG) -> float:
        f = self._fonts.get(style)
        if f is None:
            f = self._fonts[style] = fonts.make_font(FONT_FILE[style], 1.0)
        return f.text_width(s) * h * 1.04  # small slack for CAD font differences

    # primitives --------------------------------------------------------
    def line(self, x0, y0, x1, y1, layer):
        self.msp.add_line((x0, y0), (x1, y1), dxfattribs={"layer": layer})

    def rect(self, x0, y0, x1, y1, layer, r: float = 0.0):
        x0, x1 = min(x0, x1), max(x0, x1)
        y0, y1 = min(y0, y1), max(y0, y1)
        r = min(r, (x1 - x0) / 2.01, (y1 - y0) / 2.01)
        if r <= 1e-6:
            pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        else:
            b = 0.41421356  # tan(22.5 deg): 90 deg fillet
            pts = [(x0 + r, y0, 0, 0, 0), (x1 - r, y0, 0, 0, b), (x1, y0 + r, 0, 0, 0),
                   (x1, y1 - r, 0, 0, b), (x1 - r, y1, 0, 0, 0), (x0 + r, y1, 0, 0, b),
                   (x0, y1 - r, 0, 0, 0), (x0, y0 + r, 0, 0, b)]
            self.msp.add_lwpolyline(pts, format="xyseb", close=True, dxfattribs={"layer": layer})
            return
        self.msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": layer})

    def poly(self, pts, layer, close=False):
        self.msp.add_lwpolyline(pts, close=close, dxfattribs={"layer": layer})

    def circle(self, x, y, r, layer):
        self.msp.add_circle((x, y), r, dxfattribs={"layer": layer})

    def hatch_rect(self, x0, y0, x1, y1, layer, pattern="ANSI31", scale=0.8):
        h = self.msp.add_hatch(dxfattribs={"layer": layer})
        if pattern == "SOLID":
            h.set_solid_fill(color=LAYERS[layer][0])
        else:
            h.set_pattern_fill(pattern, scale=scale)
        h.paths.add_polyline_path([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], is_closed=True)

    def text(self, s, x, y, h, align=A.MIDDLE_CENTER, layer="TEXT", style=STYLE_REG):
        if not s:
            return
        t = self.msp.add_text(s, height=h, dxfattribs={"layer": layer, "style": style})
        t.set_placement((x, y), align=align)

    # fitted / wrapped text -------------------------------------------
    def wrap(self, s: str, w: float, h: float, style=STYLE_REG) -> list[str]:
        lines: list[str] = []
        for para in s.split("\n"):
            cur = ""
            for word in para.split():
                trial = f"{cur} {word}".strip()
                if self.width(trial, h, style) <= w or not cur:
                    cur = trial
                else:
                    lines.append(cur)
                    cur = word
            lines.append(cur)
        return lines

    def fit(self, s: str, w: float, box_h: float, h_max: float, h_min: float,
            style=STYLE_REG, max_lines: int = 3) -> tuple[list[str], float]:
        """Largest text height (<= h_max) at which ``s`` wraps into the box."""
        h = h_max
        while True:
            n_fit = max(1, min(max_lines, int((box_h - 0.6 * h) // (h * LINE_SPACING)) + 1))
            lines = self.wrap(s, w, h, style)
            if len(lines) <= n_fit and all(self.width(l, h, style) <= w for l in lines):
                return lines, h
            if h <= h_min + 1e-9:
                lines = lines[:n_fit]
                last = lines[-1]
                while last and self.width(last + "…", h, style) > w:
                    last = last[:-1]
                lines[-1] = (last.rstrip() + "…") if last != lines[-1] or len(self.wrap(s, w, h, style)) > n_fit else last
                return lines, h
            h = max(h_min, h - 0.005)

    def text_box(self, s, x0, y0, x1, y1, h_max, h_min=0.06, align="left", pad=0.05,
                 layer="TEXT", style=STYLE_REG, max_lines=3):
        """Fit ``s`` into a box, vertically centred."""
        if not s:
            return
        w = (x1 - x0) - 2 * pad
        lines, h = self.fit(s, w, (y1 - y0) - 0.04, h_max, h_min, style, max_lines)
        n = len(lines)
        yc = (y0 + y1) / 2
        top = yc + (n - 1) * h * LINE_SPACING / 2
        for i, ln in enumerate(lines):
            y = top - i * h * LINE_SPACING
            if align == "left":
                self.text(ln, x0 + pad, y, h, A.MIDDLE_LEFT, layer, style)
            elif align == "right":
                self.text(ln, x1 - pad, y, h, A.MIDDLE_RIGHT, layer, style)
            else:
                self.text(ln, (x0 + x1) / 2, y, h, A.MIDDLE_CENTER, layer, style)


# --------------------------------------------------------------------------
# breaker symbols
# --------------------------------------------------------------------------
@dataclass
class BodyGeom:
    """Breaker body placed against the bus. ``out`` = +1 if outboard is +x."""
    x_in: float      # x of bus-side edge
    out: int
    y_top: float
    row_h: float
    width: float = BKR_W

    @property
    def x_out(self):
        return self.x_in + self.out * self.width

    def x(self, frac: float) -> float:
        """x at fraction of width measured from the bus side."""
        return self.x_in + self.out * self.width * frac


INSET = 0.028


def _toggle(sh: Sheet, g: BodyGeom, yc: float, ph: float, toggle=True) -> tuple[float, float, float]:
    """Handle slot + toggle (in ON position, outboard). Returns toggle (xc, y0, y1)."""
    sh_h = min(0.42 * ph, 0.16)
    slot_w = 0.30 * g.width / BKR_W
    xs0, xs1 = g.x(0.5) - g.out * slot_w / 2, g.x(0.5) + g.out * slot_w / 2
    sh.rect(xs0, yc - sh_h / 2, xs1, yc + sh_h / 2, "HANDLE", r=0.01)
    tw = 0.11 * g.width / BKR_W
    tx1 = xs1 - g.out * 0.02
    tx0 = tx1 - g.out * tw
    th = sh_h + min(0.05, 0.25 * ph)
    if toggle:
        sh.rect(tx0, yc - th / 2, tx1, yc + th / 2, "HANDLE", r=0.012)
    return (tx0 + tx1) / 2, yc - th / 2, yc + th / 2


def _amps(sh: Sheet, g: BodyGeom, yc: float, ph: float, amps: int | None, inboard=False):
    if amps is None:
        return
    h = min(0.095, 0.42 * ph) * g.width / BKR_W
    zone_w = 0.30 * g.width  # clear width between handle slot and body edge
    h = min(h, 0.9 * zone_w / max(sh.width(str(amps), 1.0, STYLE_BOLD), 1e-6))
    # middle of the zone between the handle slot and the body edge
    zone_mid = g.x(0.175 if inboard else 0.825)
    sh.text(str(amps), zone_mid, yc, h, A.MIDDLE_CENTER, "TEXT", STYLE_BOLD)


def _test_button(sh: Sheet, g: BodyGeom, yc: float, ph: float):
    r = min(0.04, 0.22 * ph) * g.width / BKR_W
    xc = g.x(0.17)
    sh.circle(xc, yc, r, "HANDLE")
    sh.circle(xc, yc, r * 0.45, "HANDLE")


def _pole_tick(sh: Sheet, g: BodyGeom, y: float, layer="HANDLE"):
    """Pole division: short ticks at both body edges (keeps the face clear)."""
    t = 0.07 * g.width / BKR_W
    sh.line(g.x_in, y, g.x_in + g.out * t, y, layer)
    sh.line(g.x_out, y, g.x_out - g.out * t, y, layer)


def draw_pole_set(sh: Sheet, g: BodyGeom, span: int, kind: str, br: Breaker | None):
    """Draw one breaker body spanning ``span`` rows from ``g.y_top``."""
    rh = g.row_h
    y1 = g.y_top - INSET
    y0 = g.y_top - span * rh + INSET
    xo, xi = g.x_out, g.x_in
    if kind == "blank":
        sh.rect(xi, y0, xo, y1, "FILLER", r=0.02)
        sh.hatch_rect(min(xi, xo) + 0.03, y0 + 0.03, max(xi, xo) - 0.03, y1 - 0.03, "HATCH",
                      scale=max(0.35, 0.8 * g.width / BKR_W))
        return
    sh.rect(xi, y0, xo, y1, "BREAKER", r=0.03)

    if kind == "single":
        yc = g.y_top - rh / 2
        _toggle(sh, g, yc, rh)
        _amps(sh, g, yc, rh, br.main.amps)
        if br.main.feature:
            _test_button(sh, g, yc, rh)

    elif kind in ("double", "triple"):
        tops, bots = [], []
        for i in range(span):
            yc = g.y_top - (i + 0.5) * rh
            if i:
                _pole_tick(sh, g, g.y_top - i * rh, "BREAKER")
            xc, t0, t1 = _toggle(sh, g, yc, rh, toggle=False)
            tops.append(t1)
            bots.append(t0)
        # common handle spanning all poles
        tw = 0.11 * g.width / BKR_W
        sh.rect(xc - tw / 2, bots[-1], xc + tw / 2, tops[0], "HANDLE", r=0.012)
        for i in range(span - 1):
            sh.line(xc - tw / 2, bots[i] , xc + tw / 2, bots[i], "HANDLE")
        _amps(sh, g, g.y_top - rh / 2, rh, br.main.amps)
        if br.main.feature:
            _test_button(sh, g, g.y_top - rh / 2, rh)

    elif kind == "tandem":
        ph = rh / 2
        _pole_tick(sh, g, g.y_top - ph)
        for i, pole in enumerate((br.a, br.b)):
            yc = g.y_top - (i + 0.5) * ph
            _toggle(sh, g, yc, ph)
            _amps(sh, g, yc, ph, pole.amps)
            if pole.feature:
                _test_button(sh, g, yc, ph)

    elif kind == "quad":
        ph = rh / 2
        _pole_tick(sh, g, g.y_top - rh, "BREAKER")
        _pole_tick(sh, g, g.y_top - ph)
        _pole_tick(sh, g, g.y_top - 3 * ph)
        tw = 0.11 * g.width / BKR_W
        ts = []
        for i in range(4):
            yc = g.y_top - (i + 0.5) * ph
            ts.append(_toggle(sh, g, yc, ph, toggle=(i in (0, 3))))
        xc = ts[0][0]
        # inner pair: common handle
        sh.rect(xc - tw / 2, ts[2][1], xc + tw / 2, ts[1][2], "HANDLE", r=0.012)
        # outer pair: bracket tie passing outboard of the inner handle
        xb = xc + g.out * (tw / 2 + 0.05 * g.width / BKR_W)
        sh.poly([(xc + g.out * tw / 2, (ts[0][1] + ts[0][2]) / 2), (xb, (ts[0][1] + ts[0][2]) / 2),
                 (xb, (ts[3][1] + ts[3][2]) / 2), (xc + g.out * tw / 2, (ts[3][1] + ts[3][2]) / 2)], "TIE")
        # outer bracket occupies the outboard zone: put ratings inboard
        _amps(sh, g, g.y_top - 0.5 * ph, ph, br.a.amps, inboard=True)
        _amps(sh, g, g.y_top - 1.5 * ph, ph, br.b.amps, inboard=True)


def draw_handle_tie(sh: Sheet, g_upper: BodyGeom):
    """External handle tie between a single-pole breaker and the one below it."""
    rh = g_upper.row_h
    xc = g_upper.x(0.5) + g_upper.out * (0.15 - 0.02 - 0.055) * g_upper.width / BKR_W
    ya = g_upper.y_top - 0.5 * rh
    yb = ya - rh
    w = 0.035 * g_upper.width / BKR_W
    sh.rect(xc - w, yb, xc + w, ya, "TIE")
    for y in (ya, yb):
        sh.circle(xc, y, w * 0.7, "TIE")


# --------------------------------------------------------------------------
# sheet furniture
# --------------------------------------------------------------------------
def draw_border(sh: Sheet):
    sh.rect(FRAME, FRAME, SHEET_W - FRAME, SHEET_H - FRAME, "FRAME-THIN")
    sh.rect(IX0, IY0, IX1, IY1, "FRAME")
    # zones: numbers right-to-left, letters bottom-to-top (ASME Y14.1 style)
    ncol, nrow = 4, 6
    zw = (SHEET_W - 2 * FRAME) / ncol
    zh = (SHEET_H - 2 * FRAME) / nrow
    for i in range(ncol):
        x0 = SHEET_W - FRAME - (i + 1) * zw
        if i < ncol - 1:
            for ya, yb in ((FRAME, IY0), (IY1, SHEET_H - FRAME)):
                sh.line(x0, ya, x0, yb, "FRAME-THIN")
        for yc in (FRAME + BAND / 2, SHEET_H - FRAME - BAND / 2):
            sh.text(str(i + 1), x0 + zw / 2, yc, 0.11)
    for j in range(nrow):
        y0 = FRAME + j * zh
        if j:
            for xa, xb in ((FRAME, IX0), (IX1, SHEET_W - FRAME)):
                sh.line(xa, y0, xb, y0, "FRAME-THIN")
        for xc in (FRAME + BAND / 2, SHEET_W - FRAME - BAND / 2):
            sh.text("ABCDEF"[j], xc, y0 + zh / 2, 0.11)


def _cell(sh: Sheet, x0, y0, x1, y1, label, value, vh=0.11, style=STYLE_REG, align="left", max_lines=2):
    sh.text(label, x0 + 0.05, y1 - 0.05, 0.055, A.TOP_LEFT, "TEXT-MINOR")
    sh.text_box(value, x0, y0, x1, y1 - 0.09, vh, 0.06, align=align, style=style, max_lines=max_lines)


def draw_header(sh: Sheet, p: Panel, stats: dict) -> float:
    y1 = IY1
    y0 = y1 - HEADER_H
    sh.rect(IX0, y0, IX1, y1, "TITLE")
    xs = IX0 + 3.3
    sh.line(xs, y0, xs, y1, "TITLE")
    sh.text("PANEL DESIGNATION", IX0 + 0.08, y1 - 0.08, 0.06, A.TOP_LEFT, "TEXT-MINOR")
    sh.text_box(p.name.upper(), IX0 + 0.03, y0 + 0.30, xs - 0.03, y1 - 0.14, 0.26, 0.12,
                style=STYLE_BOLD, max_lines=1)
    loc = f"LOCATION: {p.location.upper()}" if p.location else ""
    sh.text_box(loc, IX0 + 0.03, y0 + 0.04, xs - 0.03, y0 + 0.30, 0.09, 0.06, max_lines=1)

    main = (f"{p.main_amps}A MAIN BREAKER" if p.main_amps else "MAIN BREAKER") if p.main_kind == "breaker" \
        else (f"MAIN LUGS ONLY ({p.main_amps}A)" if p.main_amps else "MAIN LUGS ONLY")
    mfr = " ".join(x for x in (p.manufacturer, p.model) if x)
    used = f"{stats['used']} USED / {stats['free']} OPEN"
    fields = [
        ("SERVICE", p.voltage), ("MAIN", main), ("BUS RATING", f"{p.bus_amps}A" if p.bus_amps else ""),
        ("SPACES", f"{p.spaces}"),
        ("MANUFACTURER / MODEL", mfr.upper()), ("FED FROM", p.fed_from.upper()),
        ("CIRCUITS", str(stats["circuits"])), ("SPACE USAGE", used),
    ]
    widths = [1.75, 1.95, 1.15, 1.15]
    scale = (IX1 - xs) / sum(widths)
    widths = [w * scale for w in widths]
    ym = (y0 + y1) / 2
    sh.line(xs, ym, IX1, ym, "TITLE-GRID")
    for r in range(2):
        x = xs
        for c in range(4):
            label, value = fields[r * 4 + c]
            if c:
                sh.line(x, y0 if r else ym, x, ym if r else y1, "TITLE-GRID")
            cy0, cy1 = (ym, y1) if r == 0 else (y0, ym)
            _cell(sh, x, cy0, x + widths[c], cy1, label, value.upper(), vh=0.105, max_lines=2)
            x += widths[c]
    return y0


def draw_title_block(sh: Sheet, p: Panel):
    tb = p.titleblock
    x0, y0 = IX1 - TB_W, IY0
    x1, y1 = IX1, IY0 + TB_H
    sh.rect(x0, y0, x1, y1, "TITLE")
    rows = [0.40, 0.45, 0.35, 0.35]
    ys = [y1]
    for h in rows:
        ys.append(ys[-1] - h)
    for y in ys[1:-1]:
        sh.line(x0, y, x1, y, "TITLE-GRID")
    _cell(sh, x0, ys[1], x1, ys[0], "PROJECT / PROPERTY", (tb.get("project") or "").upper(),
          vh=0.14, style=STYLE_BOLD, max_lines=1)
    title = (tb.get("title") or f"{p.name} — PANEL DIRECTORY").upper()
    _cell(sh, x0, ys[2], x1, ys[1], "DRAWING TITLE", title, vh=0.13, style=STYLE_BOLD)
    date = tb.get("date") or _dt.date.today().isoformat()
    row3 = [("DRAWN BY", (tb.get("drawn_by") or "").upper(), 1.6), ("DATE", date, 1.5),
            ("SCALE", (tb.get("scale") or "NONE").upper(), 1.5)]
    row4 = [("SIZE", "B", 0.55), ("DWG NO.", (tb.get("dwg_no") or "").upper(), 2.15),
            ("REV", (tb.get("rev") or "").upper(), 0.55), ("SHEET", (tb.get("sheet") or "1 OF 1").upper(), 1.35)]
    for row, (ya, yb) in ((row3, (ys[3], ys[2])), (row4, (ys[4], ys[3]))):
        x = x0
        for i, (lab, val, w) in enumerate(row):
            if i:
                sh.line(x, ya, x, yb, "TITLE-GRID")
            _cell(sh, x, ya, x + w, yb, lab, val, vh=0.11 if lab != "SIZE" else 0.15,
                  align="center", max_lines=1, style=STYLE_BOLD if lab in ("SIZE", "REV") else STYLE_REG)
            x += w


def draw_notes(sh: Sheet, p: Panel) -> float:
    """Notes block beside the title block. Returns the y of its top edge.

    Text shrinks to fit the title-block height; if the notes still don't fit
    at the minimum size, the block grows upward (taking space from the body).
    """
    x0, x1 = IX0, IX1 - TB_W
    y0 = IY0
    head = 0.28
    num_w = 0.25
    w = (x1 - x0) - num_w - 0.2
    h_max, h_min = 0.095, 0.07

    def layout(h):
        blocks = [sh.wrap(n, w, h) for n in p.notes]
        return blocks, head + sum(len(b) for b in blocks) * h * LINE_SPACING + 0.08

    h = h_max
    blocks, need = layout(h)
    while need > TB_H and h > h_min + 1e-9:
        h = max(h_min, h - 0.005)
        blocks, need = layout(h)
    y1 = y0 + max(TB_H, need)
    sh.rect(x0, y0, x1, y1, "TITLE")
    sh.text("NOTES", x0 + 0.08, y1 - 0.08, 0.085, A.TOP_LEFT, "TEXT", STYLE_BOLD)
    y = y1 - head - h / 2
    for i, blk in enumerate(blocks):
        sh.text(f"{i + 1}.", x0 + 0.1, y, h, A.MIDDLE_LEFT)
        for ln in blk:
            sh.text(ln, x0 + 0.1 + num_w, y, h, A.MIDDLE_LEFT)
            y -= h * LINE_SPACING
    return y1


# --------------------------------------------------------------------------
# panel + directory
# --------------------------------------------------------------------------
def _amp_text(pole: Pole, poles: int) -> str:
    if pole.amps is None:
        return ""
    return f"{pole.amps}A" + (f" {poles}P" if poles > 1 else "")


def _desc(p: Panel, s: str) -> str:
    return s.upper() if p.titleblock.get("uppercase", "1") not in ("0", "false", "False") else s


def draw_panel(sh: Sheet, p: Panel, top: float, bottom: float):
    cx = SHEET_W / 2
    main_h = 1.05
    rows = p.rows
    avail = (top - main_h) - 0.18 - bottom
    rh = min(0.62, avail / rows)
    rows_top = top - main_h
    rows_bot = rows_top - rows * rh

    half_bkr = BUS_HALF + BUS_GAP + BKR_W
    df_half = half_bkr + DEADFRONT_PAD
    en_half = df_half + ENCL_PAD
    en_y1, en_y0 = top, rows_bot - 0.18

    # enclosure (can + dead-front opening)
    sh.rect(cx - en_half, en_y0, cx + en_half, en_y1, "ENCLOSURE", r=0.08)
    sh.rect(cx - df_half, en_y0 + ENCL_PAD, cx + df_half, en_y1 - ENCL_PAD, "DEADFRONT", r=0.05)

    # main
    npole = 3 if p.phases == 3 else 2
    m_w = 0.36 * npole + 0.22
    m_y1 = en_y1 - ENCL_PAD - 0.12
    m_y0 = m_y1 - 0.62
    bus_top = m_y0
    sh.rect(cx - BUS_HALF, rows_bot - 0.06, cx + BUS_HALF, bus_top, "BUS")
    phases = ["L1", "L2"] if npole == 2 else ["A", "B", "C"]
    pole_x = [cx + (i - (npole - 1) / 2) * 0.36 for i in range(npole)]
    if p.main_kind == "breaker":
        sh.rect(cx - m_w / 2, m_y0, cx + m_w / 2, m_y1, "BREAKER", r=0.04)
        hy0, hy1 = m_y1 - 0.38, m_y1 - 0.08
        for x in pole_x:
            sh.rect(x - 0.07, hy0, x + 0.07, hy1, "HANDLE", r=0.012)
            sh.rect(x - 0.045, hy1 - 0.12, x + 0.045, hy1 - 0.02, "HANDLE", r=0.01)  # toggle ON (up)
        sh.rect(pole_x[0] - 0.045, hy1 - 0.09, pole_x[-1] + 0.045, hy1 - 0.05, "TIE")
        sh.text(f"MAIN {p.main_amps}A" if p.main_amps else "MAIN", cx, m_y0 + 0.11, 0.085,
                A.MIDDLE_CENTER, "TEXT", STYLE_BOLD)
    else:
        for x in pole_x:
            sh.rect(x - 0.11, m_y0, x + 0.11, m_y0 + 0.24, "BUS", r=0.02)
            sh.circle(x, m_y0 + 0.12, 0.055, "HANDLE")
            sh.line(x, m_y0 + 0.24, x, m_y1 + 0.05, "BUS")
        sh.text_box("MAIN LUGS", pole_x[-1] + 0.12, m_y0 - 0.05, cx + df_half - 0.02, m_y0 + 0.29,
                    0.08, 0.06, style=STYLE_BOLD, max_lines=2, pad=0.02)
    for x, ph in zip(pole_x, phases):
        if p.main_kind == "breaker":
            sh.text(ph, x, m_y1 + 0.02, 0.065, A.BOTTOM_CENTER, "TEXT-MINOR")
        else:
            sh.text(ph, x + 0.03, m_y1 - 0.03, 0.065, A.TOP_LEFT, "TEXT-MINOR")

    # bus phase letters
    for r in range(rows):
        yc = rows_top - (r + 0.5) * rh
        sh.text(p.phase_of_row(r), cx, yc, min(0.075, rh * 0.3), A.MIDDLE_CENTER, "TEXT-MINOR")
        if r:
            y = rows_top - r * rh
            sh.line(cx - BUS_HALF, y, cx - BUS_HALF + 0.05, y, "TEXT-MINOR")
            sh.line(cx + BUS_HALF, y, cx + BUS_HALF - 0.05, y, "TEXT-MINOR")

    # breakers
    occ = p.breaker_at()

    def geom(col, row):
        if col == 0:
            return BodyGeom(cx - BUS_HALF - BUS_GAP, -1, rows_top - row * rh, rh)
        return BodyGeom(cx + BUS_HALF + BUS_GAP, +1, rows_top - row * rh, rh)

    for col in (0, 1):
        for row in range(rows):
            sp = p.space_at(col, row)
            br = occ.get(sp)
            if br is None:
                draw_pole_set(sh, geom(col, row), 1, "blank", None)
            elif br.space == sp:
                draw_pole_set(sh, geom(col, row), br.span, br.kind, br)
                if br.tie_below:
                    draw_handle_tie(sh, geom(col, row))

    # directories
    gap = 0.14
    t_w = (cx - en_half - gap) - (IX0 + 0.12)
    ckt_w, amp_w = 0.42, 0.62
    hdr_h = 0.30
    for col in (0, 1):
        if col == 0:
            tx0, tx1 = IX0 + 0.12, cx - en_half - gap
            desc = (tx0, tx1 - ckt_w - amp_w)
            amp = (desc[1], desc[1] + amp_w)
            ckt = (amp[1], tx1)
        else:
            tx0, tx1 = cx + en_half + gap, IX1 - 0.12
            ckt = (tx0, tx0 + ckt_w)
            amp = (ckt[1], ckt[1] + amp_w)
            desc = (amp[1], tx1)
        # header
        hy0, hy1 = rows_top, rows_top + hdr_h
        sh.hatch_rect(tx0, hy0, tx1, hy1, "SHADE", pattern="SOLID")
        sh.rect(tx0, hy0, tx1, hy1, "TABLE")
        sh.text("CIRCUIT DESCRIPTION", (desc[0] + desc[1]) / 2, (hy0 + hy1) / 2, 0.08, A.MIDDLE_CENTER, "TEXT", STYLE_BOLD)
        sh.text("TRIP", (amp[0] + amp[1]) / 2, (hy0 + hy1) / 2, 0.08, A.MIDDLE_CENTER, "TEXT", STYLE_BOLD)
        sh.text("CKT", (ckt[0] + ckt[1]) / 2, (hy0 + hy1) / 2, 0.08, A.MIDDLE_CENTER, "TEXT", STYLE_BOLD)
        for xv in (amp[0], amp[1]):
            sh.line(xv, hy0, xv, hy1, "TABLE")
        # body
        sh.rect(tx0, rows_bot, tx1, rows_top, "TABLE")
        for xv in (amp[0], amp[1]):
            sh.line(xv, rows_bot, xv, rows_top, "TABLE-GRID")
        _draw_directory_column(sh, p, col, occ, rows_top, rh, desc, amp, ckt)


def _draw_directory_column(sh, p: Panel, col, occ, rows_top, rh, desc, amp, ckt):
    rows = p.rows
    text_h = min(0.105, 0.36 * rh)
    row = 0
    while row < rows:
        sp = p.space_at(col, row)
        br = occ.get(sp)
        y1 = rows_top - row * rh
        span = br.span if br is not None and br.space == sp else 1
        y0 = y1 - span * rh
        if row + span < rows:
            sh.line(desc[0] if col == 0 else ckt[0], y0, ckt[1] if col == 0 else desc[1], y0, "TABLE-GRID")

        if br is None:
            sh.text(str(sp), sum(ckt) / 2, (y0 + y1) / 2, text_h, A.MIDDLE_CENTER, "TEXT", STYLE_BOLD)
            sh.text("SPACE", desc[0] + 0.06, (y0 + y1) / 2, text_h * 0.8, A.MIDDLE_LEFT, "TEXT-MINOR")
            sh.text("—", sum(amp) / 2, (y0 + y1) / 2, text_h * 0.8, A.MIDDLE_CENTER, "TEXT-MINOR")
        elif br.kind == "tandem":
            ym = (y0 + y1) / 2
            sh.line(desc[0] if col == 0 else ckt[0], ym, ckt[1] if col == 0 else desc[1], ym, "TABLE-GRID")
            th = min(text_h, 0.36 * rh / 1.6)
            for i, (pole, suf) in enumerate(((br.a, "A"), (br.b, "B"))):
                cy1 = y1 - i * rh / 2
                cy0 = cy1 - rh / 2
                sh.text(f"{sp}{suf}", sum(ckt) / 2, (cy0 + cy1) / 2, th, A.MIDDLE_CENTER, "TEXT", STYLE_BOLD)
                _amp_cell(sh, pole, 1, amp, cy0, cy1, th, single_line=True)
                sh.text_box(_desc(p, pole.label), desc[0], cy0, desc[1], cy1, th, 0.055, max_lines=1)
        else:
            # circuit numbers, one per physical space
            for i in range(span):
                s_i = p.space_at(col, row + i)
                yc = y1 - (i + 0.5) * rh
                if br.kind == "quad":
                    th = min(text_h, 0.36 * rh / 1.6)
                    sh.text(f"{s_i}A", sum(ckt) / 2, yc + rh / 4, th, A.MIDDLE_CENTER, "TEXT", STYLE_BOLD)
                    sh.text(f"{s_i}B", sum(ckt) / 2, yc - rh / 4, th, A.MIDDLE_CENTER, "TEXT", STYLE_BOLD)
                else:
                    sh.text(str(s_i), sum(ckt) / 2, yc, text_h, A.MIDDLE_CENTER, "TEXT", STYLE_BOLD)
                if i:
                    sh.line(ckt[0], y1 - i * rh, ckt[1], y1 - i * rh, "TABLE-GRID")
            if br.kind == "quad":
                s2 = p.space_at(col, row + 1)
                ym = (y0 + y1) / 2
                sh.line(desc[0], ym, desc[1], ym, "TABLE-GRID")
                sh.line(amp[0], ym, amp[1], ym, "TABLE-GRID")
                for (pole, tag), (cy0, cy1) in (((br.a, f"OUTER {sp}A/{s2}B"), (ym, y1)),
                                                 ((br.b, f"INNER {sp}B/{s2}A"), (y0, ym))):
                    _amp_cell(sh, pole, 2, amp, cy0, cy1, text_h)
                    label = _desc(p, pole.label)
                    sh.text(tag, desc[0] + 0.06, cy1 - 0.035, 0.05, A.TOP_LEFT, "TEXT-MINOR")
                    sh.text_box(label, desc[0], cy0, desc[1], cy1 - 0.06, text_h, 0.055, max_lines=2)
            else:
                poles = {"single": 1, "double": 2, "triple": 3}[br.kind]
                _amp_cell(sh, br.main, poles, amp, y0, y1, text_h,
                          extra="TIED" if (br.tie_below or _tied_from_above(p, occ, br)) else "")
                sh.text_box(_desc(p, br.main.label), desc[0], y0, desc[1], y1, text_h, 0.055,
                            max_lines=max(2, span * 2))
        row += span


def _tied_from_above(p: Panel, occ, br: Breaker) -> bool:
    s = p.slot(br.space)
    if s.row == 0:
        return False
    above = occ.get(p.space_at(s.col, s.row - 1))
    return bool(above and above.tie_below)


def _amp_cell(sh: Sheet, pole: Pole, poles: int, amp, y0, y1, h, single_line=False, extra=""):
    main = _amp_text(pole, poles)
    tags = [t for t in (FEATURE_TEXT.get(pole.feature, ""), extra) if t]
    sub = " · ".join(tags)
    xc = sum(amp) / 2
    yc = (y0 + y1) / 2
    if single_line or not sub:
        s = main if not (single_line and sub) else f"{main} {sub}".strip()
        sh.text_box(s, amp[0], y0, amp[1], y1, h, 0.045, align="center", style=STYLE_BOLD, max_lines=1, pad=0.03)
        return
    sh_h = min(0.06, h * 0.7)
    gap = 0.02
    total = h + gap + sh_h
    if total > (y1 - y0) - 0.03:
        sh.text_box(f"{main} {sub}", amp[0], y0, amp[1], y1, h, 0.045, align="center", style=STYLE_BOLD, max_lines=1, pad=0.03)
        return
    top = yc + total / 2
    sh.text_box(main, amp[0], top - h - 0.01, amp[1], top + 0.01, h, 0.05, align="center", style=STYLE_BOLD, max_lines=1, pad=0.03)
    sh.text_box(sub, amp[0], top - total - 0.01, amp[1], top - h - gap + 0.01, sh_h, 0.04, align="center",
                layer="TEXT-MINOR", max_lines=1, pad=0.02)


# --------------------------------------------------------------------------
def build(p: Panel) -> ezdxf.document.Drawing:
    sh = Sheet()
    stats = p.stats()
    draw_border(sh)
    header_bottom = draw_header(sh, p, stats)
    draw_title_block(sh, p)
    notes_top = draw_notes(sh, p)
    body_top = header_bottom - 0.2
    body_bottom = notes_top + 0.2
    draw_panel(sh, p, body_top, body_bottom)
    _setup_paperspace(sh.doc)
    sh.doc.set_modelspace_vport(height=SHEET_H, center=(SHEET_W / 2, SHEET_H / 2))
    return sh.doc


def _setup_paperspace(doc):
    if "Layout1" in doc.layouts:
        doc.layouts.rename("Layout1", "ANSI B")
    psp = doc.layouts.get("ANSI B")
    psp.page_setup(size=(SHEET_W, SHEET_H), margins=(0, 0, 0, 0), units="inch")
    psp.add_viewport(center=(SHEET_W / 2, SHEET_H / 2), size=(SHEET_W, SHEET_H),
                     view_center_point=(SHEET_W / 2, SHEET_H / 2), view_height=SHEET_H)
