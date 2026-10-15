/* =========================================================================
 * Render a document to a Sheet (border, title block, notes, nodes, edges).
 * ========================================================================= */

const TYPE_TITLE = { oneline: "ONE-LINE DIAGRAM", pid: "PIPING & INSTRUMENTATION DIAGRAM" };

function drawBorder(sh) {
  sh.rect(FRAME, FRAME, SHEET_W - FRAME, SHEET_H - FRAME, "FRAME-THIN");
  sh.rect(IX0, IY0, IX1, IY1, "FRAME");
  // zones: numbers right-to-left, letters bottom-to-top (ASME Y14.1 style)
  const ncol = 8, nrow = 4;
  const zw = (SHEET_W - 2 * FRAME) / ncol, zh = (SHEET_H - 2 * FRAME) / nrow;
  for (let i = 0; i < ncol; i++) {
    const x0 = SHEET_W - FRAME - (i + 1) * zw;
    if (i < ncol - 1) {
      sh.line(x0, FRAME, x0, IY0, "FRAME-THIN");
      sh.line(x0, IY1, x0, SHEET_H - FRAME, "FRAME-THIN");
    }
    for (const yc of [FRAME + BAND / 2, SHEET_H - FRAME - BAND / 2]) sh.text(String(i + 1), x0 + zw / 2, yc, 0.11);
  }
  for (let j = 0; j < nrow; j++) {
    const y0 = FRAME + j * zh;
    if (j) {
      sh.line(FRAME, y0, IX0, y0, "FRAME-THIN");
      sh.line(IX1, y0, SHEET_W - FRAME, y0, "FRAME-THIN");
    }
    for (const xc of [FRAME + BAND / 2, SHEET_W - FRAME - BAND / 2]) sh.text("ABCD"[j], xc, y0 + zh / 2, 0.11);
  }
}

function cell(sh, x0, y0, x1, y1, label, value, { vh = 0.11, bold = false, align = "left", maxLines = 2 } = {}) {
  sh.text(label, x0 + 0.05, y1 - 0.05, 0.055, "TL", "TEXT-MINOR");
  sh.textBox(value, x0, y0, x1, y1 - 0.09, vh, { hMin: 0.06, align, bold, maxLines });
}

function drawTitleBlock(sh, doc) {
  const tb = doc.titleblock;
  const up = (v, def = "") => String(v || def).toUpperCase();
  const x0 = IX1 - TB_W, y0 = IY0, x1 = IX1, y1 = IY0 + TB_H;
  sh.rect(x0, y0, x1, y1, "TITLE");
  const ys = [y1];
  for (const h of [0.40, 0.45, 0.35, 0.35]) ys.push(ys[ys.length - 1] - h);
  for (const y of ys.slice(1, -1)) sh.line(x0, y, x1, y, "TITLE-GRID");
  cell(sh, x0, ys[1], x1, ys[0], "PROJECT / PROPERTY", up(tb.project), { vh: 0.14, bold: true, maxLines: 1 });
  cell(sh, x0, ys[2], x1, ys[1], "DRAWING TITLE", up(tb.title, `${doc.name} — ${TYPE_TITLE[doc.type]}`),
       { vh: 0.13, bold: true });
  const k = TB_W / 4.6;
  const row3 = [["DRAWN BY", up(tb.drawn_by), 1.6], ["DATE", tb.date || isoToday(), 1.5], ["SCALE", up(tb.scale, "NONE"), 1.5]];
  const row4 = [["SIZE", "B", 0.55], ["DWG NO.", up(tb.dwg_no), 2.15], ["REV", up(tb.rev), 0.55], ["SHEET", up(tb.sheet, "1 OF 1"), 1.35]];
  for (const [row, ya, yb] of [[row3, ys[3], ys[2]], [row4, ys[4], ys[3]]]) {
    let x = x0;
    row.forEach(([lab, val, w], i) => {
      w *= k;
      if (i) sh.line(x, ya, x, yb, "TITLE-GRID");
      cell(sh, x, ya, x + w, yb, lab, val, { vh: lab === "SIZE" ? 0.15 : 0.11, align: "center", maxLines: 1,
                                             bold: lab === "SIZE" || lab === "REV" });
      x += w;
    });
  }
}

