/* =========================================================================
 * Orthogonal connector routing.
 *
 * Builds a sparse "visibility grid" from interesting coordinates: obstacle
 * edges (symbol bodies inflated by a margin, label boxes), port and stub
 * coordinates, centrelines (plus parallel tracks) of the channels between
 * obstacles, and a coarse background grid. A* over (grid point, heading)
 * minimises length + bends, and penalises crossing, touching or running
 * along wires that are already routed.
 * ========================================================================= */

const ROUTE = { margin: 0.125, bend: 0.4, cross: 0.15, overlap: 6, touch: 2.0, track: 0.125, coarse: 0.5 };
const HEAD = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // E N W S
const headOf = (d) => (d[0] > 0.5 ? 0 : d[1] > 0.5 ? 1 : d[0] < -0.5 ? 2 : 3);
// all routing coordinates are quantised to 0.001" so equal positions compare equal
const Q = (v) => Math.round(v * 1000) / 1000;
const kf = (v) => Math.round(v * 1000);

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

class Router {
  constructor(doc, geoms) {
    this.doc = doc;
    this.geoms = geoms;
    const M = ROUTE.margin;
    const obs = [];
    const q = (r) => r.map(Q);
    for (const [id, g] of geoms) {
      if (g.sym.junction) continue;
      obs.push({ r: q(R.inflate(g.body, M)), id });
      if (g.label) obs.push({ r: q(R.inflate(g.label.box, 0.03)), id });
    }
    const nt = notesLayout(doc).top;
    obs.push({ r: [IX1 - TB_W - 0.1, IY0 - 1, IX1 + 1, nt + 0.1], id: null });
    this.obs = obs;
    this.area = [IX0 + 0.06, IY0 + 0.06, IX1 - 0.06, IY1 - 0.06];
    this.hOcc = new Map(); // y key -> [[x0, x1, id]]
    this.vOcc = new Map(); // x key -> [[y0, y1, id]]
    this.verts = new Map(); // "x,y" key -> Set(id)
  }

