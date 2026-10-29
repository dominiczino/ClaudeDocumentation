/* =========================================================================
 * Interactive editor: canvas rendering, selection, dragging (with snapping,
 * alignment guides and overlap avoidance), connecting ports, placing and
 * inserting symbols, undo/redo, keyboard shortcuts.
 * ========================================================================= */

const ED = {
  store: { docs: [], cur: 0 },
  doc: null,
  sel: new Set(),
  view: { x: -0.3, y: -0.3, w: 17.6, h: 11.6 },
  undo: [], redo: [], lastSnap: null,
  mode: null,          // current pointer gesture
  place: null,         // palette entry being placed
  hover: null,         // hovered node id
  hoverPort: null,     // "nodeId|portId"
  geoms: new Map(), paths: new Map(),
  opts: { keep: false, grid: true, avoid: true },
  guides: [], insertEdge: null, spaceDown: false, clipboard: null,
};
const STORE_KEY = "diagramDrafter.v1";

// ------------------------------------------------------------- utilities
const svgEl = () => $("#canvas");
const toSvgY = (y) => SHEET_H - y;
const isNode = (id) => ED.doc.nodes.some((n) => n.id === id);
const nodeById = (id) => ED.doc.nodes.find((n) => n.id === id);
const edgeById = (id) => ED.doc.edges.find((e) => e.id === id);
const selNodes = () => ED.doc.nodes.filter((n) => ED.sel.has(n.id));
const selEdges = () => ED.doc.edges.filter((e) => ED.sel.has(e.id));

/** Pointer event -> sheet coordinates (inches, y up). */
function eventPt(ev) {
  const svg = svgEl();
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return [p.x, SHEET_H - p.y];
}

function pxPerInch() {
  const r = svgEl().getBoundingClientRect();
  return Math.min(r.width / ED.view.w, r.height / ED.view.h) || 50;
}

function setStatus(t) { $("#status").textContent = t; }

// ---------------------------------------------------------------- storage
function saveStore() {
  const text = JSON.stringify(ED.store);
  try { localStorage.setItem(STORE_KEY, text); } catch (_) { /* ignore */ }
  hostSave(text);
}
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.docs) && s.docs.length) {
      ED.store = { docs: s.docs.map(normalizeDoc), cur: clamp(s.cur | 0, 0, s.docs.length - 1) };
    }
  } catch (_) { /* ignore */ }
}
const cleanDoc = (doc) => JSON.stringify(doc, (k, v) => (k === "routeFailed" || k.startsWith("_") ? undefined : v));

// -------------------------------------------------------------- undo/redo
function commit(what) {
  const snap = cleanDoc(ED.doc);
  if (snap === ED.lastSnap) return;
  if (ED.lastSnap) ED.undo.push(ED.lastSnap);
  if (ED.undo.length > 150) ED.undo.shift();
  ED.redo = [];
  ED.lastSnap = snap;
  ED.store.docs[ED.store.cur] = ED.doc;
  saveStore();
  if (what) setStatus(what);
  updateUndoButtons();
}
function restore(snap) {
  ED.doc = normalizeDoc(JSON.parse(snap));
  ED.store.docs[ED.store.cur] = ED.doc;
  ED.lastSnap = snap;
  for (const id of [...ED.sel]) if (!isNode(id) && !edgeById(id)) ED.sel.delete(id);
  saveStore();
  render(); renderProps(); renderDocList(); updateUndoButtons();
}
function doUndo() { if (ED.undo.length) { ED.redo.push(ED.lastSnap); restore(ED.undo.pop()); setStatus("Undone"); } }
function doRedo() { if (ED.redo.length) { ED.undo.push(ED.lastSnap); restore(ED.redo.pop()); setStatus("Redone"); } }
function updateUndoButtons() { $("#btnUndo").disabled = !ED.undo.length; $("#btnRedo").disabled = !ED.redo.length; }

function switchDoc(i) {
  ED.store.cur = clamp(i, 0, ED.store.docs.length - 1);
  ED.doc = ED.store.docs[ED.store.cur];
  ED.sel.clear(); ED.undo = []; ED.redo = []; ED.lastSnap = cleanDoc(ED.doc);
  ED.place = null;
  for (const e of ED.doc.edges) if (!e.pts) { routeEdges(ED.doc); break; }
  saveStore();
  renderPalette(); renderDocList(); render(); renderProps(); zoomFit(); updateUndoButtons();
}

// --------------------------------------------------------------- rendering
let _rafPending = false;
function scheduleRender() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => { _rafPending = false; render(); });
}

