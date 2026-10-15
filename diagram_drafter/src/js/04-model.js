/* =========================================================================
 * Document model and node geometry.
 *
 * doc = {type: "oneline"|"pid", name, flow: "down"|"right", font, symScale,
 *        spacing, crossing, uppercase, nodes: [...], edges: [...], notes, titleblock}
 * node = {id, sym, x, y, rot, flip, tag, text, props, labelPos, len?}
 * edge = {id, from: {n, p}, to: {n, p}, style, label, arrow, pts?}
 * ========================================================================= */

const SPACING = {
  compact: { clear: 0.0625, gap: 0.1875 },
  normal: { clear: 0.125, gap: 0.25 },
  airy: { clear: 0.1875, gap: 0.375 },
};
const TEXT_H = { tag: 0.1, line: 0.08, edge: 0.08 };
const LABEL_GAP = 0.08;
const GRID = 0.0625;

const libOf = (doc) => (doc.type === "pid" ? "pid" : "ol");
const flowVec = (doc) => (doc.flow === "right" ? [1, 0] : [0, -1]);
const crossVec = (doc) => (doc.flow === "right" ? [0, -1] : [1, 0]);
const spacingOf = (doc) => SPACING[doc.spacing] || SPACING.normal;
const docFont = (doc) => FONTS[doc.font] || FONTS[DEFAULT_FONT];

function newDoc(type = "oneline") {
  return normalizeDoc({ type, name: type === "pid" ? "New P&ID" : "New one-line" });
}

function normalizeDoc(d) {
  const type = d.type === "pid" ? "pid" : "oneline";
  const doc = {
    v: 1,
    id: d.id || uid("d"),
    type,
    name: d.name || "Untitled",
    flow: d.flow === "right" || d.flow === "down" ? d.flow : type === "pid" ? "right" : "down",
    font: d.font in FONTS ? d.font : DEFAULT_FONT,
    symScale: clamp(Number(d.symScale) || 1, 0.5, 1.5),
    spacing: d.spacing in SPACING ? d.spacing : "normal",
    crossing: ["hop", "gap", "none"].includes(d.crossing) ? d.crossing : "hop",
    uppercase: d.uppercase !== false,
    nodes: [],
    edges: [],
    notes: (d.notes || []).map(String),
    titleblock: Object.assign({ project: "", title: "", drawn_by: "", date: isoToday(), dwg_no: "",
                                rev: "", sheet: "1 OF 1", scale: "NONE" }, d.titleblock || {}),
  };
  for (const n of d.nodes || []) {
    if (!SYMBOLS[n.sym]) continue;
    doc.nodes.push({
      id: n.id || uid("n"), sym: n.sym, x: +n.x || 0, y: +n.y || 0,
      rot: [0, 90, 180, 270].includes(n.rot) ? n.rot : 0, flip: !!n.flip,
      tag: n.tag || "", text: n.text || "", props: Object.assign(defaultProps(n.sym), n.props || {}),
      labelPos: n.labelPos || "auto", ...(n.len ? { len: +n.len } : {}),
    });
  }
  const ids = new Set(doc.nodes.map((n) => n.id));
  for (const e of d.edges || []) {
    if (!e.from || !e.to || !ids.has(e.from.n) || !ids.has(e.to.n)) continue;
    doc.edges.push({
      id: e.id || uid("e"), from: { n: e.from.n, p: e.from.p }, to: { n: e.to.n, p: e.to.p },
      style: EDGE_STYLES[e.style] ? e.style : defaultEdgeStyle(doc),
      label: e.label || "", arrow: ["none", "mid", "end"].includes(e.arrow) ? e.arrow : "none",
      ...(Array.isArray(e.pts) ? { pts: e.pts } : {}),
    });
  }
  return doc;
}

function defaultProps(symId) {
  const o = {};
  for (const p of SYMBOLS[symId].props) o[p.k] = p.def ?? "";
  return o;
}

const defaultEdgeStyle = (doc) => (libOf(doc) === "pid" ? "pipe" : "power");