/** Notes layout (shared with auto-layout): returns {top, h, blocks}. */
function notesLayout(doc, sh) {
  const notes = doc.notes.filter((n) => String(n).trim());
  if (!notes.length) return { top: IY0 + TB_H, blocks: [], h: TEXT_H.line };
  sh = sh || new Sheet(docFont(doc));
  const w = TB_W - 0.25 - 0.2;
  let h = 0.09;
  const lay = () => {
    const blocks = notes.map((n) => sh.wrap(n, w, h));
    return [blocks, 0.28 + blocks.reduce((a, b) => a + b.length, 0) * h * LINE_SPACING + 0.06];
  };
  let [blocks, need] = lay();
  while (need > 3.5 && h > 0.065) { h -= 0.005; [blocks, need] = lay(); }
  return { top: IY0 + TB_H + need, blocks, h };
}

function drawNotes(sh, doc) {
  const L = notesLayout(doc, sh);
  if (!L.blocks.length) return L.top;
  const x0 = IX1 - TB_W, x1 = IX1, y0 = IY0 + TB_H, y1 = L.top;
  sh.rect(x0, y0, x1, y1, "TITLE");
  sh.text("NOTES", x0 + 0.08, y1 - 0.08, 0.085, "TL", "TEXT", true);
  let y = y1 - 0.28 - L.h / 2;
  L.blocks.forEach((blk, i) => {
    sh.text(`${i + 1}.`, x0 + 0.1, y, L.h, "ML");
    for (const ln of blk) { sh.text(ln, x0 + 0.35, y, L.h, "ML"); y -= L.h * LINE_SPACING; }
  });
  return L.top;
}

// ------------------------------------------------------------------- nodes
function drawNode(sh, doc, n, g) {
  sh.owner = n.id;
  const ctx = new SymCtx(sh, n.x, n.y, n.rot, n.flip, g.s);
  g.sym.draw(ctx, n, doc);
  if (g.label) {
    const L = g.label;
    let y = L.top;
    L.lines.forEach((l) => {
      sh.text(l.s, L.x, y, l.h, "T" + L.align, "TEXT", l.bold);
      y -= l.h * LINE_SPACING;
    });
  }
  sh.owner = "sheet";
}

// ------------------------------------------------------------------- edges
function edgeLayer(e) { return EDGE_STYLES[e.style]?.layer || "WIRE"; }

/** Straight-line fallback path between two ends (used before routing). */
function provisionalPath(doc, e, geoms) {
  const ga = geoms.get(e.from.n), gb = geoms.get(e.to.n);
  if (!ga || !gb) return null;
  const pb0 = portOf(gb, e.to.p);
  const a = endPoint(ga, e.from.p, [pb0.x, pb0.y]);
  const b = endPoint(gb, e.to.p, [a.x, a.y]);
  const s = 0.125;
  const a1 = [a.x + a.dir[0] * s, a.y + a.dir[1] * s], b1 = [b.x + b.dir[0] * s, b.y + b.dir[1] * s];
  const pts = [[a.x, a.y], a1];
  if (Math.abs(a.dir[0]) > 0) pts.push([(a1[0] + b1[0]) / 2, a1[1]], [(a1[0] + b1[0]) / 2, b1[1]]);
  else pts.push([a1[0], (a1[1] + b1[1]) / 2], [b1[0], (a1[1] + b1[1]) / 2]);
  pts.push(b1, [b.x, b.y]);
  return simplifyPath(pts);
}

function simplifyPath(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q[0] - p[0]) < 2e-3 && Math.abs(q[1] - p[1]) < 2e-3) continue;
    out.push([round4(p[0]), round4(p[1])]);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const e = 2e-3;
      const col = (Math.abs(a[0] - b[0]) < e && Math.abs(b[0] - c[0]) < e) ||
                  (Math.abs(a[1] - b[1]) < e && Math.abs(b[1] - c[1]) < e);
      if (!col) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

/** Find crossings between edges; returns Map edgeId -> [{seg, x, y}] marks to draw. */
function findCrossings(doc, paths) {
  const marks = new Map();
  if (doc.crossing === "none") return marks;
  const segs = [];
  for (const e of doc.edges) {
    const pts = paths.get(e.id);
    if (!pts) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      const horiz = Math.abs(a[1] - b[1]) < 1e-6;
      segs.push({ e, i, horiz, a, b, rank: LINE_WEIGHT_RANK(e.style) });
    }
  }
  const H = segs.filter((s) => s.horiz), V = segs.filter((s) => !s.horiz);
  const eps = 0.06;
  for (const h of H) {
    const [hx0, hx1] = [Math.min(h.a[0], h.b[0]), Math.max(h.a[0], h.b[0])];
    const y = h.a[1];
    for (const v of V) {
      if (v.e === h.e) continue;
      const x = v.a[0];
      const [vy0, vy1] = [Math.min(v.a[1], v.b[1]), Math.max(v.a[1], v.b[1])];
      if (x <= hx0 + eps || x >= hx1 - eps || y <= vy0 + eps || y >= vy1 - eps) continue;
      // the lighter line yields; on a tie: hop on the horizontal, gap in the vertical
      let who;
      if (h.rank !== v.rank) who = h.rank < v.rank ? h : v;
      else who = doc.crossing === "hop" ? h : v;
      if (!marks.has(who.e.id)) marks.set(who.e.id, []);
      marks.get(who.e.id).push({ seg: who.i, x, y });
    }
  }
  return marks;
}