function render() {
  const doc = ED.doc;
  const { sheet, geoms, paths } = renderDoc(doc);
  ED.geoms = geoms; ED.paths = paths;
  $("#content").innerHTML = sheetToSvgContent(sheet, { minStroke: 0.9 / pxPerInch() });
  $("#canvas").setAttribute("font-family", sheet.font.css.replace(/"/g, "'"));
  renderOverlay();
}

const d4 = (v) => +v.toFixed(4);
const rectSvg = (r, cls, extra = "") =>
  `<rect class="${cls}" x="${d4(r[0])}" y="${d4(toSvgY(r[3]))}" width="${d4(R.w(r))}" height="${d4(R.h(r))}" ${extra}/>`;
const pathSvg = (pts) => "M" + pts.map((p) => `${d4(p[0])} ${d4(toSvgY(p[1]))}`).join("L");

function portMarkers(id, g) {
  const out = [];
  for (const p of g.ports) {
    let x = p.x, y = p.y;
    if (p.bus) { x += p.dir[0] * 0.09; y += p.dir[1] * 0.09; }
    const key = `${id}|${p.id}`;
    out.push(`<circle class="port${ED.hoverPort === key ? " hot" : ""}" data-port="${key}" cx="${d4(x)}" cy="${d4(toSvgY(y))}" r="${d4(Math.max(0.03, 5 / pxPerInch()))}" stroke-width="${d4(1.2 / pxPerInch())}"/>`);
  }
  return out.join("");
}

function renderOverlay() {
  const doc = ED.doc, ppi = pxPerInch();
  const parts = [];
  const sw = (px) => d4(px / ppi);
  // hit areas: edges first, nodes on top
  for (const e of doc.edges) {
    const pts = ED.paths.get(e.id);
    if (pts) parts.push(`<path class="hit-edge" data-edge="${e.id}" d="${pathSvg(pts)}" stroke-width="${sw(10)}"/>`);
  }
  const moving = ED.mode && ED.mode.type === "move" && ED.mode.moved;
  const showKeep = ED.opts.keep || moving;
  const overlaps = showKeep ? overlapSet(doc) : new Set();
  for (const n of doc.nodes) {
    const g = ED.geoms.get(n.id);
    if (!g) continue;
    if (showKeep) parts.push(rectSvg(g.keep, "keep" + (overlaps.has(n.id) ? " bad" : ""), `stroke-width="${sw(1)}"`));
    parts.push(rectSvg(R.inflate(g.outer, 0.03), "hit", `data-node="${n.id}"`));
  }
  // selection
  for (const id of ED.sel) {
    const g = ED.geoms.get(id);
    if (g) parts.push(rectSvg(R.inflate(g.outer, 0.05), "sel-box", `stroke-width="${sw(1.3)}" stroke-dasharray="${sw(5)} ${sw(3)}"`));
    const pts = ED.paths.get(id);
    if (pts) parts.push(`<path class="sel-edge" d="${pathSvg(pts)}" stroke-width="${sw(6)}"/>`);
  }
  if (ED.insertEdge) {
    const pts = ED.paths.get(ED.insertEdge);
    if (pts) parts.push(`<path class="insert-hl" d="${pathSvg(pts)}" stroke-width="${sw(7)}"/>`);
  }
  // ports: hovered / selected nodes, or all while connecting
  const connecting = ED.mode && ED.mode.type === "connect";
  for (const n of doc.nodes) {
    if (connecting || n.id === ED.hover || (ED.sel.has(n.id) && ED.sel.size === 1)) {
      const g = ED.geoms.get(n.id);
      if (g) parts.push(portMarkers(n.id, g));
    }
  }
  // gesture feedback
  for (const gd of ED.guides) {
    parts.push(`<line class="guide" x1="${d4(gd[0])}" y1="${d4(toSvgY(gd[1]))}" x2="${d4(gd[2])}" y2="${d4(toSvgY(gd[3]))}" stroke-width="${sw(1)}"/>`);
  }
  const m = ED.mode;
  if (m && m.type === "band" && m.cur) {
    parts.push(rectSvg(R.of(m.start[0], m.start[1], m.cur[0], m.cur[1]), "band", `stroke-width="${sw(1)}"`));
  }
  if (m && m.type === "connect" && m.cur) {
    parts.push(`<path class="preview-line" d="${pathSvg([m.start, m.cur])}" stroke-width="${sw(1.5)}" stroke-dasharray="${sw(6)} ${sw(4)}"/>`);
  }
  if (ED.place && ED.place.ghostAt) parts.push(ghostSvg(ED.place, ED.place.ghostAt));
  $("#overlay").innerHTML = parts.join("");
}

function ghostSvg(entry, at) {
  const n = makeNode(entry, at[0], at[1], true);
  const sh = new Sheet(docFont(ED.doc));
  const g = computeGeom(ED.doc, n, new Set());
  drawNode(sh, ED.doc, n, g);
  return `<g class="ghost">${sheetToSvgContent(sh, { minStroke: 1 / pxPerInch() })}</g>`;
}

function renderGrid() {
  const show = ED.opts.grid;
  $("#gridLayer").innerHTML = show
    ? `<defs><pattern id="gridPat" width="0.25" height="0.25" patternUnits="userSpaceOnUse" x="0" y="${SHEET_H % 0.25}">` +
      `<circle cx="0" cy="0" r="0.008" fill="#b8c0ca"/></pattern></defs>` +
      `<rect x="${IX0}" y="${toSvgY(IY1)}" width="${IX1 - IX0}" height="${IY1 - IY0}" fill="url(#gridPat)"/>`
    : "";
}

// ---------------------------------------------------------------- view
function applyView() {
  const v = ED.view;
  svgEl().setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  const r = svgEl().getBoundingClientRect();
  const pct = Math.round((Math.min(r.width / v.w, r.height / v.h) / 96) * 100);
  $("#zoomLabel").textContent = `${pct}%`;
}
function zoomFit() {
  const r = svgEl().getBoundingClientRect();
  const m = 0.3, W = SHEET_W + 2 * m, H = SHEET_H + 2 * m;
  const k = Math.max(W / r.width, H / r.height);
  const w = r.width * k, h = r.height * k;
  ED.view = { x: SHEET_W / 2 - w / 2, y: SHEET_H / 2 - h / 2, w, h };
  applyView(); render();
}
function zoomAt(factor, cx, cy) {
  const v = ED.view;
  const nw = clamp(v.w / factor, 1.5, 60), k = nw / v.w;
  ED.view = { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, w: nw, h: v.h * k };
  applyView(); scheduleRender();
}

// ------------------------------------------------------------ creation
function makeNode(entry, x, y, preview = false) {
  const sym = SYMBOLS[entry.sym];
  const n = {
    id: preview ? "ghost" : uid("n"), sym: entry.sym, x: snap(x, GRID), y: snap(y, GRID),
    rot: rotBetween(LIB_FLOW[sym.lib], flowVec(ED.doc)), flip: false,
    tag: "", text: "", props: Object.assign(defaultProps(entry.sym), entry.props || {}), labelPos: "auto",
  };
  if (sym.bus) n.len = sym.defLen;
  const prefix = entry.tag || sym.tag;
  if (prefix && !preview) n.tag = nextTag(ED.doc, prefix);
  return n;
}

/** Inlet / outlet ports of a symbol (canonical), for inserting into lines. */
function throughPorts(n, doc = ED.doc) {
  const sym = SYMBOLS[n.sym];
  const ports = sym.ports(n, doc);
  const f = LIB_FLOW[sym.lib];
  const inP = ports.find((p) => DIRS[p.dir][0] * f[0] + DIRS[p.dir][1] * f[1] < -0.5);
  const outP = ports.find((p) => DIRS[p.dir][0] * f[0] + DIRS[p.dir][1] * f[1] > 0.5);
  return inP && outP ? { inP, outP } : null;
}

function edgeStyleFor(a, b) {
  const sa = SYMBOLS[a.sym], sb = SYMBOLS[b.sym];
  if (sa.instrument || sb.instrument) return "inst-conn";
  if (sa.id === "ol-ground" || sb.id === "ol-ground") return "ground";
  return defaultEdgeStyle(ED.doc);
}

function addEdge(from, fp, to, tp, extra = {}) {
  const e = { id: uid("e"), from: { n: from.id, p: fp }, to: { n: to.id, p: tp },
              style: edgeStyleFor(from, to), label: "", arrow: "none", ...extra };
  ED.doc.edges.push(e);
  return e;
}

/** Split edge e by inserting node n (rotated to the line), returns true on success. */
function insertIntoEdge(n, e, at) {
  const tp = throughPorts(n);
  const pts = ED.paths.get(e.id);
  if (!tp || !pts) return false;
  // segment nearest to `at`
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = segDist(at, pts[i], pts[i + 1]);
    if (!best || d.d < best.d) best = { ...d, i };
  }
  const [a, b] = [pts[best.i], pts[best.i + 1]];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const u = [Math.round((b[0] - a[0]) / L), Math.round((b[1] - a[1]) / L)];
  n.rot = rotBetween(LIB_FLOW[SYMBOLS[n.sym].lib], u);
  n.flip = false;
  // put the node's inlet/outlet midpoint on the line
  const g = computeGeom(ED.doc, { ...n, x: 0, y: 0 }, new Set());
  const pi = g.ports.find((p) => p.id === tp.inP.id), po = g.ports.find((p) => p.id === tp.outP.id);
  const mx = (pi.x + po.x) / 2, my = (pi.y + po.y) / 2;
  const onLine = u[0] ? [best.px, a[1]] : [a[0], best.py];
  n.x = round4(snap(onLine[0] - mx, GRID / 2)); n.y = round4(snap(onLine[1] - my, GRID / 2));
  if (u[0]) n.y = round4(a[1] - my); else n.x = round4(a[0] - mx);
  const from = nodeById(e.from.n), to = nodeById(e.to.n);
  ED.doc.edges = ED.doc.edges.filter((x) => x !== e);
  const e1 = addEdge(from, e.from.p, n, tp.inP.id, { style: e.style, label: e.label, arrow: e.arrow === "end" ? "none" : e.arrow });
  const e2 = addEdge(n, tp.outP.id, to, e.to.p, { style: e.style, arrow: e.arrow });
  routeEdges(ED.doc, new Set([e1.id, e2.id]));
  return true;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1e-9;
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2, 0, 1);
  const px = a[0] + dx * t, py = a[1] + dy * t;
  return { d: Math.hypot(p[0] - px, p[1] - py), px, py };
}

