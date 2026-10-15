/* =========================================================================
 * Sheet: a flat list of drawing entities in sheet inches (y up), rendered
 * to SVG (screen/print) and DXF. Every entity carries an `owner` id so the
 * SVG can be grouped for hit-testing.
 * ========================================================================= */

const SHEET_W = 17.0, SHEET_H = 11.0;     // ANSI B landscape
const FRAME = 0.40, BAND = 0.25;          // border offset and zone band
const IX0 = FRAME + BAND, IY0 = FRAME + BAND;
const IX1 = SHEET_W - IX0, IY1 = SHEET_H - IY0;
const TB_W = 5.6, TB_H = 1.55;            // title block (bottom right)
const LINE_SPACING = 1.55;                // baseline pitch / cap height

// name: [ACI color, lineweight (1/100 mm), dashed]. Must match tools/make_dxf_template.py.
const LAYERS = {
  "FRAME": [7, 60], "FRAME-THIN": [7, 18], "TITLE": [7, 35], "TITLE-GRID": [7, 18],
  "TEXT": [7, 25], "TEXT-MINOR": [8, 18], "LABEL": [7, 18],
  "MAP-FRAME": [7, 35], "GRID": [8, 13], "NORTH": [7, 25], "SYMBOL-FILL": [7, 0],
  "CONTROL": [7, 35], "POINT": [7, 25], "SIGHT": [8, 13, true], "ELLIPSE": [8, 13],
  "UT-ELEC": [1, 50], "UT-GAS": [40, 50], "UT-COMM": [30, 50], "UT-WATER": [5, 50],
  "UT-SEWER": [3, 50], "UT-STORM": [94, 50], "UT-IRRIG": [6, 50], "UT-OTHER": [7, 50],
  "FEATURE": [7, 35], "PROPERTY": [7, 50, true],
};
// screen / print colours for the ACI numbers used above
const ACI_RGB = { 1: "#d4111e", 3: "#178a35", 5: "#1c56c8", 6: "#8e24aa", 7: "#000000", 8: "#808080",
                  30: "#ef7d00", 40: "#c49a00", 94: "#2b7a5f", 254: "#cfcfcf" };

class Sheet {
  constructor(font) {
    this.ents = [];
    this.font = font || FONTS[DEFAULT_FONT];
    this.owner = "sheet";
  }

  _push(e) { e.owner = this.owner; this.ents.push(e); }

  width(s, h, bold = false) { return textWidth(s, h, bold, this.font); }

  line(x0, y0, x1, y1, layer) { this._push({ t: "line", layer, x0, y0, x1, y1 }); }

  /** pts: [[x, y, bulge?], ...]; bulge applies to the segment leaving that vertex. */
  poly(pts, layer, closed = false) {
    this._push({ t: "poly", layer, pts: pts.map((p) => [p[0], p[1], p[2] || 0]), closed });
  }

  rect(x0, y0, x1, y1, layer, r = 0) {
    [x0, x1] = [Math.min(x0, x1), Math.max(x0, x1)];
    [y0, y1] = [Math.min(y0, y1), Math.max(y0, y1)];
    this.poly(rectPts(x0, y0, x1, y1, r), layer, true);
  }

  circle(x, y, r, layer) { this._push({ t: "circle", layer, x, y, r }); }

  /** Solid fill of a closed polygon (vertices may carry bulges). */
  fill(pts, layer = "SYMBOL-FILL") {
    this._push({ t: "fill", layer, pts: pts.map((p) => [p[0], p[1], p[2] || 0]) });
  }

  /** align: vertical (M/T/B) + horizontal (L/C/R), e.g. "ML". */
  text(s, x, y, h, align = "MC", layer = "TEXT", bold = false) {
    if (s === "" || s == null) return;
    this._push({ t: "text", layer, s: applySubst(s, this.font), x, y, h, align, bold });
  }

