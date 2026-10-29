/* =========================================================================
 * Rendering: the laid-out tree fitted onto a page, as drawing entities in
 * page inches (y up) for SVG, PNG and DXF output.
 * ========================================================================= */

const PAGES = {
  letter: [8.5, 11, "Letter (8.5×11)"], legal: [8.5, 14, "Legal (8.5×14)"], tabloid: [11, 17, "Tabloid / ANSI B (11×17)"],
  ansic: [17, 22, "ANSI C (17×22)"], a4: [8.27, 11.69, "A4"], a3: [11.69, 16.54, "A3"],
};
const MARGIN = 0.5;

class Sheet {
  constructor(font) { this.ents = []; this.font = font; this.owner = "sheet"; }
  _push(e) { e.owner = this.owner; this.ents.push(e); }
  /** o: {layer, color, lw (points), dash: "dashed" | "dotted"} */
  line(x0, y0, x1, y1, o = {}) { this._push({ t: "line", x0, y0, x1, y1, ...o }); }
  /** pts: [[x, y, bulge?]...], the bulge applies to the segment leaving that vertex. */
  poly(pts, closed, o = {}) { this._push({ t: "poly", pts: pts.map((p) => [p[0], p[1], p[2] || 0]), closed, ...o }); }
  fill(pts, o = {}) { this._push({ t: "fill", pts: pts.map((p) => [p[0], p[1], p[2] || 0]), ...o }); }
  /** align: vertical (T/M/B, of the cap height) + horizontal (L/C/R). o: {layer, bold, italic, color, rot (deg CCW), halo} */
  text(s, x, y, h, align = "MC", o = {}) { if (s !== "" && s != null) this._push({ t: "text", s: String(s), x, y, h, align, ...o }); }
}

function rectPts(x0, y0, x1, y1, r = 0) {
  r = Math.min(r, (x1 - x0) / 2.0001, (y1 - y0) / 2.0001);
  if (r <= 1e-6) return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const b = 0.41421356;   // tan(22.5 deg): a 90 deg fillet
  return [[x0 + r, y0, 0], [x1 - r, y0, b], [x1, y0 + r, 0], [x1, y1 - r, b],
          [x1 - r, y1, 0], [x0 + r, y1, b], [x0, y1 - r, 0], [x0, y0 + r, b]];
}

function pageSize(S) {
  const [w, h] = PAGES[S.page] || PAGES.letter;
  return S.orient === "landscape" ? [h, w] : [w, h];
}

/** Settings as drawn: phylograms always use the labels style. */
const effective = (S) => (S.layout === "phylogram" ? { ...S, nodeStyle: "labels" } : S);

/**
 * Render a document. Returns {sheet, W, H, P, info: {scale, textPt, nodes, leaves}, messages}.
 */
