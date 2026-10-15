/* =========================================================================
 * Auto-arrange: layered tree layout with contour packing.
 *
 * Coordinates: m = along the flow (down or right), c = across it.
 *  1. Satellites (instruments, vents, expansion tanks with one connection)
 *     ride alongside their host.
 *  2. A spanning tree is grown from the sources. Port sides decide
 *     direction: a neighbour on a node's upstream-facing port is a "feeder"
 *     (one rank up), anything else is a child (one rank down). Each node is
 *     rotated so the connecting port faces its parent.
 *  3. Subtrees are packed across the flow using per-rank contours; runs are
 *     aligned port-to-port so connections are straight; buses stretch to
 *     span their branches.
 *  4. Rank and sibling gaps are scaled so the drawing fills the free sheet
 *     area (or compressed, then symbols scaled down, if it doesn't fit).
 * ========================================================================= */

function autoArrange(doc, { route = true } = {}) {
  const F = { m: flowVec(doc), c: crossVec(doc) };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const lib = libOf(doc);
  const baseRot = rotBetween(LIB_FLOW[lib], F.m);
  const sp = spacingOf(doc);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const symOf = (id) => SYMBOLS[byId.get(id).sym];

  // ------------------------------------------------------------ adjacency
  const adj = new Map(doc.nodes.map((n) => [n.id, []]));
  for (const e of doc.edges) {
    if (e.from.n === e.to.n || !adj.has(e.from.n) || !adj.has(e.to.n)) continue;
    adj.get(e.from.n).push({ e, p: e.from.p, o: e.to.n, q: e.to.p });
    adj.get(e.to.n).push({ e, p: e.to.p, o: e.from.n, q: e.from.p });
  }
  const conn = new Map(doc.nodes.map((n) => [n.id, new Set(adj.get(n.id).map((l) => l.p))]));

  const canonDir = (id, pid) => {
    const n = byId.get(id);
    const ports = SYMBOLS[n.sym].ports(n, doc);
    const p = ports.find((x) => x.id === pid) || ports[0];
    return DIRS[p.dir];
  };
  const worldDir = (id, pid, rot) => rotVec(...canonDir(id, pid), rot);

  // ----------------------------------------------------------- satellites
  const satOf = new Map();    // satellite id -> link from satellite to host
  const satsOn = new Map();   // host id -> [satellite ids]
  for (const n of doc.nodes) {
    const sym = SYMBOLS[n.sym], links = adj.get(n.id);
    if (!sym.satellite || links.length !== 1) continue;
    const hs = symOf(links[0].o);
    if (hs.satellite || hs.bus) continue;
    satOf.set(n.id, links[0]);
    if (!satsOn.has(links[0].o)) satsOn.set(links[0].o, []);
    satsOn.get(links[0].o).push(n.id);
  }

  // ------------------------------------------------------------- the tree
  const posKey = (n) => [dot([n.x, n.y], F.m), dot([n.x, n.y], F.c)];
  const mains = doc.nodes.filter((n) => !satOf.has(n.id));
  const rootOrder = [...mains].sort((a, b) => {
    const pa = SYMBOLS[a.sym].primary ? 0 : SYMBOLS[a.sym].source ? 1 : 2;
    const pb = SYMBOLS[b.sym].primary ? 0 : SYMBOLS[b.sym].source ? 1 : 2;
    if (pa !== pb) return pa - pb;
    const [am, ac] = posKey(a), [bm, bc] = posKey(b);
    return Math.abs(am - bm) > 0.05 ? am - bm : ac - bc;
  });
  // Grow the tree with prioritised links so loops break at their return side:
  //  tier 0: downstream links entering V on its natural inlet side (no rotation needed)
  //  tier 1: other downstream links;  tier 2: upstream "feeder" links.
  const info = new Map();
  const roots = [];
  const inletSide = (id, pid) => {
    const sym = symOf(id);
    if (sym.junction || sym.bus || sym.instrument) return true;
    const d = canonDir(id, pid), f = LIB_FLOW[sym.lib];
    return dot(d, f) < -0.5;
  };
  for (const r of rootOrder) {
    if (info.has(r.id)) continue;
    roots.push(r.id);
    info.set(r.id, { rank: 0, rot: baseRot, parent: null, kids: [], root: r.id });
    const tiers = [[], [], []];
    const enqueue = (U) => {
      const I = info.get(U);
      for (const L of adj.get(U)) {
        if (info.has(L.o) || satOf.has(L.o)) continue;
        const side = dot(worldDir(U, L.p, I.rot), F.m);
        const tier = side < -0.5 ? 2 : inletSide(L.o, L.q) ? 0 : 1;
        tiers[tier].push({ U, L, side });
      }
    };
    enqueue(r.id);
    for (;;) {
      const t = tiers.findIndex((q) => q.length);
      if (t < 0) break;
      const { U, L, side } = tiers[t].shift();
      if (info.has(L.o)) continue;
      const I = info.get(U);
      const feeder = side < -0.5;
      const want = feeder ? F.m : [-F.m[0], -F.m[1]];
      const rot = rotBetween(canonDir(L.o, L.q), want);
      info.set(L.o, { rank: I.rank + (feeder ? -1 : 1), rot, parent: U, pp: L.p, q: L.q, feeder,
                      down: side > 0.5, kids: [], root: r.id, edge: L.e });
      I.kids.push(L.o);
      enqueue(L.o);
    }
  }
  // satellites: connected port faces the host side
  const satSide = new Map();
  for (const [sid, L] of satOf) {
    const H = info.get(L.o);
    if (!H) continue;
    const hd = worldDir(L.o, L.q, H.rot);
    const side = dot(hd, F.c) > 0.5 ? 1 : -1;       // place where the host port points
    satSide.set(sid, side);
    info.set(sid, { rank: H.rank, rot: rotBetween(canonDir(sid, L.p), [-side * F.c[0], -side * F.c[1]]),
                    sat: true, host: L.o, kids: [] });
  }

  // --------------------------------------------------------- measurements
  const geomAt = (id, rot, len) => {
    const n = byId.get(id);
    const tmp = { ...n, x: 0, y: 0, rot, flip: false, ...(len ? { len } : {}) };
    return computeGeom(doc, tmp, conn.get(id));
  };
  const extOf = (g) => {
    const r = g.keep, pts = [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]];
    const ms = pts.map((p) => dot(p, F.m)), cs = pts.map((p) => dot(p, F.c));
    return { mMin: Math.min(...ms), mMax: Math.max(...ms), cMin: Math.min(...cs), cMax: Math.max(...cs) };
  };
  const portOff = (g, pid) => { const p = portOf(g, pid); return { m: dot([p.x, p.y], F.m), c: dot([p.x, p.y], F.c) }; };
  const edgeLabelSize = (e) => {
    const t = String(e?.label || "").trim();
    if (!t) return null;
    const lines = t.split("\n").filter((x) => x.trim());
    const font = docFont(doc);
    const W = Math.max(...lines.map((l) => textWidth(doc.uppercase ? l.toUpperCase() : l, TEXT_H.edge, false, font)));
    const H = lines.length * TEXT_H.edge * LINE_SPACING;
    return { W, H };
  };

  // ---------------------------------------------------------- one layout
  function compute(kc, km, foldLen = Infinity) {
    const gapC = sp.gap * kc, gapM = sp.gap * km;
    const blocks = new Map();   // id -> {E (m/c extents incl. satellites), g}
    const lens = new Map();
    const satPos = new Map();   // sat id -> {m, c} relative to host

    const ownBlock = (id) => {
      const I = info.get(id);
      const g = geomAt(id, I.rot, lens.get(id));
      const E = extOf(g);
      // edge label from the parent sits beside the incoming run
      if (I.parent && I.edge) {
        const ls = edgeLabelSize(I.edge);
        if (ls) {
          const pq = portOff(g, I.q);
          if (doc.flow === "down") E.cMax = Math.max(E.cMax, pq.c + ls.W + 0.15);
          else E.cMin = Math.min(E.cMin, pq.c - ls.H - 0.15);
        }
      }
      // satellites
      const sats = satsOn.get(id) || [];
      const placed = [];
      for (const sid of sats) {
        const S = info.get(sid), L = satOf.get(sid);
        const gs = geomAt(sid, S.rot);
        const ES = extOf(gs);
        const side = satSide.get(sid);
        const hp = portOff(g, L.q), sq = portOff(gs, L.p);
        const c = side < 0 ? E.cMin - gapC * 0.5 - ES.cMax : E.cMax + gapC * 0.5 - ES.cMin;
        placed.push({ sid, ES, c, want: hp.m - sq.m, side });
      }
      // spread satellites on the same side along the flow
      for (const side of [-1, 1]) {
        const group = placed.filter((p) => p.side === side).sort((a, b) => a.want - b.want);
        let last = -Infinity;
        for (const p of group) {
          p.m = Math.max(p.want, last - p.ES.mMin + gapC * 0.5);
          last = p.m + p.ES.mMax;
        }
        // keep the group centred on where its connections want it
        if (group.length > 1) {
          const avg = (k) => group.reduce((a, p) => a + p[k], 0) / group.length;
          const shift = avg("want") - avg("m");
          for (const p of group) p.m += shift;
        }
      }
      for (const p of placed) {
        satPos.set(p.sid, { m: p.m, c: p.c });
        E.mMin = Math.min(E.mMin, p.m + p.ES.mMin); E.mMax = Math.max(E.mMax, p.m + p.ES.mMax);
        E.cMin = Math.min(E.cMin, p.c + p.ES.cMin); E.cMax = Math.max(E.cMax, p.c + p.ES.cMax);
      }
      blocks.set(id, { E, g });
      return { E, g };
    };

    const kidPos = new Map();
    const addCont = (cont, rank, lo, hi) => {
      const cur = cont.get(rank);
      cont.set(rank, cur ? [Math.min(cur[0], lo), Math.max(cur[1], hi)] : [lo, hi]);
    };

    /** Lay out the subtree of U (U at c = 0). Returns its contour: rank -> [lo, hi]. */
    function layout(U, parentBlock) {
      const I = info.get(U);
      const isBus = symOf(U).bus;
      const pre = isBus ? null : ownBlock(U);
      const subs = I.kids.map((V) => {
        const J = info.get(V);
        let desired = null;
        if (!isBus) {
          const gv = geomAt(V, J.rot, null);
          desired = portOff(pre.g, J.pp).c - portOff(gv, J.q).c;
        }
        return { V, J, desired };
      });
      for (const s of subs) {
        const pb = s.desired != null && pre ? { rank: I.rank, lo: pre.E.cMin - s.desired, hi: pre.E.cMax - s.desired } : null;
        s.cont = layout(s.V, pb);
        const n = byId.get(s.V);
        s.key = s.desired != null ? s.desired : dot([n.x, n.y], F.c);
      }
      subs.sort((a, b) => a.key - b.key || (a.J.feeder - b.J.feeder));

      const merged = new Map();
      if (parentBlock) addCont(merged, parentBlock.rank, parentBlock.lo, parentBlock.hi);
      if (pre) addCont(merged, I.rank, pre.E.cMin, pre.E.cMax);
      const minRight = (cont) => {
        let v = -Infinity;
        for (const [r, [lo]] of cont) { const m = merged.get(r); if (m) v = Math.max(v, m[1] - lo + gapC); }
        return v;
      };
      const maxLeft = (cont) => {
        let v = Infinity;
        for (const [r, [, hi]] of cont) { const m = merged.get(r); if (m) v = Math.min(v, m[0] - hi - gapC); }
        return v;
      };
      const put = (s, pos) => {
        s.pos = pos;
        for (const [r, [lo, hi]] of s.cont) addCont(merged, r, lo + pos, hi + pos);
      };
      let anchor = subs.findIndex((s) => s.J.down && Math.abs(s.desired ?? 1) < 1e-6);
      if (anchor < 0) anchor = subs.findIndex((s) => s.J.down);
      if (anchor >= 0) put(subs[anchor], subs[anchor].desired ?? 0);
      let last = anchor >= 0 ? subs[anchor].pos : 0;
      for (let k = anchor + 1; k < subs.length; k++) {
        const s = subs[k];
        let pos = Math.max(s.desired ?? -Infinity, minRight(s.cont));
        if (!Number.isFinite(pos)) pos = s.desired ?? last;
        put(s, pos); last = pos;
      }
      last = anchor >= 0 ? subs[anchor].pos : 0;
      for (let k = anchor - 1; k >= 0; k--) {
        const s = subs[k];
        let pos = Math.min(s.desired ?? Infinity, maxLeft(s.cont));
        if (!Number.isFinite(pos)) pos = s.desired ?? last;
        put(s, pos); last = pos;
      }

      // centre buses over their branches; centre plain fan-outs
      let shift = 0;
      if (isBus && subs.length) {
        const att = subs.map((s) => s.pos + portOff(geomAt(s.V, s.J.rot, null), s.J.q).c);
        const lo = Math.min(...att), hi = Math.max(...att);
        shift = (lo + hi) / 2;
        const L = Math.max(hi - lo + 0.8, 1.0);
        lens.set(U, L / doc.symScale);
      } else if (isBus) {
        lens.set(U, Math.max(byId.get(U).len || SYMBOLS[byId.get(U).sym].defLen, 1.0));
      } else if (anchor < 0 && subs.length > 1 && subs.every((s) => Math.abs((s.desired ?? 0) - (subs[0].desired ?? 0)) < 1e-6)) {
        shift = (subs[0].pos + subs[subs.length - 1].pos) / 2 - (subs[0].desired ?? 0);
      }
      const own = pre || ownBlock(U);
      const cont = new Map();
      addCont(cont, I.rank, own.E.cMin, own.E.cMax);
      for (const s of subs) {
        s.pos -= shift;
        kidPos.set(s.V, s.pos);
        for (const [r, [lo, hi]] of s.cont) addCont(cont, r, lo + s.pos, hi + s.pos);
      }
      return cont;
    }

    // components side by side
    const compPos = new Map();
    const forest = new Map();
    const conts = roots.map((r) => ({ r, cont: layout(r, null) }));
    // normalise ranks so every component starts at rank 0
    const rankShift = new Map();
    for (const { r, cont } of conts) {
      const minR = Math.min(...cont.keys());
      rankShift.set(r, -minR);
      const c2 = new Map();
      for (const [k, v] of cont) c2.set(k - minR, v);
      forest.set(r, c2);
    }
    const merged = new Map();
    let lastPos = 0;
    conts.forEach(({ r }, i) => {
      const cont = forest.get(r);
      let pos = 0;
      if (i) {
        pos = -Infinity;
        for (const [k, [lo]] of cont) { const m = merged.get(k); if (m) pos = Math.max(pos, m[1] - lo + gapC * 2); }
        if (!Number.isFinite(pos)) pos = lastPos;
      }
      compPos.set(r, pos);
      lastPos = pos;
      for (const [k, [lo, hi]] of cont) addCont(merged, k, lo + pos, hi + pos);
    });

    // absolute c and rank for every node
    const C = new Map(), RK = new Map();
    const walk = (U, c, rs) => {
      C.set(U, c);
      RK.set(U, info.get(U).rank + rs);
      for (const V of info.get(U).kids) walk(V, c + kidPos.get(V), rs);
    };
    for (const r of roots) walk(r, compPos.get(r), rankShift.get(r));

    // rank positions along the flow
    const ranks = [...new Set(RK.values())].sort((a, b) => a - b);
    const up = new Map(), down = new Map(), need = new Map();
    for (const [id, r] of RK) {
      const { E } = blocks.get(id);
      up.set(r, Math.max(up.get(r) ?? 0, -E.mMin));
      down.set(r, Math.max(down.get(r) ?? 0, E.mMax));
      const I = info.get(id);
      if (I.parent && I.edge) {
        const ls = edgeLabelSize(I.edge);
        if (ls) {
          const gapRank = Math.min(r, RK.get(I.parent));
          need.set(gapRank, Math.max(need.get(gapRank) ?? 0, (doc.flow === "down" ? ls.H : ls.W) + 0.2));
        }
      }
    }
    const M = new Map();
    let m = 0;
    ranks.forEach((r, i) => {
      if (i) {
        const pr = ranks[i - 1];
        m += down.get(pr) + Math.max(gapM, need.get(pr) ?? 0) + up.get(r);
      }
      M.set(r, m);
    });

    // fold long flows into bands (rows for flow-right, columns for flow-down)
    const bandM = new Map(), bandC = new Map();   // rank -> shifts
    const lo = (r) => M.get(r) - up.get(r), hi = (r) => M.get(r) + down.get(r);
    let folded = false;
    if (ranks.length > 2 && hi(ranks[ranks.length - 1]) - lo(ranks[0]) > foldLen) {
      // connections crossing each rank boundary (fewer = better place to fold)
      const crossing = new Map();
      for (const e of doc.edges) {
        const ra = RK.get(e.from.n) ?? RK.get(satOf.get(e.from.n)?.o), rb = RK.get(e.to.n) ?? RK.get(satOf.get(e.to.n)?.o);
        if (ra == null || rb == null) continue;
        for (const r of ranks) if (r >= Math.min(ra, rb) && r < Math.max(ra, rb)) crossing.set(r, (crossing.get(r) || 0) + 1);
      }
      const bands = [];
      let i = 0;
      while (i < ranks.length) {
        const start = lo(ranks[i]);
        let j = i;
        while (j + 1 < ranks.length && hi(ranks[j + 1]) - start <= foldLen) j++;
        if (j + 1 < ranks.length && j > i) {
          // best cut in the back half of the band: fewest crossings, then latest
          let bestJ = j, bestX = Infinity;
          for (let k = j; k >= i + Math.max(1, Math.floor((j - i) / 2)); k--) {
            const x = crossing.get(ranks[k]) || 0;
            if (x < bestX) { bestX = x; bestJ = k; }
          }
          j = bestJ;
        }
        bands.push(ranks.slice(i, j + 1));
        i = j + 1;
      }
      if (bands.length > 1) {
        folded = true;
        let cOff = 0, prevMax = null;
        const m0 = lo(ranks[0]);
        for (const band of bands) {
          const set = new Set(band);
          let cMin = Infinity, cMax = -Infinity;
          for (const [id, c] of C) {
            if (!set.has(RK.get(id))) continue;
            const { E } = blocks.get(id);
            cMin = Math.min(cMin, c + E.cMin); cMax = Math.max(cMax, c + E.cMax);
          }
          if (prevMax != null) cOff = prevMax - cMin + gapC * 3;
          const mShift = m0 - lo(band[0]);
          for (const r of band) { bandM.set(r, mShift); bandC.set(r, cOff); }
          prevMax = cMax + cOff;
        }
      }
    }

    // world positions (relative) and bounding box
    const out = new Map();
    let bbox = null;
    const boxes = [];
    const bandOf = new Map();
    let bi = 0, lastShift = null;
    for (const r of ranks) { const k = bandC.get(r) || 0; if (lastShift !== null && k !== lastShift) bi++; lastShift = k; bandOf.set(r, bi); }
    const place = (id, mm, cc, rot, len, r) => {
      const x = mm * F.m[0] + cc * F.c[0], y = mm * F.m[1] + cc * F.c[1];
      out.set(id, { x, y, rot, len, rank: r, band: bandOf.get(r) });
    };
    for (const [id, c0] of C) {
      const r = RK.get(id), I = info.get(id);
      const mm = M.get(r) + (bandM.get(r) || 0), c = c0 + (bandC.get(r) || 0);
      place(id, mm, c, I.rot, lens.get(id), r);
      const { E } = blocks.get(id);
      const pts = [[mm + E.mMin, c + E.cMin], [mm + E.mMax, c + E.cMax]]
        .map(([a, b]) => [a * F.m[0] + b * F.c[0], a * F.m[1] + b * F.c[1]]);
      const box = R.of(pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
      boxes.push(box);
      bbox = R.union(bbox, box);
      for (const sid of satsOn.get(id) || []) {
        const s = satPos.get(sid);
        if (s) place(sid, mm + s.m, c + s.c, info.get(sid).rot, undefined, r);
      }
    }
    return { out, boxes, folded, bbox: bbox || [0, 0, 0, 0] };
  }

  // ---------------------------------------------------------- fit to sheet
  // The free area is the sheet minus the title-block/notes corner (an L shape).
  const area = drawingArea(doc, notesLayout(doc).top);
  const O = area.outer, RS = R.inflate(area.reserved, 0.15);

  /** Find a grid-snapped translation that puts the layout on the sheet clear of the corner. */
  const placeable = (L) => {
    const bb = L.bbox;
    if (R.w(bb) > R.w(O) + 1e-6 || R.h(bb) > R.h(O) + 1e-6) return null;
    const txMin = O[0] - bb[0], txMax = O[2] - bb[2], tyMin = O[1] - bb[1], tyMax = O[3] - bb[3];
    const clear = (tx, ty) => !L.boxes.some((b) => R.overlaps(R.shift(b, tx, ty), RS));
    const tx0 = snap((txMin + txMax) / 2, GRID), ty0 = snap((tyMin + tyMax) / 2, GRID);
    const tries = [[tx0, ty0]];
    // slide left, up, or both until the corner is clear
    const hits = (tx, ty) => L.boxes.map((b) => R.shift(b, tx, ty)).filter((b) => R.overlaps(b, RS));
    let h = hits(tx0, ty0);
    if (h.length) {
      const left = Math.max(txMin, tx0 - (Math.max(...h.map((b) => b[2])) - RS[0]));
      const up = Math.min(tyMax, ty0 + (RS[3] - Math.min(...h.map((b) => b[1]))));
      tries.push([snap(left - GRID / 2, GRID), ty0], [tx0, snap(up + GRID / 2, GRID)], [snap(left - GRID / 2, GRID), snap(up + GRID / 2, GRID)]);
      tries.push([txMin, tyMax], [txMin, ty0]);
    }
    for (const [tx, ty] of tries) {
      const x = clamp(tx, txMin, txMax), y = clamp(ty, tyMin, tyMax);
      if (clear(x, y)) return { tx: x, ty: y };
    }
    return null;
  };
  const mLen = doc.flow === "down" ? R.h(O) : R.w(O);
  let fold = Infinity;
  const okAt = (s, kc, km) => { doc.symScale = s; const L = compute(kc, km, fold); const t = placeable(L); return t ? { L, t } : null; };
  /** Largest x in [lo, hi] with f(x) true, assuming f(lo) is true. */
  const bsearch = (lo, hi, f) => {
    if (f(hi)) return hi;
    for (let i = 0; i < 6; i++) { const mid = (lo + hi) / 2; if (f(mid)) lo = mid; else hi = mid; }
    return lo;
  };

  const warnings = [];
  const scale0 = doc.symScale;
  let s = scale0, kc = 1, km = 1, kHi = 1;
  if (!okAt(s, 0.5, 0.5)) {
    // too long for the sheet: fold the flow into bands before shrinking symbols
    for (const f of [mLen, mLen * 0.92, mLen * 0.8]) {
      fold = f;
      if (okAt(s, 0.5, 0.5)) break;
      fold = Infinity;
    }
  }
  if (okAt(s, 1, 1)) {
    kHi = 1.9; // room to spare: open the gaps up so the drawing fills the sheet
  } else if (!okAt(s, 0.5, 0.5)) {
    if (fold === Infinity) fold = mLen;
    if (!okAt(0.5, 0.4, 0.4)) {
      s = 0.5;
      warnings.push("The drawing is too large for one sheet even at minimum spacing; consider splitting it with off-sheet connectors.");
    } else {
      s = Math.floor(bsearch(0.5, scale0, (x) => !!okAt(x, 0.5, 0.5) || !!okAt(x, 0.4, 0.4)) * 40) / 40;
    }
  }
  let fin = null;
  if (okAt(s, 0.4, 0.4) || kHi > 1) {
    const lo = kHi > 1 ? 1 : 0.4;
    const ku = bsearch(lo, kHi, (k) => !!okAt(s, k, k));
    kc = bsearch(ku, kHi, (k) => !!okAt(s, k, ku));
    km = bsearch(ku, kHi, (k) => !!okAt(s, kc, k));
    // keep the two directions from diverging too much
    kc = Math.min(kc, km * 1.5); km = Math.min(km, kc * 1.5);
    fin = okAt(s, kc, km);
  }
  doc.symScale = s;
  if (s !== scale0) warnings.push(`Symbols scaled to ${Math.round(s * 100)}% to fit the sheet.`);
  if (!fin) {
    const L = compute(0.4, 0.4);
    fin = { L, t: { tx: snap(O[0] - L.bbox[0], GRID), ty: snap(O[3] - L.bbox[3], GRID) } };
  }
  const { tx, ty } = fin.t;
  for (const [id, p] of fin.L.out) {
    const n = byId.get(id);
    n.x = round4(p.x + tx); n.y = round4(p.y + ty);
    n.rot = p.rot; n.flip = false;
    if (p.len) n.len = round4(p.len);
  }
  // buses span the branches laid out next to them (same band, adjacent rank)
  const meta = fin.L.out;
  fitBuses(doc, null, (bus, other) => {
    const a = meta.get(bus.id), b = meta.get(other.id);
    return a && b && a.band === b.band && Math.abs(a.rank - b.rank) <= 1;
  });
  for (const e of doc.edges) delete e.pts;
  let routeInfo = null;
  if (route) routeInfo = routeEdges(doc);
  if (routeInfo && routeInfo.failed) warnings.push(`${routeInfo.failed} connection(s) could not be routed cleanly.`);
  return { warnings, scale: doc.symScale };
}