/** Edge whose path passes within `tol` of point p (not touching node `exclude`). */
function edgeNear(p, tol, exclude) {
  let best = null;
  for (const e of ED.doc.edges) {
    if (exclude && (e.from.n === exclude || e.to.n === exclude)) continue;
    const pts = ED.paths.get(e.id);
    if (!pts) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = segDist(p, pts[i], pts[i + 1]).d;
      if (d < tol && (!best || d < best.d)) best = { e, d };
    }
  }
  return best && best.e;
}

/** Place a palette symbol at a point (inserting it into a line when dropped on one). */
function placeAt(entry, pt) {
  const n = makeNode(entry, pt[0], pt[1]);
  ED.doc.nodes.push(n);
  const g = computeGeom(ED.doc, n, new Set());
  // centre the symbol body on the pointer
  n.x = round4(snap(n.x - (R.cx(g.body) - n.x), GRID));
  n.y = round4(snap(n.y - (R.cy(g.body) - n.y), GRID));
  const e = throughPorts(n) ? edgeNear(pt, 0.12) : null;
  if (e) insertIntoEdge(n, e, pt);
  else if (ED.opts.avoid) avoidOverlaps([n.id]);
  ED.sel = new Set([n.id]);
  commit(e ? `Inserted ${SYMBOLS[n.sym].name} into the line` : `Placed ${SYMBOLS[n.sym].name}`);
  render(); renderProps();
}

/**
 * Palette click with one node selected: add the new symbol downstream of it,
 * connected. With one edge selected: insert it into the edge.
 */
