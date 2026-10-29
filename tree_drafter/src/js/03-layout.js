/* =========================================================================
 * Layout, in inches at full text size, x to the right and y DOWN.
 *
 *   flowchart   compact tidy tree: subtrees packed as closely as their
 *               outlines allow, one row per level
 *   dendrogram  one slot per leaf across the page, parents centred over
 *               their children, one row per level
 *   cladogram   as dendrogram, but every leaf on the bottom row
 *   phylogram   as dendrogram, but depth is the sum of branch lengths
 *
 * Node styles: "boxes" (every node a box) or "labels" (internal nodes are
 * junctions, leaves are labels under the branch ends; the usual look of a
 * phylogenetic tree).
 *
 * A node's (x, y): x is its centre; y is the top of its box, or the
 * junction / branch end in labels style.
 * ========================================================================= */

const LAYOUTS = {
  flowchart: "Flowchart (compact)",
  dendrogram: "Dendrogram (levels)",
  cladogram: "Cladogram (leaves aligned)",
  phylogram: "Phylogram (branch lengths)",
};

function textMetrics(S, font) {
  const cap = (S.textSize / 72) * font.cap;
  return { cap, dcap: cap * 0.82, pitch: cap * LINE_SPACING, dpitch: cap * 0.82 * LINE_SPACING,
           padX: cap * 1.0, padY: cap * 0.85, gapLabel: cap * 0.75 };
}
const blockH = (k, cap, pitch) => (k ? cap + (k - 1) * pitch : 0);

/** Text lines and sizes of every node. */
function measureNodes(P, S, font, M) {
  const boxes = S.nodeStyle === "boxes";
  for (const n of P.nodes) {
    n.leaf = !n.children.length;
    n.bold = n.bold || (boxes && !n.parent);
    n.ew = n.edge ? textWidth(n.edge, M.dcap, false, font) + M.cap * 0.8 : 0;
    const widths = (lines, h, bold) => lines.map((l) => textWidth(l, h, bold, font));
    if (boxes) {
      const inner = Math.max(S.boxWidth - 2 * M.padX, M.cap * 4);
      n.lines = n.label ? wrapText(n.label, inner, M.cap, n.bold, font) : [];
      n.dlines = n.detail ? wrapText(n.detail, inner, M.dcap, false, font) : [];
      const tw = Math.max(0, ...widths(n.lines, M.cap, n.bold), ...widths(n.dlines, M.dcap, false));
      const th = blockH(n.lines.length, M.cap, M.pitch) +
        (n.dlines.length ? (n.lines.length ? M.cap * 0.75 : 0) + blockH(n.dlines.length, M.dcap, M.dpitch) : 0);
      n.shapeUsed = n.shape || "round";
      if (n.shapeUsed === "plain") { n.w = Math.max(tw, M.cap); n.h = Math.max(th, M.cap); }
      else {
        n.h = Math.max(th + 2 * M.padY, M.cap + 2 * M.padY);
        n.w = Math.max(tw + 2 * M.padX, M.cap * 3) + (n.shapeUsed === "pill" ? n.h * 0.35 : 0);
      }
    } else if (n.leaf) {
      if (S.leafLabels === "vertical") {
        n.lines = n.label || n.detail ? [[n.label, n.detail].filter(Boolean).join("  ").replace(/\n/g, " ")] : [];
        n.dlines = [];
        n.w = n.lines.length ? M.pitch : M.cap;
        n.h = M.gapLabel + (n.lines.length ? textWidth(n.lines[0], M.cap, n.bold, font) : 0);
      } else {
        n.lines = n.label ? wrapText(n.label, S.boxWidth, M.cap, n.bold, font) : [];
        n.dlines = n.detail ? wrapText(n.detail, S.boxWidth, M.dcap, false, font) : [];
        const tw = Math.max(M.cap, ...widths(n.lines, M.cap, n.bold), ...widths(n.dlines, M.dcap, false));
        n.w = tw;
        n.h = M.gapLabel + blockH(n.lines.length, M.cap, M.pitch) +
          (n.dlines.length ? (n.lines.length ? M.cap * 0.6 : 0) + blockH(n.dlines.length, M.dcap, M.dpitch) : 0);
      }
    } else {
      // a junction; its own label is drawn small beside it
      n.lines = n.label ? [n.label.replace(/\n/g, " ")] : [];
      n.dlines = [];
      n.w = 0; n.h = 0;
    }
  }
}