  // ------------------------------------------------------------ occupancy
  occupy(id, pts) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      if (Math.abs(a[1] - b[1]) < 1e-6) {
        const k = kf(a[1]);
        if (!this.hOcc.has(k)) this.hOcc.set(k, []);
        this.hOcc.get(k).push([Math.min(a[0], b[0]), Math.max(a[0], b[0]), id]);
      } else {
        const k = kf(a[0]);
        if (!this.vOcc.has(k)) this.vOcc.set(k, []);
        this.vOcc.get(k).push([Math.min(a[1], b[1]), Math.max(a[1], b[1]), id]);
      }
    }
    for (const p of pts) {
      const k = kf(p[0]) + "," + kf(p[1]);
      if (!this.verts.has(k)) this.verts.set(k, new Set());
      this.verts.get(k).add(id);
    }
  }

  // ------------------------------------------------------------- the grid
  endSpec(g, pid, toward) {
    const p = portOf(g, pid);
    const M = ROUTE.margin;
    if (p.bus) {
      const [x0, y0, x1, y1] = p.seg;
      const horiz = Math.abs(y0 - y1) < 1e-9;
      const off = (horiz ? R.h(g.body) : R.w(g.body)) / 2 + M;
      return { bus: true, horiz, seg: p.seg, dir: p.dir, line: Q(horiz ? y0 + p.dir[1] * off : x0 + p.dir[0] * off),
               lo: Q((horiz ? x0 : y0) + 0.0625), hi: Q((horiz ? x1 : y1) - 0.0625), toward };
    }
    return { bus: false, x: p.x, y: p.y, dir: p.dir, sx: Q(p.x + p.dir[0] * M), sy: Q(p.y + p.dir[1] * M) };
  }

  build(specs) {
    const [ax0, ay0, ax1, ay1] = this.area;
    const X = new Set(), Y = new Set();
    const addX = (v) => { if (v >= ax0 - 1e-9 && v <= ax1 + 1e-9) X.add(Q(v)); };
    const addY = (v) => { if (v >= ay0 - 1e-9 && v <= ay1 + 1e-9) Y.add(Q(v)); };
    addX(ax0); addX(ax1); addY(ay0); addY(ay1);
    for (const { r } of this.obs) { addX(r[0]); addX(r[2]); addY(r[1]); addY(r[3]); }
    for (const s of specs) {
      if (s.bus) {
        if (s.horiz) addY(s.line); else addX(s.line);
        if (s.toward) { if (s.horiz) addX(clamp(s.toward[0], s.lo, s.hi)); else addY(clamp(s.toward[1], s.lo, s.hi)); }
      } else { addX(s.x); addY(s.y); addX(s.sx); addY(s.sy); }
    }
    // channel centrelines and tracks
    const channels = (vals, add) => {
      const v = [...vals].sort((a, b) => a - b);
      for (let i = 0; i < v.length - 1; i++) {
        const [a, b] = [v[i], v[i + 1]];
        if (b - a < 0.2) continue;
        const mid = (a + b) / 2;
        add(mid);
        for (let k = 1; k <= 3; k++) {
          for (const t of [mid - k * ROUTE.track, mid + k * ROUTE.track]) if (t > a + 0.06 && t < b - 0.06) add(t);
        }
      }
    };
    const obsX = new Set(), obsY = new Set();
    for (const { r } of this.obs) { obsX.add(r[0]); obsX.add(r[2]); obsY.add(r[1]); obsY.add(r[3]); }
    obsX.add(ax0); obsX.add(ax1); obsY.add(ay0); obsY.add(ay1);
    channels(obsX, addX); channels(obsY, addY);
    for (let x = Math.ceil(ax0 / ROUTE.coarse) * ROUTE.coarse; x < ax1; x += ROUTE.coarse) addX(x);
    for (let y = Math.ceil(ay0 / ROUTE.coarse) * ROUTE.coarse; y < ay1; y += ROUTE.coarse) addY(y);

    const xs = [...X].sort((a, b) => a - b), ys = [...Y].sort((a, b) => a - b);
    const nx = xs.length, ny = ys.length;
    const nodeB = new Uint8Array(nx * ny), hB = new Uint8Array(nx * ny), vB = new Uint8Array(nx * ny);
    const eps = 1e-6;
    for (const { r } of this.obs) {
      const i0 = lowerBound(xs, r[0] - eps), i1 = lowerBound(xs, r[2] + eps);   // xs[i0..i1-1] within [x0, x1]
      const j0 = lowerBound(ys, r[1] - eps), j1 = lowerBound(ys, r[3] + eps);
      for (let j = j0; j < j1; j++) {
        const yIn = ys[j] > r[1] + eps && ys[j] < r[3] - eps;
        for (let i = i0; i < i1; i++) {
          const xIn = xs[i] > r[0] + eps && xs[i] < r[2] - eps;
          if (xIn && yIn) nodeB[j * nx + i] = 1;
          // horizontal move (i -> i+1) along row j crosses the interior
          if (yIn && i + 1 < i1) hB[j * nx + i] = 1;
          // vertical move (j -> j+1) along column i crosses the interior
          if (xIn && j + 1 < j1) vB[j * nx + i] = 1;
        }
      }
    }
    Object.assign(this, { xs, ys, nx, ny, nodeB, hB, vB });
    this.xi = new Map(xs.map((v, i) => [kf(v), i]));
    this.yi = new Map(ys.map((v, i) => [kf(v), i]));
  }

  idx(x, y) {
    const i = this.xi.get(kf(x)), j = this.yi.get(kf(y));
    return i === undefined || j === undefined ? -1 : j * this.nx + i;
  }

  /** Grid nodes along a bus stub line, with the heading that leads away from / into the bus. */
  busNodes(s) {
    const out = [];
    if (s.horiz) {
      const j = this.yi.get(kf(s.line));
      if (j === undefined) return out;
      for (let i = 0; i < this.nx; i++) if (this.xs[i] >= s.lo && this.xs[i] <= s.hi) out.push(j * this.nx + i);
    } else {
      const i = this.xi.get(kf(s.line));
      if (i === undefined) return out;
      for (let j = 0; j < this.ny; j++) if (this.ys[j] >= s.lo && this.ys[j] <= s.hi) out.push(j * this.nx + i);
    }
    return out.filter((k) => !this.nodeB[k]);
  }

  /** Does the straight segment a-b pass through any obstacle (other than the given owners)? */
  blockedSegment(a, b, ignore) {
    const r = R.of(a[0], a[1], b[0], b[1]);
    return this.obs.some((o) => !ignore.includes(o.id) && R.overlaps(R.inflate(o.r, -ROUTE.margin + 0.02), r, -1e-9));
  }

  // -------------------------------------------------------------- costs
  overlapCost(horiz, line, a, b, id) {
    const list = (horiz ? this.hOcc : this.vOcc).get(kf(line));
    if (!list) return 0;
    let c = 0;
    const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
    for (const [s0, s1, oid] of list) {
      if (oid === id) continue;
      const ov = Math.min(hi, s1) - Math.max(lo, s0);
      if (ov > 1e-6) c += ROUTE.overlap * (1 + ov);
    }
    return c;
  }

  /** Another wire passes through point (x, y) perpendicular to `horiz` motion. */
  crossesAt(horiz, x, y, id) {
    const list = (horiz ? this.vOcc : this.hOcc).get(kf(horiz ? x : y));
    if (!list) return false;
    const v = horiz ? y : x;
    return list.some(([s0, s1, oid]) => oid !== id && v > s0 + 1e-6 && v < s1 - 1e-6);
  }

  occupiedAt(x, y, id) {
    const vs = this.verts.get(kf(x) + "," + kf(y));
    if (vs && [...vs].some((o) => o !== id)) return true;
    return this.crossesAt(true, x, y, id) || this.crossesAt(false, x, y, id);
  }

  // ----------------------------------------------------------------- A*
  search(starts, goals, id, goalBox) {
    const { nx, ny, xs, ys } = this;
    const N = nx * ny * 4;
    const gS = new Float64Array(N).fill(Infinity);
    const from = new Int32Array(N).fill(-1);
    const heap = new Heap();
    const h = (k) => {
      const i = k % nx, j = (k / nx) | 0;
      const x = xs[i], y = ys[j];
      const dx = x < goalBox[0] ? goalBox[0] - x : x > goalBox[2] ? x - goalBox[2] : 0;
      const dy = y < goalBox[1] ? goalBox[1] - y : y > goalBox[3] ? y - goalBox[3] : 0;
      return dx + dy;
    };
    for (const { k, hd } of starts) {
      const s = k * 4 + hd;
      gS[s] = 0;
      heap.push(s, h(k));
    }
    let expansions = 0;
    let best = null;
    while (heap.size) {
      const s = heap.pop();
      const k = s >> 2, hd = s & 3;
      const g0 = gS[s];
      if (best && g0 + h(k) >= best.cost) break;
      if (++expansions > 400000) break;
      const req = goals.get(k);
      if (req !== undefined && req !== (hd + 2) % 4) {
        const cost = g0 + (req === hd ? 0 : ROUTE.bend);
        if (!best || cost < best.cost) best = { cost, s };
      }
      const i = k % nx, j = (k / nx) | 0;
      for (const nh of [hd, (hd + 1) % 4, (hd + 3) % 4]) {
        let ni = i, nj = j;
        if (nh === 0) { if (i + 1 >= nx || this.hB[j * nx + i]) continue; ni = i + 1; }
        else if (nh === 2) { if (i === 0 || this.hB[j * nx + i - 1]) continue; ni = i - 1; }
        else if (nh === 1) { if (j + 1 >= ny || this.vB[j * nx + i]) continue; nj = j + 1; }
        else { if (j === 0 || this.vB[(j - 1) * nx + i]) continue; nj = j - 1; }
        const nk = nj * nx + ni;
        if (this.nodeB[nk]) continue;
        const horiz = nh === 0 || nh === 2;
        let c = g0 + Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]);
        if (nh !== hd) {
          c += ROUTE.bend;
          if (this.occupiedAt(xs[i], ys[j], id)) c += ROUTE.touch;
        }
        c += horiz ? this.overlapCost(true, ys[j], xs[i], xs[ni], id) : this.overlapCost(false, xs[i], ys[j], ys[nj], id);
        if (this.crossesAt(horiz, xs[ni], ys[nj], id)) c += ROUTE.cross;
        const ns = nk * 4 + nh;
        if (c < gS[ns] - 1e-9) {
          gS[ns] = c;
          from[ns] = s;
          heap.push(ns, c + h(nk));
        }
      }
    }
    if (!best) return null;
    const seq = [];
    for (let s = best.s; s !== -1; s = from[s]) seq.push(s >> 2);
    seq.reverse();
    return seq.map((k) => [this.xs[k % nx], this.ys[(k / nx) | 0]]);
  }

  route(e) {
    const ga = this.geoms.get(e.from.n), gb = this.geoms.get(e.to.n);
    const A = e._A, B = e._B;
    const startList = [], goals = new Map();
    let goalBox;
    if (A.bus) {
      for (const k of this.busNodes(A)) startList.push({ k, hd: headOf(A.dir) });
    } else {
      const k = this.idx(A.sx, A.sy);
      if (k >= 0 && !this.nodeB[k]) startList.push({ k, hd: headOf(A.dir) });
    }
    if (B.bus) {
      const req = headOf([-B.dir[0], -B.dir[1]]);
      for (const k of this.busNodes(B)) goals.set(k, req);
      goalBox = B.horiz ? [B.lo, B.line, B.hi, B.line] : [B.line, B.lo, B.line, B.hi];
    } else {
      const k = this.idx(B.sx, B.sy);
      if (k >= 0 && !this.nodeB[k]) goals.set(k, headOf([-B.dir[0], -B.dir[1]]));
      goalBox = [B.sx, B.sy, B.sx, B.sy];
    }
    // facing ports on one line with nothing between them: connect directly
    if (!A.bus && !B.bus && A.dir[0] === -B.dir[0] && A.dir[1] === -B.dir[1]) {
      const along = (B.x - A.x) * A.dir[0] + (B.y - A.y) * A.dir[1];
      const offAxis = Math.abs((B.x - A.x) * A.dir[1]) + Math.abs((B.y - A.y) * A.dir[0]);
      if (along > 0 && offAxis < 2e-3 && !this.blockedSegment([A.x, A.y], [B.x, B.y], [e.from.n, e.to.n])) {
        return A.dir[0] ? [[A.x, A.y], [B.x, A.y]] : [[A.x, A.y], [A.x, B.y]];
      }
    }
    if (!startList.length || !goals.size || !ga || !gb) return null;
    const mid = this.search(startList, goals, e.id, goalBox);
    if (!mid) return null;
    const first = mid[0], last = mid[mid.length - 1];
    const pa = A.bus ? (A.horiz ? [first[0], A.seg[1]] : [A.seg[0], first[1]]) : [A.x, A.y];
    const pb = B.bus ? (B.horiz ? [last[0], B.seg[1]] : [B.seg[0], last[1]]) : [B.x, B.y];
    const pts = simplifyPath([[Q(pa[0]), Q(pa[1])], ...mid, [Q(pb[0]), Q(pb[1])]]);
    // put the exact port coordinates back, keeping the end segments orthogonal
    const fix = (end, i, j) => {
      const p = pts[i], q = pts[j];
      if (Math.abs(p[0] - q[0]) < 1e-9) q[0] = end[0]; else q[1] = end[1];
      pts[i] = [end[0], end[1]];
    };
    if (pts.length >= 2) { fix(pa, 0, 1); fix(pb, pts.length - 1, pts.length - 2); }
    return pts;
  }
}