function nextTag(doc, prefix) {
  let max = 0;
  const re = new RegExp(`^${prefix.replace(/[^A-Za-z0-9]/g, "\\$&")}-(\\d+)$`, "i");
  for (const n of doc.nodes) {
    const m = re.exec(n.tag || "");
    if (m) max = Math.max(max, +m[1]);
  }
  return `${prefix}-${max + 1}`;
}

/** Ids of ports on node `id` that have an edge attached. */
function connectedPorts(doc, id) {
  const s = new Set();
  for (const e of doc.edges) {
    if (e.from.n === id) s.add(e.from.p);
    if (e.to.n === id) s.add(e.to.p);
  }
  return s;
}

// ---------------------------------------------------------------- geometry
const _geomCache = new Map();

/**
 * World geometry of a node: body box, ports, label block and keep-out box.
 * Cached on everything that affects it.
 */
function nodeGeom(doc, n, connected) {
  connected = connected || connectedPorts(doc, n.id);
  const key = JSON.stringify([n.sym, n.x, n.y, n.rot, n.flip, n.len, n.tag, n.text, n.props, n.labelPos,
    doc.symScale, doc.font, doc.uppercase, doc.spacing, doc.type, [...connected].sort()]);
  const hit = _geomCache.get(n.id);
  if (hit && hit.key === key) return hit.g;
  const g = computeGeom(doc, n, connected);
  _geomCache.set(n.id, { key, g });
  return g;
}

function computeGeom(doc, n, connected) {
  const sym = SYMBOLS[n.sym];
  const s = doc.symScale;
  const tf = (x, y) => {
    const [rx, ry] = rotVec((n.flip ? -x : x) * s, y * s, n.rot);
    return [n.x + rx, n.y + ry];
  };
  const tdir = (d) => rotVec(n.flip ? -d[0] : d[0], d[1], n.rot);

  const ports = sym.ports(n, doc).map((p) => {
    const [x, y] = tf(p.x, p.y);
    const dir = tdir(DIRS[p.dir]).map((v) => Math.round(v));
    const port = { id: p.id, x, y, dir, role: p.role, bus: !!p.bus, canon: p.dir };
    return port;
  });

  // body box: symbol box plus port positions
  let lb = sym.box(n, doc);
  for (const p of sym.ports(n, doc)) lb = R.union(lb, [p.x, p.y, p.x, p.y]);
  const c = [tf(lb[0], lb[1]), tf(lb[2], lb[1]), tf(lb[2], lb[3]), tf(lb[0], lb[3])];
  const body = R.of(Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])),
                    Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1])));

  if (sym.bus) {
    const horiz = R.w(body) >= R.h(body);
    for (const p of ports) {
      p.seg = horiz ? [body[0], n.y, body[2], n.y] : [n.x, body[1], n.x, body[3]];
      p.x = n.x; p.y = n.y;
    }
  }

  const flowW = tdir(LIB_FLOW[sym.lib]).map((v) => Math.round(v));
  const label = layoutLabel(doc, n, sym, body, ports, flowW, connected);
  const clear = spacingOf(doc).clear;
  const outer = label ? R.union(body, label.box) : body;
  return { sym, s, body, ports, flowW, label, outer, keep: R.inflate(outer, clear) };
}

function labelLines(doc, n, sym) {
  const up = (t) => (doc.uppercase ? String(t).toUpperCase() : String(t));
  const lines = [];
  if (n.tag) lines.push({ s: up(n.tag), h: TEXT_H.tag, bold: true });
  for (const t of sym.spec(n)) if (t) lines.push({ s: up(t), h: TEXT_H.line, bold: false });
  for (const t of String(n.text || "").split("\n")) if (t.trim()) lines.push({ s: up(t.trim()), h: TEXT_H.line, bold: false });
  return lines;
}

