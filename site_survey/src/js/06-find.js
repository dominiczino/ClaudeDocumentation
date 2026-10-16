/* =========================================================================
 * Finding a point again: which landmarks to set up on, what to sight, what
 * angle to turn, how far out; plus tape-only ties.
 * ========================================================================= */

/** Landmark pairs known to be intervisible (from any sighting either way). */
function visiblePairs(p, sol) {
  const pairs = new Map(); // station -> Map(backsight -> uses)
  const add = (s, b) => {
    if (!sol.coords.has(s) || !sol.coords.has(b) || s === b) return;
    if (!pairs.has(s)) pairs.set(s, new Map());
    pairs.get(s).set(b, (pairs.get(s).get(b) || 0) + 1);
  };
  const lm = new Set(p.landmarks.map((l) => l.id));
  for (const o of sol.obs) {
    if (o.kind === "angle") {
      if (lm.has(o.bs)) { add(o.at, o.bs); add(o.bs, o.at); }
      if (lm.has(o.fs)) { add(o.at, o.fs); add(o.fs, o.at); }
    } else if (lm.has(o.a) && lm.has(o.b)) { add(o.a, o.b); add(o.b, o.a); }
  }
  return pairs;
}

/** Stations that actually sighted entity `id` (line of sight known to be clear). */
function stationsThatSaw(sol, id) {
  return new Set(sol.obs.filter((o) => o.kind === "angle" && o.fs === id).map((o) => o.at));
}

/**
 * Setup options for locating target X = [E, N].
 * Returns {options, best: [opt, opt] | [opt] | null, sigma95, tapes, inside}.
 * option = {station, backsight, angle (clockwise), reading, dist, az, seen,
 *           blocked: obstacle on the line to X, bsBlocked: obstacle on the line to the backsight}
 * Setups whose lines pass through a blocking obstacle are never chosen.
 */
function findOptions(p, sol, X, targetId = null) {
  const pairs = visiblePairs(p, sol);
  const seenBy = targetId ? stationsThatSaw(sol, targetId) : new Set();
  const shapes = blockingShapes(p, sol), tol = sightTol(p);
  const options = [];
  for (const [s, bsMap] of pairs) {
    const S = sol.coords.get(s);
    const dist = Math.hypot(X[0] - S[0], X[1] - S[1]);
    if (dist < 1e-6) continue;
    // backsight: the one used most often from this station whose line is still clear
    const cands = [...bsMap.entries()].sort((a, c) => c[1] - a[1]).map(([b]) => ({ b, blk: sightBlocker(shapes, S, sol.coords.get(b), tol) }));
    const { b, blk } = cands.find((c) => !c.blk) || cands[0];
    const B = sol.coords.get(b);
    const angle = norm2pi(azimuth(S[0], S[1], X[0], X[1]) - azimuth(S[0], S[1], B[0], B[1]));
    const reading = p.circle === "cw" ? angle : norm2pi(-angle);
    options.push({ station: s, backsight: b, angle, reading, dist, az: azimuth(S[0], S[1], X[0], X[1]), seen: seenBy.has(s),
                   blocked: sightBlocker(shapes, S, X, tol), bsBlocked: blk });
  }
  const clear = options.filter((o) => !o.blocked && !o.bsBlocked);
  // the pair of setups whose sight lines cross best (smallest predicted error)
  const sig = p.angleSigma * SEC * Math.SQRT2;
  let best = null;
  for (let i = 0; i < clear.length; i++) {
    for (let j = i + 1; j < clear.length; j++) {
      const c = rayPairCov([clear[i], clear[j]], sig);
      if (!c) continue;
      let score = Math.sqrt(c.trace);
      if (targetId) score *= (clear[i].seen ? 1 : 1.6) * (clear[j].seen ? 1 : 1.6);
      if (!best || score < best.score) best = { score, pair: [clear[i], clear[j]], c };
    }
  }
  if (!best && clear.length) best = { pair: [clear.sort((a, c) => a.dist - c.dist)[0]], c: null };
  options.sort((a, c) => (!!a.blocked - !!c.blocked) || (c.seen - a.seen) || a.dist - c.dist);
  // tape ties from the nearest landmarks with a clear line (best-crossing pair first)
  const near = p.landmarks.filter((l) => sol.coords.has(l.id)).map((l) => {
    const L = sol.coords.get(l.id);
    return { id: l.id, dist: Math.hypot(X[0] - L[0], X[1] - L[1]), az: azimuth(X[0], X[1], L[0], L[1]), blocked: sightBlocker(shapes, L, X, tol) };
  }).filter((n) => !n.blocked && n.dist > 1e-6).sort((a, c) => a.dist - c.dist);
  let tapes = near.slice(0, 3);
  if (near.length >= 2) {
    let bp = null;
    for (let i = 0; i < Math.min(near.length, 6); i++) {
      for (let j = i + 1; j < Math.min(near.length, 6); j++) {
        const g = Math.abs(Math.sin(near[i].az - near[j].az));
        const sc = g / Math.max(near[i].dist, near[j].dist);
        if (!bp || sc > bp.sc) bp = { sc, t: [near[i], near[j]], g };
      }
    }
    if (bp) tapes = [...bp.t, ...near.filter((n) => !bp.t.includes(n)).slice(0, 1)];
    tapes.goodCrossing = bp && bp.g > Math.sin(30 * DEG);
  }
  return { options, best: best ? best.pair : null, sigma95: best && best.c ? 2.4477 * Math.sqrt(best.c.lmax) : null, tapes,
           inside: insideShape(shapes, X, tol), nBlocked: options.length - clear.length };
}