function addConnected(entry) {
  const doc = ED.doc;
  const ids = [...ED.sel];
  if (ids.length === 1 && edgeById(ids[0])) {
    const e = edgeById(ids[0]);
    const pts = ED.paths.get(e.id);
    const seg = longestSegment(pts);
    const mid = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2];
    const n = makeNode(entry, mid[0], mid[1]);
    if (!throughPorts(n)) { setStatus("That symbol has no inlet/outlet pair to insert into a line."); return false; }
    doc.nodes.push(n);
    insertIntoEdge(n, e, mid);
    ED.sel = new Set([n.id]);
    commit(`Inserted ${SYMBOLS[n.sym].name}`);
    render(); renderProps();
    return true;
  }
  if (ids.length !== 1 || !isNode(ids[0])) return false;
  const U = nodeById(ids[0]);
  const gu = ED.geoms.get(U.id) || nodeGeom(doc, U);
  const F = flowVec(doc), C = crossVec(doc);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const used = connectedPorts(doc, U.id);
  const n = makeNode(entry, 0, 0);
  const sym = SYMBOLS[n.sym];
  const nPorts = sym.ports(n, doc);
  const tp = throughPorts(n);
  const inP = tp ? tp.inP : nPorts[0];

  // U's outgoing port: a free port facing downstream (buses: load side), else any free port
  let up = gu.ports.find((p) => p.bus && dot(p.dir, F) > 0.5) ||
           gu.ports.find((p) => !used.has(p.id) && dot(p.dir, F) > 0.5) ||
           gu.ports.find((p) => !used.has(p.id) && Math.abs(dot(p.dir, F)) < 0.5) ||
           gu.ports.find((p) => !used.has(p.id));
  if (!up) { setStatus("No free connection point on the selected symbol."); return false; }

  // orient the new symbol so its inlet faces the selected one
  const want = [-up.dir[0], -up.dir[1]];
  n.rot = rotBetween(DIRS[inP.dir], want);
  const g0 = computeGeom(doc, { ...n, x: 0, y: 0 }, new Set([inP.id]));
  const pin = g0.ports.find((p) => p.id === inP.id);
  const sp = spacingOf(doc);
  const corners = (r) => [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]];
  const ext = (r, dir) => { const v = corners(r).map((p) => dot(p, dir)); return [Math.min(...v), Math.max(...v)]; };
  // along the connection: new keep-out starts one gap beyond the selected symbol's keep-out
  const reach = ext(gu.keep, up.dir)[1] - dot([up.x, up.y], up.dir);
  const back = dot([pin.x, pin.y], up.dir) - ext(g0.keep, up.dir)[0];
  const D = Math.max(0.5, reach + sp.gap + back);
  let ox, oy;
  if (up.bus) {
    // new branch on a bus: just past the existing branches (or centred if it is the first)
    const branches = doc.edges.filter((e) => (e.from.n === U.id && e.from.p === up.id) || (e.to.n === U.id && e.to.p === up.id))
      .map((e) => nodeById(e.from.n === U.id ? e.to.n : e.from.n)).filter(Boolean);
    const along = dot([U.x, U.y], up.dir) + D - dot([pin.x, pin.y], up.dir);
    let cross;
    if (branches.length) {
      const edge = Math.max(...branches.map((b) => ext(nodeGeom(doc, b).keep, C)[1]));
      cross = edge + sp.gap - ext(g0.keep, C)[0];
    } else {
      cross = dot([U.x, U.y], C) - dot([pin.x, pin.y], C);
    }
    ox = up.dir[0] * along + C[0] * cross; oy = up.dir[1] * along + C[1] * cross;
  } else {
    ox = up.x + up.dir[0] * D - pin.x; oy = up.y + up.dir[1] * D - pin.y;
  }
  n.x = round4(snap(ox, GRID)); n.y = round4(snap(oy, GRID));
  doc.nodes.push(n);
  const e = addEdge(U, up.id, n, inP.id);
  if (up.bus) fitBuses(doc, new Set([U.id]));
  if (ED.opts.avoid) avoidOverlaps([n.id], up.bus ? C : null);
  routeEdges(doc, incidentEdges(new Set([n.id, U.id])));
  ED.sel = new Set([n.id]);
  commit(`Added ${SYMBOLS[n.sym].name} after ${U.tag || SYMBOLS[U.sym].name}`);
  render(); renderProps();
  return !!e;
}

function incidentEdges(nodeIds) {
  return new Set(ED.doc.edges.filter((e) => nodeIds.has(e.from.n) || nodeIds.has(e.to.n)).map((e) => e.id));
}

// ----------------------------------------------------- overlap handling
function overlapSet(doc) {
  const gs = doc.nodes.map((n) => [n.id, ED.geoms.get(n.id) || nodeGeom(doc, n)]);
  const bad = new Set();
  for (let i = 0; i < gs.length; i++) {
    for (let j = i + 1; j < gs.length; j++) {
      if (R.overlaps(gs[i][1].keep, gs[j][1].keep)) { bad.add(gs[i][0]); bad.add(gs[j][0]); }
    }
  }
  return bad;
}

/**
 * Move the given nodes (as a group) to the nearest grid position where their
 * keep-out boxes clear everything else. `prefer`: direction to try first.
 */