/**
 * Route edges. `ids`: edges to (re)route (default: all). Other edges keep
 * their paths and count as occupied.
 */
function routeEdges(doc, ids = null, geoms = null) {
  geoms = geoms || allGeoms(doc);
  const router = new Router(doc, geoms);
  const todo = doc.edges.filter((e) => !ids || ids.has(e.id));
  const todoSet = new Set(todo.map((e) => e.id));
  for (const e of doc.edges) if (!todoSet.has(e.id) && e.pts) router.occupy(e.id, e.pts);
  for (const e of todo) {
    const ga = geoms.get(e.from.n), gb = geoms.get(e.to.n);
    if (!ga || !gb) continue;
    const pa = portOf(ga, e.from.p), pb = portOf(gb, e.to.p);
    e._A = router.endSpec(ga, e.from.p, [pb.x, pb.y]);
    e._B = router.endSpec(gb, e.to.p, [pa.x, pa.y]);
  }
  router.build(todo.filter((e) => e._A).flatMap((e) => [e._A, e._B]));
  const len = (e) => {
    if (!e._A) return 0;
    const a = e._A.bus ? e._A.toward || [0, 0] : [e._A.x, e._A.y];
    const b = e._B.bus ? e._B.toward || [0, 0] : [e._B.x, e._B.y];
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  };
  const order = [...todo].sort((a, b) => len(a) - len(b));
  let failed = 0;
  for (const e of order) {
    if (!e._A) continue;
    let pts = router.route(e);
    if (!pts) { pts = provisionalPath(doc, e, geoms); failed++; e.routeFailed = true; }
    else delete e.routeFailed;
    e.pts = pts;
    if (pts) router.occupy(e.id, pts);
    delete e._A; delete e._B;
  }
  return { failed };
}