/**
 * Stretch (or shrink) buses / headers so they span every connection made to
 * them, plus a margin at each end. Buses with autoLen === false are left alone.
 */
function fitBuses(doc, ids = null, accept = null) {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  for (const n of doc.nodes) {
    const sym = SYMBOLS[n.sym];
    if (!sym.bus || n.autoLen === false || (ids && !ids.has(n.id))) continue;
    const g = nodeGeom(doc, n);
    const horiz = R.w(g.body) >= R.h(g.body);
    const att = [];
    for (const e of doc.edges) {
      let other = null;
      if (e.from.n === n.id) other = e.to;
      else if (e.to.n === n.id) other = e.from;
      if (!other || other.n === n.id) continue;
      const on = byId.get(other.n);
      if (!on || SYMBOLS[on.sym].bus || (accept && !accept(n, on))) continue;
      const p = portOf(nodeGeom(doc, on), other.p);
      att.push(horiz ? p.x : p.y);
    }
    if (!att.length) continue;
    const pad = 0.4;
    let lo = Math.min(...att) - pad, hi = Math.max(...att) + pad;
    const minL = 1.0;
    if (hi - lo < minL) { const c = (lo + hi) / 2; lo = c - minL / 2; hi = c + minL / 2; }
    const c = snap((lo + hi) / 2, GRID / 2);
    const L = Math.max(hi - c, c - lo) * 2;
    if (horiz) n.x = round4(c); else n.y = round4(c);
    n.len = round4(L / doc.symScale);
  }
}