/** Covariance (trace, largest eigenvalue) of a point fixed by two rays with angular sigma `sig`. */
function rayPairCov(opts, sig) {
  let a = 0, b = 0, d = 0;
  for (const o of opts) {
    // unit normal to the ray, weighted by 1 / (sigma * distance)^2
    const n = [Math.cos(o.az), -Math.sin(o.az)];
    const w = 1 / (sig * o.dist) ** 2;
    a += w * n[0] * n[0]; b += w * n[0] * n[1]; d += w * n[1] * n[1];
  }
  const det = a * d - b * b;
  if (det <= 1e-30 * (a + d) ** 2) return null;
  const ca = d / det, cb = -b / det, cd = a / det;
  const tr = ca + cd, disc = Math.sqrt(Math.max(0, tr * tr / 4 - (ca * cd - cb * cb)));
  return { trace: tr, lmax: tr / 2 + disc };
}

/** Coordinates of the vertices of a line that are located. */
function linePoints(sol, line) {
  return line.pts.map((id) => sol.coords.get(id)).filter(Boolean);
}

function lineLength(sol, line) {
  const pts = linePoints(sol, line);
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Point at distance `s` along a line (clamped), with the segment it falls on. */
function pointAlong(sol, line, s) {
  const pts = linePoints(sol, line);
  if (pts.length < 2) return null;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (s <= acc + L || i === pts.length - 1) {
      const t = L ? clamp((s - acc) / L, 0, 1) : 0;
      return { xy: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], seg: i - 1, s: acc + t * L };
    }
    acc += L;
  }
  return null;
}

/** Nearest point on any line to X: {line, s, xy, d}. */
function nearestOnLines(p, sol, X) {
  let best = null;
  for (const line of p.lines) {
    const pts = linePoints(sol, line);
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
      const t = L2 ? clamp(((X[0] - a[0]) * dx + (X[1] - a[1]) * dy) / L2, 0, 1) : 0;
      const q = [a[0] + dx * t, a[1] + dy * t];
      const d = Math.hypot(X[0] - q[0], X[1] - q[1]);
      if (!best || d < best.d) best = { line, s: acc + t * Math.sqrt(L2), xy: q, d };
      acc += Math.sqrt(L2);
    }
  }
  return best;
}