function renderDoc(doc) {
  const S = effective(doc.s);
  const font = FONTS[S.font] || FONTS[DEFAULT_FONT];
  const [W, H] = pageSize(S);
  const sh = new Sheet(font);
  const P = parseOutline(doc.text);
  const messages = [...P.messages];

  // header and footnote
  let top = H - MARGIN, bottom = MARGIN;
  sh.owner = "title";
  if (S.title.trim()) { sh.text(S.title.trim(), W / 2, top, 0.15, "TC", { layer: "TITLE", bold: true }); top -= 0.15 + 0.1; }
  if (S.subtitle.trim()) { sh.text(S.subtitle.trim(), W / 2, top, 0.085, "TC", { layer: "TEXT-MINOR" }); top -= 0.085 + 0.08; }
  if (S.title.trim() || S.subtitle.trim()) top -= 0.14;
  if (S.footnote.trim()) { sh.text(S.footnote.trim(), MARGIN, bottom, 0.065, "BL", { layer: "TEXT-MINOR" }); bottom += 0.065 + 0.16; }
  sh.owner = "sheet";

  const info = { scale: 1, textPt: S.textSize, nodes: P.nodes.length, leaves: P.nodes.filter((n) => !n.children.length).length };
  if (!P.nodes.length) {
    messages.push({ lvl: "info", msg: "Type an outline on the left: one line per box, indent to make children." });
    return { sheet: sh, W, H, P, info, messages };
  }

  const phylo = S.layout === "phylogram";
  const barRoom = phylo ? 0.75 : 0;
  const ax0 = MARGIN + barRoom, aw = W - MARGIN - ax0, ah = top - bottom;
  let L = layoutTree(P, S, font);
  let bw = L.bbox[2] - L.bbox[0], bh = L.bbox[3] - L.bbox[1];
  let s = Math.min(1, aw / bw, phylo ? Infinity : ah / bh);
  if (phylo) {
    // depth fills the page: leaves' branch ends plus their labels must fit
    const maxD = Math.max(...P.nodes.map((n) => n.dist));
    const solveK = () => {
      if (maxD <= 0) return 0;
      let k = Infinity;
      for (const n of P.nodes) {
        if (!n.leaf) continue;
        const d = S.alignLabels ? maxD : n.dist;
        if (d > 0) k = Math.min(k, (ah / s - n.h) / d);
      }
      return k;
    };
    let K = solveK();
    while (maxD > 0 && K * maxD < 0.35 * ah / s && s > 0.05) { s *= 0.92; K = solveK(); }
    L = layoutTree(P, S, font, { measured: true, K: Math.max(K, 0) });
  } else if (S.fill && bh * s < ah - 0.01 && L.nRows > 1) {
    const vGap = Math.min(S.vGap * 8, S.vGap + (ah / s - bh) / (L.nRows - 1));
    L = layoutTree(P, S, font, { measured: true, vGap });
  }
  bw = L.bbox[2] - L.bbox[0]; bh = L.bbox[3] - L.bbox[1];
  s = Math.min(s, aw / bw, ah / bh);
  info.scale = s;
  info.textPt = S.textSize * s;
  if (info.textPt < 5.95) {
    messages.push({ lvl: "warn", msg: `Text is shrunk to ${info.textPt.toFixed(1)} pt to fit the page. Try a larger page, landscape, narrower boxes${S.nodeStyle === "labels" ? ", vertical leaf labels" : ""}, or a smaller text size setting.` });
  }

  const ox = ax0 + (aw - bw * s) / 2 - L.bbox[0] * s, oy = top + L.bbox[1] * s;
  const X = (x) => ox + x * s, Y = (y) => oy - y * s;
  const M = L.M;
  const cap = M.cap * s, dcap = M.dcap * s;
  const lw = S.lineWeight;
  const colorOf = (n) => (n ? n.color || colorOf(n.parent) : null);
  const boxes = S.nodeStyle === "boxes";

  // connectors
  for (const p of P.nodes) {
    if (!p.children.length) continue;
    sh.owner = p.id;
    const pc = colorOf(p);
    const px = X(p.x);
    const pb = boxes ? Y(p.y + p.h) : Y(p.y);
    const yb = Y(L.barY(p));
    const kids = p.children.map((c) => ({ c, x: X(c.x), top: Y(c.y), col: colorOf(c) }));
    if (S.connector === "straight") {
      for (const k of kids) {
        sh.owner = k.c.id;
        sh.line(px, pb, k.x, k.top, { layer: k.c.dashed ? "BRANCH-DASHED" : "BRANCH", color: k.col, lw, dash: k.c.dashed ? "dashed" : null });
      }
    } else {
      if (boxes && pb - yb > 1e-6) sh.line(px, pb, px, yb, { layer: "BRANCH", color: pc, lw });
      const xs = kids.map((k) => k.x);
      const lo = Math.min(px, ...xs), hi = Math.max(px, ...xs);
      const r = S.connector === "rounded" ? Math.min(cap * 1.4, ...kids.map((k) => Math.max(0, yb - k.top))) : 0;
      const stops = [...new Set([lo, hi, px, ...xs].map((v) => +v.toFixed(6)))].sort((a, b) => a - b);
      for (let i = 1; i < stops.length; i++) {
        let a = stops[i - 1], b = stops[i];
        if (r > 0 && i === 1 && a < px - 1e-6) a += r;
        if (r > 0 && i === stops.length - 1 && b > px + 1e-6) b -= r;
        if (b - a > 1e-6) sh.line(a, yb, b, yb, { layer: "BRANCH", color: pc, lw });
      }
      for (const k of kids) {
        sh.owner = k.c.id;
        const o = { layer: k.c.dashed ? "BRANCH-DASHED" : "BRANCH", color: k.col, lw, dash: k.c.dashed ? "dashed" : null };
        const outerL = r > 0 && Math.abs(k.x - lo) < 1e-6 && k.x < px - 1e-6;
        const outerR = r > 0 && Math.abs(k.x - hi) < 1e-6 && k.x > px + 1e-6;
        if (outerL) sh.poly([[k.x + r, yb, 0.41421356], [k.x, yb - r], [k.x, k.top]], false, o);
        else if (outerR) sh.poly([[k.x - r, yb, -0.41421356], [k.x, yb - r], [k.x, k.top]], false, o);
        else if (yb - k.top > 1e-6) sh.line(k.x, yb, k.x, k.top, o);
      }
    }
    // labels on the branches coming into each child
    for (const k of kids) {
      if (!k.c.edge) continue;
      sh.owner = k.c.id;
      const y0 = S.connector === "straight" ? (pb + k.top) / 2 : (yb + k.top) / 2;
      const x0 = S.connector === "straight" ? (px + k.x) / 2 : k.x;
      sh.text(k.c.edge, x0 + cap * 0.5, y0, dcap, "ML", { layer: "LABEL", color: k.col, halo: true, bold: true });
    }
  }

  // labels style: a short stem above each root
  if (!boxes) {
    for (const root of P.roots) {
      if (!root.children.length) continue;
      sh.owner = root.id;
      sh.line(X(root.x), Y(root.y), X(root.x), Y(root.y) + cap * 2.6, { layer: "BRANCH", color: colorOf(root), lw });
    }
  }

  // nodes
  for (const n of P.nodes) {
    sh.owner = n.id;
    const col = colorOf(n);
    const x = X(n.x);
    if (boxes) {
      const x0 = X(n.x - n.w / 2), x1 = X(n.x + n.w / 2), y1 = Y(n.y), y0 = Y(n.y + n.h);
      if (n.shapeUsed !== "plain") {
        const r = n.shapeUsed === "pill" ? (y1 - y0) / 2 : n.shapeUsed === "box" ? 0 : Math.min(cap * 0.9, (y1 - y0) / 2);
        const pts = rectPts(x0, y0, x1, y1, r);
        sh.fill(pts, { color: col || "#ffffff", opacity: col ? 0.1 : 1, layer: "NODE-FILL" });
        sh.poly(pts, true, { layer: "NODE", color: col, lw: lw * 1.1, dash: n.dashed ? "dashed" : null });
      }
      const block = blockH(n.lines.length, cap, M.pitch * s) +
        (n.dlines.length ? (n.lines.length ? cap * 0.75 : 0) + blockH(n.dlines.length, dcap, M.dpitch * s) : 0);
      let ty = (y0 + y1) / 2 + block / 2;
      for (const ln of n.lines) { sh.text(ln, x, ty, cap, "TC", { layer: "TEXT", bold: n.bold, italic: n.italic }); ty -= M.pitch * s; }
      if (n.dlines.length) {
        if (n.lines.length) ty += M.pitch * s - cap - cap * 0.75;
        for (const ln of n.dlines) { sh.text(ln, x, ty, dcap, "TC", { layer: "TEXT-MINOR" }); ty -= M.dpitch * s; }
      }
    } else if (n.leaf) {
      const yEnd = Y(n.y), yLab = Y(n.labelY);
      if (yLab < yEnd - 1e-6) sh.line(x, yEnd, x, yLab, { layer: "LEADER", color: "#9aa0a8", lw: lw * 0.6, dash: "dotted" });
      let ty = yLab - M.gapLabel * s;
      if (S.leafLabels === "vertical") {
        if (n.lines.length) sh.text(n.lines[0], x, ty, cap, "ML", { layer: "TEXT", bold: n.bold, italic: n.italic, rot: -90, color: col });
      } else {
        for (const ln of n.lines) { sh.text(ln, x, ty, cap, "TC", { layer: "TEXT", bold: n.bold, italic: n.italic, color: col }); ty -= M.pitch * s; }
        if (n.dlines.length) {
          if (n.lines.length) ty += M.pitch * s - cap - cap * 0.6;
          for (const ln of n.dlines) { sh.text(ln, x, ty, dcap, "TC", { layer: "TEXT-MINOR" }); ty -= M.dpitch * s; }
        }
      }
    } else if (n.lines.length) {
      sh.text(n.lines[0], x - cap * 0.45, Y(n.y) + cap * (n.parent ? 0.45 : 1.4), dcap, "BR", { layer: "LABEL", italic: n.italic, bold: n.bold, color: col || "#555b63" });
    }
  }

  // where each node ended up on the page (checks, hit areas)
  const rects = new Map();
  for (const n of P.nodes) {
    if (boxes) rects.set(n.id, [X(n.x - n.w / 2), Y(n.y + n.h), X(n.x + n.w / 2), Y(n.y)]);
    else if (n.leaf) rects.set(n.id, [X(n.x - n.w / 2), Y(n.labelY + n.h), X(n.x + n.w / 2), Y(n.labelY + M.gapLabel)]);
    else rects.set(n.id, [X(n.x), Y(n.y), X(n.x), Y(n.y)]);
  }

  // phylogram scale bar, left of the tree
  if (phylo && L.K > 0) {
    sh.owner = "scale";
    const perIn = 1 / (L.K * s);
    const unitLen = niceStep(perIn * 0.9);
    const len = unitLen * L.K * s;
    const bx = X(L.bbox[0]) - 0.4, by = Y(Math.min(...P.roots.map((r) => r.y)));
    sh.line(bx, by, bx, by - len, { layer: "SCALE", lw: lw * 1.2 });
    for (const yy of [by, by - len]) sh.line(bx - 0.04, yy, bx + 0.04, yy, { layer: "SCALE", lw: lw * 1.2 });
    sh.text(`${+unitLen.toPrecision(6)}${S.unit.trim() ? " " + S.unit.trim() : ""}`, bx - 0.07, by - len / 2, 0.075, "BC", { layer: "TEXT-MINOR", rot: 90 });
  }
  sh.owner = "sheet";
  return { sheet: sh, W, H, P, info, messages, rects };
}