/** Depth along the branches: the sum of lengths (missing = 1). */
function branchDistances(P) {
  const walk = (n, d) => { n.dist = d; n.children.forEach((c) => walk(c, d + Math.max(0, c.len ?? 1))); };
  P.roots.forEach((r) => walk(r, 0));
}

/**
 * Lay the forest out. opts.vGap overrides the row gap; opts.K is inches per
 * branch-length unit (phylogram). Returns {rowTop, rowH, bbox, barY(n), M, K}.
 */
function layoutTree(P, S, font, opts = {}) {
  const M = textMetrics(S, font);
  if (!opts.measured) measureNodes(P, S, font, M);
  const boxes = S.nodeStyle === "boxes";
  const vGap = opts.vGap ?? S.vGap;
  const hGap = S.hGap;

  // levels
  const height = (n) => (n.ht = n.children.length ? 1 + Math.max(...n.children.map(height)) : 0);
  const maxH = Math.max(0, ...P.roots.map(height));
  for (const n of P.nodes) n.row = S.layout === "cladogram" ? maxH - n.ht : n.depth;
  const nRows = Math.max(0, ...P.nodes.map((n) => n.row)) + 1;
  const rowH = new Array(nRows).fill(0);
  if (boxes) for (const n of P.nodes) rowH[n.row] = Math.max(rowH[n.row], n.h);
  const rowTop = [0];
  for (let r = 1; r < nRows; r++) rowTop[r] = rowTop[r - 1] + rowH[r - 1] + vGap;

  // vertical positions
  let K = opts.K;
  if (S.layout === "phylogram") {
    branchDistances(P);
    const maxD = Math.max(0, ...P.nodes.map((n) => n.dist));
    if (K == null) K = maxD > 0 ? ((nRows - 1) * vGap) / maxD : 1;
    for (const n of P.nodes) n.y = n.dist * K;
  } else {
    for (const n of P.nodes) n.y = rowTop[n.row];
  }
  // where leaf labels start (phylogram: optionally all on one line)
  const leaves = P.nodes.filter((n) => n.leaf);
  const alignY = Math.max(0, ...leaves.map((n) => n.y));
  for (const n of P.nodes) n.labelY = !boxes && n.leaf && S.layout === "phylogram" && S.alignLabels ? alignY : n.y;

  if (S.layout === "flowchart") tidyX(P, S, M, rowTop, boxes, hGap);
  else slotX(P, S, boxes, hGap);

  // extents
  let bb = null;
  const add = (x0, y0, x1, y1) => { bb = bb ? [Math.min(bb[0], x0), Math.min(bb[1], y0), Math.max(bb[2], x1), Math.max(bb[3], y1)] : [x0, y0, x1, y1]; };
  for (const n of P.nodes) {
    add(n.x - n.w / 2, n.y, n.x + n.w / 2, (n.leaf || boxes ? n.labelY : n.y) + n.h);
    if (n.ew) add(n.x, n.y - vGap / 2, n.x + n.ew, n.y);
    if (!boxes && !n.parent && !n.leaf) add(n.x, n.y - M.cap * 2.6, n.x, n.y);   // root stem
    if (!boxes && !n.leaf && n.lines.length) add(n.x - textWidth(n.lines[0], M.dcap, false, font) - M.cap * 0.5, n.y - M.dcap * 1.6, n.x, n.y);
  }
  const barY = (n) => (boxes ? (S.layout === "phylogram" ? n.y + n.h + vGap / 2 : rowTop[n.row] + rowH[n.row] + vGap / 2) : n.y);
  return { rowTop, rowH, nRows, bbox: bb || [0, 0, 1, 1], barY, M, K, vGap };
}

/** Space each node takes either side of its centre on its row (an edge label sits right of the drop). */
const halfL = (n) => n.w / 2;
const halfR = (n) => Math.max(n.w / 2, n.ew);