function layoutLabel(doc, n, sym, body, ports, flowW, connected) {
  if (n.labelPos === "none") return null;
  const lines = labelLines(doc, n, sym);
  if (!lines.length) return null;
  const font = docFont(doc);
  const widths = lines.map((l) => textWidth(l.s, l.h, l.bold, font));
  const W = Math.max(...widths);
  const H = lines.reduce((a, l) => a + l.h * LINE_SPACING, 0) - lines[lines.length - 1].h * (LINE_SPACING - 1);

  let side = n.labelPos;
  if (sym.bus && (side === "auto" || side === "end")) side = "end";
  if (side === "auto") {
    const vertical = Math.abs(flowW[1]) > 0.5;
    const prefs = vertical ? ["right", "left", "below", "above"] : ["below", "above", "right", "left"];
    const faces = { right: [1, 0], left: [-1, 0], below: [0, -1], above: [0, 1] };
    const used = ports.filter((p) => connected.has(p.id) && !p.bus);
    side = prefs.find((sd) => !used.some((p) => p.dir[0] === faces[sd][0] && p.dir[1] === faces[sd][1])) || prefs[0];
  }

  let align, x, top;
  const [cx, cy] = [R.cx(body), R.cy(body)];
  if (side === "end") {
    // horizontal bus: above its left end; vertical header: above its top end
    if (R.w(body) >= R.h(body)) {
      // above the left end when the bus is long enough to keep it clear of a centre feed,
      // otherwise beyond the end
      if (W <= R.w(body) / 2 - 0.3) { align = "L"; x = body[0] + 0.02; top = body[3] + 0.1 + H; }
      else { align = "R"; x = body[0] - 0.12; top = cy + H / 2; }
    }
    else { align = "C"; x = cx; top = body[3] + 0.12 + H; }
  } else if (side === "right") { align = "L"; x = body[2] + LABEL_GAP; top = cy + H / 2; }
  else if (side === "left") { align = "R"; x = body[0] - LABEL_GAP; top = cy + H / 2; }
  else if (side === "above") { align = "C"; x = cx; top = body[3] + LABEL_GAP + H; }
  else { align = "C"; x = cx; top = body[1] - LABEL_GAP; }

  const x0 = align === "L" ? x : align === "R" ? x - W : x - W / 2;
  return { lines, widths, align, x, top, side, box: [x0, top - H, x0 + W, top] };
}

/** Port record of node `n` by id, from its geometry. */
const portOf = (g, pid) => g.ports.find((p) => p.id === pid) || g.ports[0];

/** All node geometries for the doc (shared connected-port sets). */
function allGeoms(doc) {
  const conn = new Map(doc.nodes.map((n) => [n.id, new Set()]));
  for (const e of doc.edges) {
    conn.get(e.from.n)?.add(e.from.p);
    conn.get(e.to.n)?.add(e.to.p);
  }
  return new Map(doc.nodes.map((n) => [n.id, nodeGeom(doc, n, conn.get(n.id))]));
}

/** Endpoint of an edge end: {x, y, dir, bus, seg} (bus attach point: nearest to `toward`). */
function endPoint(g, pid, toward) {
  const p = portOf(g, pid);
  if (!p.bus) return { x: p.x, y: p.y, dir: p.dir, bus: false };
  const [x0, y0, x1, y1] = p.seg;
  const inset = 0.0625;
  const horiz = y0 === y1;
  const x = horiz ? clamp(toward ? toward[0] : (x0 + x1) / 2, x0 + inset, x1 - inset) : x0;
  const y = horiz ? y0 : clamp(toward ? toward[1] : (y0 + y1) / 2, y0 + inset, y1 - inset);
  return { x, y, dir: p.dir, bus: true, seg: p.seg };
}

/** Area available for the diagram, and the reserved title/notes corner. */
function drawingArea(doc, notesTop) {
  const m = 0.2;
  const reserved = [IX1 - TB_W, IY0, IX1, notesTop ?? IY0 + TB_H];
  return { outer: [IX0 + m, IY0 + m, IX1 - m, IY1 - m], reserved };
}