/** Split a path into polylines with hops / gaps at the crossing marks. */
function pathWithCrossings(pts, marks, mode) {
  const r = 0.05;
  if (!marks || !marks.length) return [pts.map((p) => [p[0], p[1], 0])];
  const out = [];
  let cur = [[pts[0][0], pts[0][1], 0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const ms = marks.filter((m) => m.seg === i)
      .map((m) => ({ ...m, t: (m.x - a[0]) * u[0] + (m.y - a[1]) * u[1] }))
      .filter((m) => m.t > r && m.t < L - r)
      .sort((p, q) => p.t - q.t);
    let lastT = -1;
    for (const m of ms) {
      if (m.t - lastT < 2 * r + 0.02) continue;
      lastT = m.t;
      const p0 = [m.x - u[0] * r, m.y - u[1] * r], p1 = [m.x + u[0] * r, m.y + u[1] * r];
      if (mode === "hop") {
        // arc on the upper side (or left side for vertical runs)
        const up = Math.abs(u[1]) < 0.5 ? (u[0] > 0 ? -1 : 1) : (u[1] > 0 ? 1 : -1);
        cur.push([p0[0], p0[1], up]);
        cur.push([p1[0], p1[1], 0]);
      } else {
        cur.push([p0[0], p0[1], 0]);
        out.push(cur);
        cur = [[p1[0], p1[1], 0]];
      }
    }
    cur.push([b[0], b[1], 0]);
  }
  out.push(cur);
  return out;
}

function pointsAlong(pts, step, skip) {
  const res = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  const n = Math.floor((total - 2 * skip) / step);
  if (n < 1) {
    if (total > 0.3) return pointsAt(pts, [total / 2]);
    return res;
  }
  const start = (total - (n - 1) * step) / 2;
  return pointsAt(pts, Array.from({ length: n }, (_, k) => start + k * step));
}

function pointsAt(pts, dists) {
  const res = [];
  let acc = 0, j = 0;
  for (let i = 0; i < pts.length - 1 && j < dists.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (j < dists.length && dists[j] <= acc + L + 1e-9) {
      const t = (dists[j] - acc) / L;
      res.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, u: [(b[0] - a[0]) / L, (b[1] - a[1]) / L] });
      j++;
    }
    acc += L;
  }
  return res;
}

function longestSegment(pts) {
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (!best || L > best.L + 1e-6) best = { i, L, a: pts[i], b: pts[i + 1] };
  }
  return best;
}

/**
 * Placement of an edge label: {lines, x, top, align, box}. Tries each segment
 * (longest first) on both sides and takes the first spot clear of `avoid`
 * rectangles (symbols, other labels); falls back to the longest segment.
 */
function edgeLabelLayout(doc, e, pts, avoid = []) {
  const text = String(e.label || "").trim();
  if (!text || !pts || pts.length < 2) return null;
  const font = docFont(doc);
  const lines = text.split("\n").map((t) => t.trim()).filter(Boolean)
    .map((t) => (doc.uppercase ? t.toUpperCase() : t));
  const h = TEXT_H.edge;
  const W = Math.max(...lines.map((l) => textWidth(l, h, false, font)));
  const H = lines.length * h * LINE_SPACING - h * (LINE_SPACING - 1);
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    segs.push({ a, b, L: Math.hypot(b[0] - a[0], b[1] - a[1]), vertical: Math.abs(a[0] - b[0]) < 1e-6 });
  }
  segs.sort((p, q) => q.L - p.L);
  const place = (sg, side) => {
    const mx = (sg.a[0] + sg.b[0]) / 2, my = (sg.a[1] + sg.b[1]) / 2;
    if (sg.vertical) {
      const x = side > 0 ? mx + 0.07 : mx - 0.07, top = my + H / 2;
      return { lines, h, x, top, align: side > 0 ? "L" : "R", box: side > 0 ? [x, top - H, x + W, top] : [x - W, top - H, x, top] };
    }
    const top = side > 0 ? my + 0.07 + H : my - 0.07;
    return { lines, h, x: mx, top, align: "C", box: [mx - W / 2, top - H, mx + W / 2, top] };
  };
  const fits = (sg) => (sg.vertical ? sg.L >= H + 0.1 : sg.L >= W + 0.1);
  const clear = (lab) => !avoid.some((r) => R.overlaps(R.inflate(lab.box, 0.03), r));
  for (const sg of segs.filter(fits)) {
    for (const side of [1, -1]) {
      const lab = place(sg, side);
      if (clear(lab)) return lab;
    }
  }
  return place(segs[0], 1);
}