  wrap(s, w, h, bold = false) {
    const lines = [];
    for (const para of String(s).split("\n")) {
      let cur = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const trial = (cur + " " + word).trim();
        if (this.width(trial, h, bold) <= w || !cur) cur = trial;
        else { lines.push(cur); cur = word; }
      }
      lines.push(cur);
    }
    return lines;
  }

  /** Largest text height (<= hMax) at which `s` wraps into the box. */
  fit(s, w, boxH, hMax, hMin, bold = false, maxLines = 3) {
    let h = hMax;
    for (;;) {
      // n lines occupy (n - 1) line pitches plus one cap height
      const nFit = Math.max(1, Math.min(maxLines, Math.floor((boxH - h) / (h * LINE_SPACING) + 1e-9) + 1));
      let lines = this.wrap(s, w, h, bold);
      if (lines.length <= nFit && lines.every((l) => this.width(l, h, bold) <= w)) return [lines, h];
      if (h <= hMin + 1e-9) {
        const all = lines;
        lines = lines.slice(0, nFit);
        const orig = lines[lines.length - 1];
        let last = orig;
        while (last && this.width(last + "…", h, bold) > w) last = last.slice(0, -1);
        lines[lines.length - 1] = last !== orig || all.length > nFit ? last.trimEnd() + "…" : last;
        return [lines, h];
      }
      h = Math.max(hMin, h - 0.005);
    }
  }

  textBox(s, x0, y0, x1, y1, hMax, { hMin = 0.06, align = "left", pad = 0.05, layer = "TEXT",
                                     bold = false, maxLines = 3 } = {}) {
    if (!s) return;
    const w = (x1 - x0) - 2 * pad;
    const [lines, h] = this.fit(s, w, (y1 - y0) - 0.04, hMax, hMin, bold, maxLines);
    const top = (y0 + y1) / 2 + (lines.length - 1) * h * LINE_SPACING / 2;
    lines.forEach((ln, i) => {
      const y = top - i * h * LINE_SPACING;
      if (align === "left") this.text(ln, x0 + pad, y, h, "ML", layer, bold);
      else if (align === "right") this.text(ln, x1 - pad, y, h, "MR", layer, bold);
      else this.text(ln, (x0 + x1) / 2, y, h, "MC", layer, bold);
    });
  }
}

function rectPts(x0, y0, x1, y1, r = 0) {
  r = Math.min(r, (x1 - x0) / 2.01, (y1 - y0) / 2.01);
  if (r <= 1e-6) return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const b = 0.41421356; // tan(22.5 deg): 90 deg fillet
  return [[x0 + r, y0, 0], [x1 - r, y0, b], [x1, y0 + r, 0], [x1, y1 - r, b],
          [x1 - r, y1, 0], [x0 + r, y1, b], [x0, y1 - r, 0], [x0, y0 + r, b]];
}

/**
 * Drawing context for a symbol in its local frame (inches, origin at the
 * symbol's insertion point, canonical orientation). Applies scale, mirror
 * (about local y axis) and rotation; text stays upright.
 */
class SymCtx {
  constructor(sheet, x, y, rot = 0, flip = false, s = 1) {
    Object.assign(this, { sheet, ox: x, oy: y, rot, flip, s });
    this.layer = "SYMBOL";
  }
  P(x, y) {
    const [rx, ry] = rotVec((this.flip ? -x : x) * this.s, y * this.s, this.rot);
    return [this.ox + rx, this.oy + ry];
  }
  _pts(pts) {
    return pts.map(([x, y, b]) => [...this.P(x, y), (b || 0) * (this.flip ? -1 : 1)]);
  }
  line(x0, y0, x1, y1, layer = this.layer) {
    const [a, b] = this.P(x0, y0), [c, d] = this.P(x1, y1);
    this.sheet.line(a, b, c, d, layer);
  }
  poly(pts, closed = false, layer = this.layer) { this.sheet.poly(this._pts(pts), layer, closed); }
  rect(x0, y0, x1, y1, r = 0, layer = this.layer) { this.poly(rectPts(x0, y0, x1, y1, r), true, layer); }
  circle(x, y, r, layer = this.layer) { const [a, b] = this.P(x, y); this.sheet.circle(a, b, r * this.s, layer); }
  fill(pts) { this.sheet.fill(this._pts(pts)); }
  dot(x, y, r) { this.fill([[x - r, y, 1], [x + r, y, 1]]); }
  /** Upright text at a local position. */
  text(s, x, y, h, align = "MC", bold = false, layer = "TEXT") {
    const [a, b] = this.P(x, y);
    this.sheet.text(s, a, b, Math.max(0.05, h * this.s), align, layer, bold);
  }
  /** Text fitted to a local width (single line, shrinks to fit). */
  fitText(s, x, y, w, h, bold = false) {
    if (!s) return;
    const ws = this.sheet.width(s, 1, bold);
    this.text(s, x, y, Math.min(h, (w / ws) || h), "MC", bold);
  }
}