function avoidOverlaps(ids, prefer = null) {
  const doc = ED.doc;
  const moving = doc.nodes.filter((n) => ids.includes(n.id));
  const others = doc.nodes.filter((n) => !ids.includes(n.id)).map((n) => nodeGeom(doc, n).keep);
  const area = [IX0 + 0.1, IY0 + 0.1, IX1 - 0.1, IY1 - 0.1];
  const reserved = [IX1 - TB_W, IY0, IX1, notesLayout(doc).top];
  const boxes = moving.map((n) => nodeGeom(doc, n).keep);
  const clear = (dx, dy) => boxes.every((b) => {
    const s = R.shift(b, dx, dy);
    return s[0] >= area[0] && s[2] <= area[2] && s[1] >= area[1] && s[3] <= area[3] &&
      !R.overlaps(s, reserved) && !others.some((o) => R.overlaps(s, o));
  });
  if (clear(0, 0)) return false;
  const step = 0.125, cands = [];
  for (let i = -24; i <= 24; i++) {
    for (let j = -24; j <= 24; j++) {
      let d = Math.hypot(i, j);
      if (prefer) d -= 0.6 * Math.max(0, i * prefer[0] + j * prefer[1]) / Math.max(1, Math.hypot(i, j)) * Math.min(4, Math.hypot(i, j));
      cands.push([d, i * step, j * step]);
    }
  }
  cands.sort((a, b) => a[0] - b[0]);
  for (const [, dx, dy] of cands) {
    if (clear(dx, dy)) {
      for (const n of moving) { n.x = round4(n.x + dx); n.y = round4(n.y + dy); }
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------- snapping
/** Snap a single dragged node so its connections run straight / it aligns with neighbours. */
function smartSnap(n, x, y) {
  const doc = ED.doc;
  const tol = 10 / pxPerInch();
  const g = computeGeom(doc, { ...n, x, y }, connectedPorts(doc, n.id));
  let bestX = null, bestY = null;
  const consider = (axis, delta, guide) => {
    if (Math.abs(delta) > tol) return;
    if (axis === "x" && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, guide };
    if (axis === "y" && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, guide };
  };
  // port-to-port straight connections
  for (const e of doc.edges) {
    let mine, other;
    if (e.from.n === n.id) { mine = e.from; other = e.to; } else if (e.to.n === n.id) { mine = e.to; other = e.from; } else continue;
    const on = nodeById(other.n);
    if (!on || on.id === n.id) continue;
    const mp = portOf(g, mine.p), op = portOf(ED.geoms.get(on.id) || nodeGeom(doc, on), other.p);
    if (op.bus || mp.bus) continue;
    if (mp.dir[0] === 0) consider("x", op.x - mp.x, [op.x, Math.min(op.y, mp.y) - 0.3, op.x, Math.max(op.y, mp.y) + 0.3]);
    else consider("y", op.y - mp.y, [Math.min(op.x, mp.x) - 0.3, op.y, Math.max(op.x, mp.x) + 0.3, op.y]);
  }
  // centre alignment with nearby symbols
  const cx = R.cx(g.body), cy = R.cy(g.body);
  for (const o of doc.nodes) {
    if (o.id === n.id) continue;
    const og = ED.geoms.get(o.id) || nodeGeom(doc, o);
    const ox = R.cx(og.body), oy = R.cy(og.body);
    if (Math.abs(oy - cy) < 4) consider("x", ox - cx, [ox, Math.min(oy, cy) - 0.4, ox, Math.max(oy, cy) + 0.4]);
    if (Math.abs(ox - cx) < 6) consider("y", oy - cy, [Math.min(ox, cx) - 0.4, oy, Math.max(ox, cx) + 0.4, oy]);
  }
  ED.guides = [];
  if (bestX) { x += bestX.delta; ED.guides.push(bestX.guide); }
  if (bestY) { y += bestY.delta; ED.guides.push(bestY.guide); }
  return [round4(x), round4(y)];
}

// -------------------------------------------------------- pointer input
function targetInfo(ev) {
  // with pointer capture, ev.target is the canvas itself: hit-test what is under the pointer
  const t = document.elementFromPoint(ev.clientX, ev.clientY) || ev.target;
  if (t.dataset?.port) { const [n, p] = t.dataset.port.split("|"); return { port: { n, p } }; }
  if (t.dataset?.node) return { node: t.dataset.node };
  if (t.dataset?.edge) return { edge: t.dataset.edge };
  return {};
}

/** Port of node `id` nearest to point p (buses: the side facing p). */
function nearestPort(id, p) {
  const g = ED.geoms.get(id);
  if (!g) return null;
  let best = null;
  for (const port of g.ports) {
    let d;
    if (port.bus) d = (p[0] - port.x) * port.dir[0] + (p[1] - port.y) * port.dir[1] > 0 ? 0 : 99;
    else d = Math.hypot(p[0] - port.x, p[1] - port.y);
    if (!best || d < best.d) best = { d, id: port.id };
  }
  return best && best.id;
}

function onPointerDown(ev) {
  const svg = svgEl();
  svg.setPointerCapture(ev.pointerId);
  const pt = eventPt(ev);
  if (ev.button === 1 || ev.button === 2 || ED.spaceDown) {
    ED.mode = { type: "pan", sx: ev.clientX, sy: ev.clientY, view: { ...ED.view } };
    svg.classList.add("panning");
    ev.preventDefault();
    return;
  }
  if (ev.button !== 0) return;
  if (ED.place) {
    placeAt(ED.place, pt);
    if (!ev.shiftKey) cancelPlace();
    return;
  }
  const t = targetInfo(ev);
  if (t.port) {
    const g = ED.geoms.get(t.port.n);
    const p = portOf(g, t.port.p);
    ED.mode = { type: "connect", from: t.port, start: [p.x, p.y], cur: pt };
    renderOverlay();
    return;
  }
  if (t.node) {
    if (ev.shiftKey) { ED.sel.has(t.node) ? ED.sel.delete(t.node) : ED.sel.add(t.node); }
    else if (!ED.sel.has(t.node)) ED.sel = new Set([t.node]);
    const orig = new Map(selNodes().map((n) => [n.id, [n.x, n.y]]));
    ED.mode = { type: "move", start: pt, orig, moved: false, lead: t.node };
    renderOverlay(); renderProps();
    return;
  }
  if (t.edge) {
    if (ev.shiftKey) { ED.sel.has(t.edge) ? ED.sel.delete(t.edge) : ED.sel.add(t.edge); }
    else ED.sel = new Set([t.edge]);
    ED.mode = null;
    renderOverlay(); renderProps();
    return;
  }
  ED.mode = { type: "band", start: pt, cur: null, add: ev.shiftKey };
}

function onPointerMove(ev) {
  const pt = eventPt(ev);
  const m = ED.mode;
  if (ED.place) {
    ED.place.ghostAt = pt;
    const probe = makeNode(ED.place, pt[0], pt[1], true);
    ED.insertEdge = throughPorts(probe) ? edgeNear(pt, 0.12)?.id || null : null;
    renderOverlay();
    return;
  }
  if (!m) {
    const t = targetInfo(ev);
    const hover = t.node || (t.port && t.port.n) || null;
    const hp = t.port ? `${t.port.n}|${t.port.p}` : null;
    if (hover !== ED.hover || hp !== ED.hoverPort) { ED.hover = hover; ED.hoverPort = hp; renderOverlay(); }
    return;
  }
  if (m.type === "pan") {
    const k = ED.view.w / svgEl().getBoundingClientRect().width;
    ED.view = { ...m.view, x: m.view.x - (ev.clientX - m.sx) * k, y: m.view.y - (ev.clientY - m.sy) * k };
    applyView();
    return;
  }
  if (m.type === "band") { m.cur = pt; renderOverlay(); return; }
  if (m.type === "connect") {
    m.cur = pt;
    const t = targetInfo(ev);
    ED.hoverPort = t.port ? `${t.port.n}|${t.port.p}` : null;
    ED.hover = t.node || (t.port && t.port.n) || null;
    renderOverlay();
    return;
  }
  if (m.type === "move") {
    let dx = pt[0] - m.start[0], dy = pt[1] - m.start[1];
    if (!m.moved && Math.hypot(dx, dy) < 3 / pxPerInch()) return;
    m.moved = true;
    dx = snap(dx, GRID); dy = snap(dy, GRID);
    const nodes = selNodes();
    if (nodes.length === 1) {
      const [ox, oy] = m.orig.get(nodes[0].id);
      const [x, y] = smartSnap(nodes[0], ox + dx, oy + dy);
      nodes[0].x = x; nodes[0].y = y;
    } else {
      ED.guides = [];
      for (const n of nodes) { const [ox, oy] = m.orig.get(n.id); n.x = round4(ox + dx); n.y = round4(oy + dy); }
    }
    // dropping a free inline symbol onto a line inserts it
    ED.insertEdge = null;
    if (nodes.length === 1 && !ED.doc.edges.some((e) => e.from.n === nodes[0].id || e.to.n === nodes[0].id) && throughPorts(nodes[0])) {
      const g = computeGeom(ED.doc, nodes[0], new Set());
      ED.insertEdge = edgeNear([R.cx(g.body), R.cy(g.body)], 0.15, nodes[0].id)?.id || null;
    }
    const ids = new Set(nodes.map((n) => n.id));
    routeEdges(ED.doc, incidentEdges(ids));
    scheduleRender();
  }
}

function onPointerUp(ev) {
  const m = ED.mode;
  ED.mode = null;
  svgEl().classList.remove("panning");
  if (!m) return;
  const pt = eventPt(ev);
  if (m.type === "band") {
    if (!m.cur || Math.hypot(pt[0] - m.start[0], pt[1] - m.start[1]) < 3 / pxPerInch()) {
      if (!m.add) ED.sel.clear();
    } else {
      const box = R.of(m.start[0], m.start[1], pt[0], pt[1]);
      if (!m.add) ED.sel.clear();
      for (const n of ED.doc.nodes) { const g = ED.geoms.get(n.id); if (g && R.overlaps(g.body, box)) ED.sel.add(n.id); }
      for (const e of ED.doc.edges) {
        const pts = ED.paths.get(e.id);
        if (pts && pts.every((p) => R.contains(box, p[0], p[1]))) ED.sel.add(e.id);
      }
    }
    renderOverlay(); renderProps();
    return;
  }
  if (m.type === "connect") {
    const t = targetInfo(ev);
    let to = t.port;
    if (!to && t.node && t.node !== m.from.n) to = { n: t.node, p: nearestPort(t.node, pt) };
    ED.hoverPort = null;
    if (to && to.n !== m.from.n && to.p) {
      const a = nodeById(m.from.n), b = nodeById(to.n);
      const dup = ED.doc.edges.some((e) => (e.from.n === a.id && e.from.p === m.from.p && e.to.n === b.id && e.to.p === to.p) ||
                                         (e.to.n === a.id && e.to.p === m.from.p && e.from.n === b.id && e.from.p === to.p));
      if (!dup) {
        const e = addEdge(a, m.from.p, b, to.p);
        fitBuses(ED.doc, new Set([a.id, b.id]));
        routeEdges(ED.doc, incidentEdges(new Set([a.id, b.id])));
        ED.sel = new Set([e.id]);
        commit("Connected");
      }
    }
    render(); renderProps();
    return;
  }
  if (m.type === "move") {
    ED.guides = [];
    if (m.moved) {
      const nodes = selNodes();
      const ids = nodes.map((n) => n.id);
      let msg = "Moved";
      if (ED.insertEdge && nodes.length === 1) {
        const e = edgeById(ED.insertEdge);
        const g = computeGeom(ED.doc, nodes[0], new Set());
        if (e && insertIntoEdge(nodes[0], e, [R.cx(g.body), R.cy(g.body)])) msg = "Inserted into the line";
      } else if (ED.opts.avoid && avoidOverlaps(ids)) msg = "Moved (nudged clear of neighbours)";
      ED.insertEdge = null;
      const near = new Set(ids);
      for (const e of ED.doc.edges) {
        if (near.has(e.from.n)) near.add(e.to.n);
        if (near.has(e.to.n)) near.add(e.from.n);
      }
      fitBuses(ED.doc, near);
      routeEdges(ED.doc, incidentEdges(near));
      commit(msg);
    }
    render(); renderProps();
  }
}

function onWheel(ev) {
  ev.preventDefault();
  const svg = svgEl();
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  if (ev.ctrlKey || ev.metaKey) {
    zoomAt(Math.exp(-ev.deltaY * 0.0025), p.x, p.y);
  } else {
    const k = ED.view.w / svg.getBoundingClientRect().width;
    ED.view.x += ev.deltaX * k; ED.view.y += ev.deltaY * k;
    applyView();
  }
}

function cancelPlace() {
  ED.place = null; ED.insertEdge = null;
  svgEl().classList.remove("placing");
  $$(".pal-item.active").forEach((x) => x.classList.remove("active"));
  setStatus("Ready");
  renderOverlay();
}

// ------------------------------------------------------------- commands
function deleteSelection() {
  const doc = ED.doc;
  const nodes = new Set(selNodes().map((n) => n.id));
  const edges = new Set(selEdges().map((e) => e.id));
  if (!nodes.size && !edges.size) return;
  // heal lines through deleted inline devices (one connection in, one out)
  const heal = [];
  for (const id of nodes) {
    const n = nodeById(id);
    const tp = throughPorts(n);
    if (!tp) continue;
    const inE = doc.edges.filter((e) => (e.to.n === id && e.to.p === tp.inP.id) || (e.from.n === id && e.from.p === tp.inP.id));
    const outE = doc.edges.filter((e) => (e.from.n === id && e.from.p === tp.outP.id) || (e.to.n === id && e.to.p === tp.outP.id));
    const all = doc.edges.filter((e) => e.from.n === id || e.to.n === id);
    if (inE.length === 1 && outE.length === 1 && all.length === 2) {
      const a = inE[0].from.n === id ? inE[0].to : inE[0].from;
      const b = outE[0].from.n === id ? outE[0].to : outE[0].from;
      if (!nodes.has(a.n) && !nodes.has(b.n)) heal.push({ a, b, style: inE[0].style, label: inE[0].label || outE[0].label, arrow: outE[0].arrow });
    }
  }
  doc.edges = doc.edges.filter((e) => !edges.has(e.id) && !nodes.has(e.from.n) && !nodes.has(e.to.n));
  doc.nodes = doc.nodes.filter((n) => !nodes.has(n.id));
  const ids = new Set();
  for (const h of heal) {
    const e = { id: uid("e"), from: h.a, to: h.b, style: h.style, label: h.label, arrow: h.arrow };
    doc.edges.push(e); ids.add(e.id);
  }
  if (ids.size) routeEdges(doc, ids);
  ED.sel.clear();
  commit(`Deleted ${nodes.size + edges.size} item(s)` + (heal.length ? "; line rejoined" : ""));
  render(); renderProps();
}

function copySelection() {
  const nodes = selNodes();
  if (!nodes.length) return false;
  const ids = new Set(nodes.map((n) => n.id));
  ED.clipboard = {
    nodes: clone(nodes),
    edges: clone(ED.doc.edges.filter((e) => ids.has(e.from.n) && ids.has(e.to.n))),
  };
  setStatus(`Copied ${nodes.length} symbol(s)`);
  return true;
}

function paste(offset = [0.5, -0.5]) {
  const cb = ED.clipboard;
  if (!cb) return;
  const map = new Map();
  const nodes = cb.nodes.map((n) => {
    const id = uid("n");
    map.set(n.id, id);
    const sym = SYMBOLS[n.sym];
    const tag = n.tag && (sym.tag || /-\d+$/.test(n.tag)) ? nextTag(ED.doc, n.tag.replace(/-\d+$/, "")) : n.tag;
    return { ...clone(n), id, x: round4(n.x + offset[0]), y: round4(n.y + offset[1]), tag };
  });
  for (const n of nodes) ED.doc.nodes.push(n);
  const edges = cb.edges.map((e) => ({ ...clone(e), id: uid("e"), from: { n: map.get(e.from.n), p: e.from.p }, to: { n: map.get(e.to.n), p: e.to.p } }));
  for (const e of edges) { delete e.pts; ED.doc.edges.push(e); }
  if (ED.opts.avoid) avoidOverlaps(nodes.map((n) => n.id));
  routeEdges(ED.doc, new Set(edges.map((e) => e.id)));
  ED.sel = new Set(nodes.map((n) => n.id));
  commit(`Pasted ${nodes.length} symbol(s)`);
  render(); renderProps();
}

function rotateSelection(delta) {
  const nodes = selNodes();
  if (!nodes.length) return;
  for (const n of nodes) n.rot = (((n.rot + delta) % 360) + 360) % 360;
  routeEdges(ED.doc, incidentEdges(new Set(nodes.map((n) => n.id))));
  commit("Rotated"); render(); renderProps();
}

function flipSelection() {
  const nodes = selNodes();
  if (!nodes.length) return;
  for (const n of nodes) n.flip = !n.flip;
  routeEdges(ED.doc, incidentEdges(new Set(nodes.map((n) => n.id))));
  commit("Mirrored"); render(); renderProps();
}

function nudge(dx, dy) {
  const nodes = selNodes();
  if (!nodes.length) return;
  for (const n of nodes) { n.x = round4(n.x + dx); n.y = round4(n.y + dy); }
  routeEdges(ED.doc, incidentEdges(new Set(nodes.map((n) => n.id))));
  commit("Nudged"); render();
}

function runAutoArrange() {
  const t0 = performance.now();
  const rep = autoArrange(ED.doc);
  commit("Auto-arranged");
  render(); renderProps();
  const ms = Math.round(performance.now() - t0);
  setStatus(`Auto-arranged in ${ms} ms` + (rep.warnings.length ? ` — ${rep.warnings.join(" ")}` : ""));
}

function runReroute() {
  for (const e of ED.doc.edges) delete e.pts;
  const r = routeEdges(ED.doc);
  commit("Re-routed");
  render();
  setStatus(r.failed ? `${r.failed} connection(s) could not be routed cleanly — try Auto-arrange or move symbols apart.` : "All connections re-routed");
}

/** Align / distribute selected nodes by their bodies. */
function alignSelection(how) {
  const nodes = selNodes();
  if (nodes.length < 2) return;
  const gs = nodes.map((n) => [n, ED.geoms.get(n.id) || nodeGeom(ED.doc, n)]);
  const xs = gs.map(([, g]) => g.body), anchor = xs[0];
  if (how === "hdist" || how === "vdist") {
    const k = how === "hdist" ? 0 : 1;
    gs.sort((a, b) => (k ? R.cy(a[1].body) - R.cy(b[1].body) : R.cx(a[1].body) - R.cx(b[1].body)));
    const c0 = k ? R.cy(gs[0][1].body) : R.cx(gs[0][1].body), c1 = k ? R.cy(gs[gs.length - 1][1].body) : R.cx(gs[gs.length - 1][1].body);
    gs.forEach(([n, g], i) => {
      const target = c0 + (c1 - c0) * i / (gs.length - 1);
      const cur = k ? R.cy(g.body) : R.cx(g.body);
      if (k) n.y = round4(snap(n.y + target - cur, GRID / 2)); else n.x = round4(snap(n.x + target - cur, GRID / 2));
    });
  } else {
    for (const [n, g] of gs) {
      if (how === "left") n.x = round4(n.x + anchor[0] - g.body[0]);
      if (how === "hcenter") n.x = round4(n.x + R.cx(anchor) - R.cx(g.body));
      if (how === "right") n.x = round4(n.x + anchor[2] - g.body[2]);
      if (how === "top") n.y = round4(n.y + anchor[3] - g.body[3]);
      if (how === "vcenter") n.y = round4(n.y + R.cy(anchor) - R.cy(g.body));
      if (how === "bottom") n.y = round4(n.y + anchor[1] - g.body[1]);
    }
  }
  routeEdges(ED.doc, incidentEdges(new Set(nodes.map((n) => n.id))));
  commit("Aligned"); render();
}

function onKeyDown(ev) {
  const tag = (ev.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  const k = ev.key, mod = ev.ctrlKey || ev.metaKey;
  if (k === " ") { ED.spaceDown = true; ev.preventDefault(); return; }
  if (mod && k.toLowerCase() === "z") { ev.preventDefault(); ev.shiftKey ? doRedo() : doUndo(); return; }
  if (mod && k.toLowerCase() === "y") { ev.preventDefault(); doRedo(); return; }
  if (mod && k.toLowerCase() === "c") { if (copySelection()) ev.preventDefault(); return; }
  if (mod && k.toLowerCase() === "v") { ev.preventDefault(); paste(); return; }
  if (mod && k.toLowerCase() === "d") { ev.preventDefault(); if (copySelection()) paste(); return; }
  if (mod && k.toLowerCase() === "a") { ev.preventDefault(); ED.sel = new Set(ED.doc.nodes.map((n) => n.id)); renderOverlay(); renderProps(); return; }
  if (mod) return;
  if (k === "Escape") { if (ED.place) cancelPlace(); ED.sel.clear(); ED.mode = null; renderOverlay(); renderProps(); return; }
  if (k === "Delete" || k === "Backspace") { ev.preventDefault(); deleteSelection(); return; }
  if (k === "r" || k === "R") { rotateSelection(ev.shiftKey ? -90 : 90); return; }
  if (k === "f" || k === "F") { flipSelection(); return; }
  if (k === "a" || k === "A") { runAutoArrange(); return; }
  if (k === "0") { zoomFit(); return; }
  if (k === "+" || k === "=") { zoomAt(1.25, ED.view.x + ED.view.w / 2, ED.view.y + ED.view.h / 2); return; }
  if (k === "-") { zoomAt(0.8, ED.view.x + ED.view.w / 2, ED.view.y + ED.view.h / 2); return; }
  const step = ev.shiftKey ? GRID * 4 : GRID;
  const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  if (arrows[k] && ED.sel.size) { ev.preventDefault(); nudge(...arrows[k]); }
}
function onKeyUp(ev) { if (ev.key === " ") ED.spaceDown = false; }

function bindCanvas() {
  const svg = svgEl();
  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("pointermove", onPointerMove);
  svg.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("pointerleave", () => { if (ED.place) { ED.place.ghostAt = null; renderOverlay(); } });
  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("contextmenu", (e) => e.preventDefault());
  svg.addEventListener("dragover", (e) => e.preventDefault());
  svg.addEventListener("drop", (e) => {
    e.preventDefault();
    const i = e.dataTransfer.getData("text/x-palette");
    const entry = paletteEntries()[+i];
    if (entry) placeAt(entry, eventPt(e));
  });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("resize", () => { applyView(); render(); });
}