/** Compact tidy layout: pack sibling subtrees by their row-by-row outlines. */
function tidyX(P, S, M, rowTop, boxes, hGap) {
  // rows a node covers: its own, plus rows its hanging label reaches (labels style)
  const rowsOf = (n) => {
    const out = [n.row];
    if (!boxes && n.leaf) for (let r = n.row + 1; r < rowTop.length && rowTop[r] < n.labelY + n.h; r++) out.push(r);
    return out;
  };
  const place = (n) => {
    const own = new Map();
    for (const r of rowsOf(n)) own.set(r, [-halfL(n), halfR(n)]);
    if (!n.children.length) return own;
    const cs = n.children.map(place);
    const offs = [0];
    const acc = new Map(cs[0]);
    for (let i = 1; i < cs.length; i++) {
      let need = -Infinity;
      for (const [r, [l]] of cs[i]) {
        if (!acc.has(r)) continue;
        const gap = r === n.row + 1 ? hGap : hGap * 1.3;
        need = Math.max(need, acc.get(r)[1] + gap - l);
      }
      offs[i] = Number.isFinite(need) ? need : offs[i - 1];
      for (const [r, [l, rr]] of cs[i]) {
        const a = acc.get(r);
        acc.set(r, a ? [Math.min(a[0], l + offs[i]), Math.max(a[1], rr + offs[i])] : [l + offs[i], rr + offs[i]]);
      }
    }
    const mid = (offs[0] + offs[offs.length - 1]) / 2;
    n.children.forEach((c, i) => { c.dx = offs[i] - mid; });
    for (const [r, [l, rr]] of acc) {
      const a = own.get(r);
      own.set(r, a ? [Math.min(a[0], l - mid), Math.max(a[1], rr - mid)] : [l - mid, rr - mid]);
    }
    return own;
  };
  // roots side by side, a wider gap between separate trees
  let accR = null, x = 0;
  for (const root of P.roots) {
    const c = place(root);
    if (accR) {
      let need = -Infinity;
      for (const [r, [l]] of c) if (accR.has(r)) need = Math.max(need, accR.get(r)[1] + hGap * 3 - l);
      x = Number.isFinite(need) ? need : x + hGap * 3;
    }
    root.x = x;
    for (const [r, [l, rr]] of c) {
      const a = accR && accR.get(r);
      (accR || (accR = new Map())).set(r, a ? [Math.min(a[0], l + x), Math.max(a[1], rr + x)] : [l + x, rr + x]);
    }
  }
  const down = (n) => n.children.forEach((c) => { c.x = n.x + c.dx; down(c); });
  P.roots.forEach(down);
}

/** One slot per leaf, parents centred over their children; widen slots until no row overlaps. */
function slotX(P, S, boxes, hGap) {
  const leaves = [], rootOf = new Map();
  const collect = (n, root) => { rootOf.set(n, root); if (n.leaf) leaves.push(n); n.children.forEach((c) => collect(c, root)); };
  P.roots.forEach((r) => collect(r, r));
  const firstLeaf = (n) => (n.leaf ? n : firstLeaf(n.children[0]));
  const extra = new Map();
  for (let pass = 0; pass < 40; pass++) {
    let x = 0, prev = null;
    for (const lf of leaves) {
      if (prev) x += halfR(prev) + hGap * (rootOf.get(prev) === rootOf.get(lf) ? 1 : 3) + (extra.get(lf) || 0) + halfL(lf);
      lf.x = x;
      prev = lf;
    }
    const centre = (n) => {
      if (n.leaf) return;
      n.children.forEach(centre);
      n.x = (n.children[0].x + n.children[n.children.length - 1].x) / 2;
    };
    P.roots.forEach(centre);
    if (!boxes) return;
    // a parent's box can be wider than its children's slots: push the next subtree over
    let changed = false;
    const byRow = new Map();
    const order = [];
    const visit = (n) => { order.push(n); n.children.forEach(visit); };
    P.roots.forEach(visit);
    for (const n of order) { if (!byRow.has(n.row)) byRow.set(n.row, []); byRow.get(n.row).push(n); }
    for (const row of byRow.values()) {
      row.sort((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++) {
        const a = row[i - 1], b = row[i];
        const need = a.x + halfR(a) + hGap - (b.x - halfL(b));
        if (need > 1e-6) {
          const lf = firstLeaf(b);
          extra.set(lf, (extra.get(lf) || 0) + need);
          changed = true;
          break;   // one push per row per pass keeps it stable
        }
      }
    }
    if (!changed) return;
  }
}