function drawEdge(sh, doc, e, pts, marks, avoid = []) {
  sh.owner = e.id;
  const style = EDGE_STYLES[e.style] || EDGE_STYLES.power;
  const layer = style.layer;
  for (const piece of pathWithCrossings(pts, marks, doc.crossing)) {
    if (piece.length >= 2) sh.poly(piece, layer);
  }
  // decorations (pneumatic //, capillary x, data o)
  if (style.deco) {
    for (const p of pointsAlong(pts, 0.375, 0.2)) {
      const [ux, uy] = p.u, [nx, ny] = [-uy, ux];
      const d = 0.05;
      if (style.deco === "slash") {
        for (const off of [-0.025, 0.025]) {
          const cx = p.x + ux * off, cy = p.y + uy * off;
          sh.line(cx - (nx + ux) * d * 0.7, cy - (ny + uy) * d * 0.7, cx + (nx + ux) * d * 0.7, cy + (ny + uy) * d * 0.7, layer);
        }
      } else if (style.deco === "x") {
        sh.line(p.x - (nx + ux) * d * 0.6, p.y - (ny + uy) * d * 0.6, p.x + (nx + ux) * d * 0.6, p.y + (ny + uy) * d * 0.6, layer);
        sh.line(p.x - (nx - ux) * d * 0.6, p.y - (ny - uy) * d * 0.6, p.x + (nx - ux) * d * 0.6, p.y + (ny - uy) * d * 0.6, layer);
      } else if (style.deco === "o") {
        sh.circle(p.x, p.y, 0.025, layer);
      }
    }
  }
  // flow arrows
  const head = (x, y, ux, uy) => {
    const len = 0.1, half = 0.04, nx = -uy, ny = ux;
    sh.fill([[x, y], [x - ux * len + nx * half, y - uy * len + ny * half], [x - ux * len - nx * half, y - uy * len - ny * half]]);
  };
  if (e.arrow === "end" && pts.length >= 2) {
    const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L > 1e-6) head(b[0], b[1], (b[0] - a[0]) / L, (b[1] - a[1]) / L);
  } else if (e.arrow === "mid") {
    const seg = longestSegment(pts);
    if (seg && seg.L > 0.25) {
      const ux = (seg.b[0] - seg.a[0]) / seg.L, uy = (seg.b[1] - seg.a[1]) / seg.L;
      head((seg.a[0] + seg.b[0]) / 2 + ux * 0.05, (seg.a[1] + seg.b[1]) / 2 + uy * 0.05, ux, uy);
    }
  }
  const lab = edgeLabelLayout(doc, e, pts, avoid);
  if (lab) {
    if (avoid) avoid.push(lab.box);
    let y = lab.top;
    for (const l of lab.lines) { sh.text(l, lab.x, y, lab.h, "T" + lab.align, "LABEL"); y -= lab.h * LINE_SPACING; }
  }
  sh.owner = "sheet";
}

/** Path to draw for every edge: its routed points, or a provisional path. */
function edgePaths(doc, geoms) {
  const m = new Map();
  for (const e of doc.edges) m.set(e.id, e.pts && e.pts.length >= 2 ? e.pts : provisionalPath(doc, e, geoms));
  return m;
}

/** Rectangles edge labels must keep clear of: symbols and their labels. */
function labelObstacles(doc, geoms) {
  return doc.nodes.map((n) => geoms.get(n.id)?.outer).filter(Boolean);
}

/** Build the whole sheet. */
function renderDoc(doc, { geoms } = {}) {
  geoms = geoms || allGeoms(doc);
  const sh = new Sheet(docFont(doc));
  drawBorder(sh);
  drawTitleBlock(sh, doc);
  drawNotes(sh, doc);
  const paths = edgePaths(doc, geoms);
  const marks = findCrossings(doc, paths);
  const avoid = labelObstacles(doc, geoms);
  for (const e of doc.edges) {
    const pts = paths.get(e.id);
    if (pts) drawEdge(sh, doc, e, pts, marks.get(e.id), avoid);
  }
  for (const n of doc.nodes) drawNode(sh, doc, n, geoms.get(n.id));
  return { sheet: sh, geoms, paths };
}
