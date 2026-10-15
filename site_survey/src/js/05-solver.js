/* =========================================================================
 * Network solution.
 *
 * Unknowns: plane coordinates (E = x, N = y) of every landmark and point.
 * Datum: the origin landmark is held at (originE, originN); the azimuth from
 * the origin to the orientation landmark is held at the given bearing; scale
 * comes from measured distances (without any, the network is drawn at an
 * arbitrary scale and flagged).
 *
 *  1. Approximate coordinates are built constructively (ray intersection,
 *     ray + distance, and a small numeric search for other combinations).
 *  2. A weighted least-squares adjustment (Gauss-Newton) uses every
 *     observation together and yields coordinates, error ellipses,
 *     standardised residuals (blunder detection) and the variance factor.
 * ========================================================================= */

const STD_RES_FLAG = 3.0;       // (and 4.1 sigma / sqrt(r) is the smallest blunder reliably caught)        // |standardised residual| above this = suspect reading
const WEAK_ANGLE = 25 * DEG;     // two-ray intersections sharper than this are weak

function solveProject(p) {
  const ents = entities(p);
  const { obs, problems } = observations(p);
  const res = {
    coords: new Map(),      // id -> [E, N]
    info: new Map(),        // id -> {how, sigmaE, sigmaN, ellipse, checked, rays}
    obs, problems,
    messages: [],           // {lvl, msg, ids}
    unscaled: false, sigma0: null, dof: 0, iterations: 0,
  };
  const O = p.datum.origin, Rr = p.datum.orient;
  if (!ents.get(O) || !ents.get(Rr) || O === Rr) {
    res.messages.push({ lvl: "error", msg: "Choose an origin landmark and a different orientation landmark (Project tab).", ids: [] });
    return res;
  }
  let az0 = parseBearing(p.datum.bearing);
  if (!Number.isFinite(az0)) {
    res.messages.push({ lvl: "error", msg: `Can't read the orientation bearing "${p.datum.bearing}"; using north.`, ids: [] });
    az0 = 0;
  }
  const origin = [p.datum.originE, p.datum.originN];

  // ------------------------------------------------- approximate coordinates
  const K = new Map([[O, origin]]);
  const how = new Map([[O, "datum origin"]]);
  let provisionalScale = false;

  /** Known azimuths from known stations: Map "S|T" -> az. */
  const azMap = () => {
    const m = new Map();
    const set = (s, t, a) => { const k = s + "|" + t; if (!m.has(k)) { m.set(k, norm2pi(a)); return true; } return false; };
    for (const [s, ps] of K) for (const [t, pt] of K) if (s !== t) set(s, t, azimuth(ps[0], ps[1], pt[0], pt[1]));
    if (K.has(O)) set(O, Rr, az0);
    for (let changed = true; changed;) {
      changed = false;
      for (const o of obs) {
        if (o.kind !== "angle" || !K.has(o.at)) continue;
        const b = m.get(o.at + "|" + o.bs), f = m.get(o.at + "|" + o.fs);
        if (b !== undefined && f === undefined) changed = set(o.at, o.fs, b + o.value) || changed;
        if (f !== undefined && b === undefined) changed = set(o.at, o.bs, f - o.value) || changed;
      }
    }
    return m;
  };
  const distBetween = (a, b) => {
    const ds = obs.filter((o) => o.kind === "dist" && ((o.a === a && o.b === b) || (o.a === b && o.b === a))).map((o) => o.value);
    return ds.length ? ds.reduce((x, y) => x + y) / ds.length : null;
  };
  const unknownIds = () => [...ents.keys()].filter((id) => !K.has(id));

  const tryLocate = () => {
    const az = azMap();
    for (const P of unknownIds()) {
      const rays = [];
      for (const [k, a] of az) {
        const [s, t] = k.split("|");
        if (t === P && K.has(s) && !rays.some((r) => r.s === s)) rays.push({ s, a, at: K.get(s) });
      }
      // (a) two rays from different stations
      let best = null;
      for (let i = 0; i < rays.length; i++) {
        for (let j = i + 1; j < rays.length; j++) {
          const x = intersectRays(rays[i].at, rays[i].a, rays[j].at, rays[j].a);
          if (!x) continue;
          const q = Math.abs(Math.sin(rays[i].a - rays[j].a));
          if (q > Math.sin(2 * DEG) && (!best || q > best.q)) best = { q, x };
        }
      }
      if (best) { K.set(P, best.x); how.set(P, "intersection"); return true; }
      // (b) ray + distance from the same station
      for (const r of rays) {
        const d = distBetween(r.s, P);
        if (d) { K.set(P, [r.at[0] + d * Math.sin(r.a), r.at[1] + d * Math.cos(r.a)]); how.set(P, "ray and distance"); return true; }
      }
    }
    // (c) anything else with two or more constraints: small numeric search per point
    for (const P of unknownIds()) {
      const x = locateNumerically(P, K, obs, az);
      if (x) { K.set(P, x); how.set(P, "resection / combined"); return true; }
    }
    return false;
  };

  for (let guard = 0; guard < 1000; guard++) {
    if (tryLocate()) continue;
    if (!K.has(Rr)) {
      // no distance to the orientation landmark yet: provisional scale O-R = 100
      K.set(Rr, [origin[0] + 100 * Math.sin(az0), origin[1] + 100 * Math.cos(az0)]);
      how.set(Rr, "datum orientation");
      provisionalScale = true;
      continue;
    }
    break;
  }
  // rescale a provisionally scaled network to the measured distances
  const located = () => [...K.keys()];
  const distObs = (ids) => obs.filter((o) => o.kind === "dist" && ids.has(o.a) && ids.has(o.b));
  if (provisionalScale) {
    const ids = new Set(located());
    const ratios = distObs(ids).map((o) => o.value / Math.hypot(K.get(o.a)[0] - K.get(o.b)[0], K.get(o.a)[1] - K.get(o.b)[1]))
      .filter((r) => Number.isFinite(r) && r > 0).sort((a, b) => a - b);
    if (ratios.length) {
      const k = ratios[ratios.length >> 1];
      for (const [id, xy] of K) K.set(id, [origin[0] + (xy[0] - origin[0]) * k, origin[1] + (xy[1] - origin[1]) * k]);
    }
  }

  // --------------------------------------------------------- adjustment
  let ids = located();
  let adj = null;
  for (let pass = 0; pass < 4; pass++) {
    adj = adjust(K, ids, obs, O, Rr, az0);
    if (!adj.undetermined.length) break;
    for (const id of adj.undetermined) { K.delete(id); how.delete(id); }
    ids = located();
  }
  res.unscaled = adj.unscaled;
  res.sigma0 = adj.sigma0;
  res.dof = adj.dof;
  res.iterations = adj.iterations;
  for (const id of ids) res.coords.set(id, K.get(id));

  // per-point information
  const raysTo = new Map(), distsTo = new Map();
  for (const o of obs) {
    if (o.kind === "angle") {
      if (!raysTo.has(o.fs)) raysTo.set(o.fs, new Set());
      raysTo.get(o.fs).add(o.at);
    } else {
      for (const [a, b] of [[o.a, o.b], [o.b, o.a]]) { if (!distsTo.has(a)) distsTo.set(a, new Set()); distsTo.get(a).add(b); }
    }
  }
  // how well each point's readings are checked by the others (redundancy numbers)
  for (const id of ids) {
    const cov = adj.cov.get(id) || [[0, 0], [0, 0]];
    const ell = ellipse(cov);
    const nRays = (raysTo.get(id) || new Set()).size, nDist = (distsTo.get(id) || new Set()).size;
    const ent = ents.get(id);
    // "checked": the largest mistake that could slip through undetected would move
    // the point no more than CHECK_TOL (or 3 x its 95 % radius)
    const r95 = ell.a * 2.4477;
    const shift = adj.shift.has(id) ? adj.shift.get(id) : (id === O ? 0 : Infinity);
    const tol = Math.max(p.units === "m" ? 0.05 : 0.15, 3 * r95);
    res.info.set(id, { how: how.get(id), cov, ellipse: ell, sigmaE: Math.sqrt(cov[0][0]), sigmaN: Math.sqrt(cov[1][1]),
                       r95, checked: id === O || shift <= tol, shift, rays: nRays, dists: nDist });
  }

  // ------------------------------------------------------------- advice
  for (const o of obs) {
    const st = adj.stats.get(o);
    if (st) Object.assign(o, st);
  }
  const nm = (id) => ents.get(id)?.name || "?";
  const what = (o) => (o.kind === "angle" ? `the angle at ${nm(o.at)} from ${nm(o.bs)} to ${nm(o.fs)}` : `the distance ${nm(o.a)}–${nm(o.b)}`);
  // Data snooping: one bad reading spreads into its neighbours' residuals, so
  // flag only the worst, drop it (in a trial solution) and look again.
  const suspects = snoop(K, ids, obs, O, Rr, az0);
  for (const group of suspects) {
    for (const o of group) o.flag = true;
    const o = group[0];
    const off = o.kind === "angle" ? fmtSec(o.snoopV) : fmtLen(p, o.snoopV, 3);
    const msg = group.length === 1
      ? `Suspect reading: ${what(o)} disagrees with the rest by about ${off.replace("-", "")} (${Math.abs(o.snoopW).toFixed(1)}σ). Re-check it, re-measure it, or tick "ignore".`
      : `One of these readings is off by about ${off.replace("-", "")}, but there aren't enough sightings to tell which: ${group.map(what).join("; ")}. Take one more sighting of that point.`;
    res.messages.push({ lvl: "warn", msg, ids: [...new Set(group.flatMap((g) => [g.at || g.a, g.fs || g.b]))], ref: o.ref });
  }
  if (res.unscaled) {
    res.messages.push({ lvl: "warn", msg: `No measured distance yet: the shape is right but the size is arbitrary (${nm(O)}–${nm(Rr)} drawn as 100). Tape one distance between two landmarks.`, ids: [O, Rr] });
  }
  if (res.sigma0 && res.dof >= 3 && res.sigma0 > 2.5 && !suspects.length) {
    res.messages.push({ lvl: "info", msg: `Readings fit about ${res.sigma0.toFixed(1)}× worse than the instrument precision set on the Project tab; it may be optimistic.`, ids: [] });
  }
  // weak two-ray intersections
  for (const id of ids) {
    const inf = res.info.get(id);
    if (inf.rays === 2 && inf.dists === 0 && ents.get(id).kind === "pt") {
      const st = [...raysTo.get(id)].filter((s) => K.has(s));
      if (st.length === 2) {
        const [a, b] = st.map((s) => K.get(s)), x = K.get(id);
        const g = Math.abs(normPi(azimuth(x[0], x[1], a[0], a[1]) - azimuth(x[0], x[1], b[0], b[1])));
        if (g < WEAK_ANGLE || g > Math.PI - WEAK_ANGLE) {
          res.messages.push({ lvl: "warn", msg: `${nm(id)}: the two sight lines cross at only ${(Math.min(g, Math.PI - g) / DEG).toFixed(0)}°, so it is poorly fixed along them. Add a sighting from a landmark off to the side.`, ids: [id] });
        }
      }
    }
  }
  // unlocated: say why and what would fix it
  for (const [id, ent] of ents) {
    if (K.has(id)) continue;
    const from = [...(raysTo.get(id) || [])];
    const locatedFrom = from.filter((s) => K.has(s));
    let msg;
    if (!from.length && !(distsTo.get(id) || new Set()).size && !(ent.kind === "lm" && stationTies(id, obs))) {
      msg = `${ent.name || "(unnamed)"} hasn't been sighted yet.`;
    } else if (locatedFrom.length === 1 && from.length === 1) {
      msg = `${ent.name} is sighted only from ${nm(from[0])}. Sight it from a second landmark (or tape its distance from ${nm(from[0])}).`;
    } else if (from.length > locatedFrom.length) {
      const waiting = from.filter((s) => !K.has(s)).map(nm).join(", ");
      msg = `${ent.name} is sighted from ${waiting}, which ${from.length - locatedFrom.length > 1 ? "aren't" : "isn't"} located yet.`;
    } else {
      msg = `${ent.name} can't be located from its sightings. Sight it from another located landmark.`;
    }
    if (ent.kind === "lm") msg += " A landmark needs sightings from two located landmarks, or a setup on it sighting two located ones.";
    res.messages.push({ lvl: "error", msg, ids: [id] });
  }
  for (const pr of problems) res.messages.push({ lvl: "error", msg: pr.msg, ids: [], ref: pr.ref });
  return res;
}

/** Number of distinct located targets sighted from a landmark set up as a station. */
function stationTies(id, obs) {
  const t = new Set();
  for (const o of obs) if (o.kind === "angle" && o.at === id) { t.add(o.bs); t.add(o.fs); }
  return Math.max(0, t.size - 1);
}

function intersectRays(p1, a1, p2, a2) {
  const u1 = [Math.sin(a1), Math.cos(a1)], u2 = [Math.sin(a2), Math.cos(a2)];
  const den = u1[0] * u2[1] - u1[1] * u2[0];
  if (Math.abs(den) < 1e-9) return null;
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const t1 = (dx * u2[1] - dy * u2[0]) / den;
  const t2 = (dx * u1[1] - dy * u1[0]) / den;
  if (t1 <= 0 || t2 <= 0) return null;
  return [p1[0] + t1 * u1[0], p1[1] + t1 * u1[1]];
}

/**
 * Locate a single point from observations that tie it to known points only
 * (rays, distances, angles measured at the point itself). Grid search, then
 * Gauss-Newton on the point. Needs at least two such constraints.
 */
function locateNumerically(P, K, obs, az) {
  const known = [...K.values()];
  if (known.length < 2) return null;
  const cons = [];
  for (const [k, a] of az) {
    const [s, t] = k.split("|");
    if (t === P && K.has(s)) cons.push({ kind: "ray", s: K.get(s), a });
  }
  for (const o of obs) {
    if (o.kind === "dist") {
      const other = o.a === P ? o.b : o.b === P ? o.a : null;
      if (other && K.has(other)) cons.push({ kind: "dist", q: K.get(other), d: o.value });
    } else if (o.at === P && K.has(o.bs) && K.has(o.fs)) {
      cons.push({ kind: "angle", b: K.get(o.bs), f: K.get(o.fs), v: o.value });
    }
  }
  if (cons.length < 2) return null;
  const xs = known.map((k) => k[0]), ys = known.map((k) => k[1]);
  const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  const resid = (x, y) => cons.map((c) => {
    if (c.kind === "ray") return normPi(azimuth(c.s[0], c.s[1], x, y) - c.a) * ext;
    if (c.kind === "dist") return Math.hypot(x - c.q[0], y - c.q[1]) - c.d;
    return normPi(azimuth(x, y, c.f[0], c.f[1]) - azimuth(x, y, c.b[0], c.b[1]) - c.v) * ext;
  });
  const ss = (x, y) => resid(x, y).reduce((a, r) => a + r * r, 0);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  let best = null;
  const span = ext * 3, n = 60;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const x = cx - span + (2 * span * i) / n, y = cy - span + (2 * span * j) / n;
      if (known.some((k) => Math.hypot(k[0] - x, k[1] - y) < ext * 1e-3)) continue;
      const v = ss(x, y);
      if (!best || v < best.v) best = { v, x, y };
    }
  }
  let [x, y] = [best.x, best.y];
  for (let it = 0; it < 40; it++) {
    const h = ext * 1e-6;
    const r0 = resid(x, y), rx = resid(x + h, y), ry = resid(x, y + h);
    const J = r0.map((r, i) => [(rx[i] - r) / h, (ry[i] - r) / h]);
    let a = 0, b = 0, c = 0, gx = 0, gy = 0;
    J.forEach(([jx, jy], i) => { a += jx * jx; b += jx * jy; c += jy * jy; gx += jx * r0[i]; gy += jy * r0[i]; });
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-18) return null;
    const dx = -(c * gx - b * gy) / det, dy = -(a * gy - b * gx) / det;
    x += dx; y += dy;
    if (Math.hypot(dx, dy) < ext * 1e-10) break;
  }
  const rms = Math.sqrt(ss(x, y) / cons.length);
  return rms < ext * 0.02 ? [x, y] : null;
}

/**
 * Weighted least squares. Unknowns: coordinates of `ids` except the origin.
 * Pseudo-observations hold the orientation azimuth and (if there are no
 * distances) the provisional scale.
 */
function adjust(K, ids, allObs, O, Rr, az0) {
  const unk = ids.filter((id) => id !== O);
  const col = new Map(unk.map((id, i) => [id, 2 * i]));
  const n = 2 * unk.length;
  const set = new Set(ids);
  const obs = allObs.filter((o) => (o.kind === "angle" ? set.has(o.at) && set.has(o.bs) && set.has(o.fs) : set.has(o.a) && set.has(o.b)));
  const out = { cov: new Map(), stats: new Map(), shift: new Map(), sigma0: null, dof: 0, iterations: 0, unscaled: false, undetermined: [] };
  if (!n) return out;
  const pseudo = [];
  if (set.has(Rr)) pseudo.push({ kind: "az", a: O, b: Rr, value: az0, sigma: 1e-7 });
  if (!obs.some((o) => o.kind === "dist") && set.has(Rr)) {
    const [a, b] = [K.get(O), K.get(Rr)];
    pseudo.push({ kind: "dist", a: O, b: Rr, value: Math.hypot(a[0] - b[0], a[1] - b[1]), sigma: 1e-6 });
    out.unscaled = true;
  }
  const all = [...obs, ...pseudo];
  const X = (id) => K.get(id);

  /** Row of the design matrix (sparse: [[col, value]...]) and computed value. */
  const model = (o) => {
    const row = [];
    const addAz = (a, b, sgn) => {
      const [xa, ya] = X(a), [xb, yb] = X(b);
      const dx = xb - xa, dy = yb - ya, r2 = dx * dx + dy * dy;
      if (col.has(b)) { row.push([col.get(b), sgn * dy / r2], [col.get(b) + 1, -sgn * dx / r2]); }
      if (col.has(a)) { row.push([col.get(a), -sgn * dy / r2], [col.get(a) + 1, sgn * dx / r2]); }
      return azimuth(xa, ya, xb, yb);
    };
    if (o.kind === "angle") {
      const v = addAz(o.at, o.fs, 1) - addAz(o.at, o.bs, -1);
      return { row, calc: norm2pi(v), angle: true };
    }
    if (o.kind === "az") return { row, calc: addAz(o.a, o.b, 1), angle: true };
    const [xa, ya] = X(o.a), [xb, yb] = X(o.b);
    const d = Math.hypot(xb - xa, yb - ya);
    if (col.has(o.b)) row.push([col.get(o.b), (xb - xa) / d], [col.get(o.b) + 1, (yb - ya) / d]);
    if (col.has(o.a)) row.push([col.get(o.a), -(xb - xa) / d], [col.get(o.a) + 1, -(yb - ya) / d]);
    return { row, calc: d, angle: false };
  };

  let Ninv = null;
  for (let it = 0; it < 30; it++) {
    const N = Array.from({ length: n }, () => new Float64Array(n));
    const u = new Float64Array(n);
    for (const o of all) {
      const { row, calc, angle } = model(o);
      const l = angle ? normPi(o.value - calc) : o.value - calc;
      const w = 1 / (o.sigma * o.sigma);
      for (const [i, ai] of row) {
        u[i] += ai * w * l;
        for (const [j, aj] of row) N[i][j] += ai * w * aj;
      }
    }
    const inv = invertSPD(N);
    if (!inv) {
      out.undetermined = unk.filter((id) => N[col.get(id)][col.get(id)] < 1e-12 || N[col.get(id) + 1][col.get(id) + 1] < 1e-12);
      if (!out.undetermined.length) out.undetermined = [unk[unk.length - 1]];
      return out;
    }
    Ninv = inv;
    const dx = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += inv[i][j] * u[j]; dx[i] = s; }
    let maxStep = 0;
    for (const [id, c] of col) {
      const [x, y] = K.get(id);
      K.set(id, [x + dx[c], y + dx[c + 1]]);
      maxStep = Math.max(maxStep, Math.abs(dx[c]), Math.abs(dx[c + 1]));
    }
    out.iterations = it + 1;
    if (maxStep < 1e-7) break;
  }
  // statistics
  let vtpv = 0;
  for (const o of obs) {
    const { row, calc, angle } = model(o);
    const v = angle ? normPi(o.value - calc) : o.value - calc;   // residual (measured - adjusted)
    let aqa = 0;
    for (const [i, ai] of row) for (const [j, aj] of row) aqa += ai * Ninv[i][j] * aj;
    const qvv = o.sigma * o.sigma - aqa;
    const rnum = qvv / (o.sigma * o.sigma);
    out.stats.set(o, { v, rnum, w: rnum > 0.02 ? v / Math.sqrt(qvv) : undefined });
    // external reliability: the smallest blunder the test would catch (4.1 sigma / sqrt(r)),
    // propagated into every point; keep the worst shift per point
    const mdb = rnum > 1e-4 ? (4.1 * o.sigma) / Math.sqrt(rnum) : Infinity;
    const g = new Float64Array(n);
    for (const [j, aj] of row) for (let i = 0; i < n; i++) g[i] += Ninv[i][j] * aj;
    const k = mdb / (o.sigma * o.sigma);
    for (const [id, c] of col) {
      const sh = Math.hypot(g[c], g[c + 1]);
      const d = sh < 1e-12 ? 0 : sh * k;
      if (d > (out.shift.get(id) ?? 0)) out.shift.set(id, d);
    }
    vtpv += (v / o.sigma) ** 2;
  }
  out.dof = obs.length - (n - pseudo.length);
  out.sigma0 = out.dof > 0 ? Math.sqrt(vtpv / out.dof) : null;
  out.cov.set(O, [[0, 0], [0, 0]]);
  // a point whose uncertainty dwarfs the network is not really determined
  const xs = ids.map((id) => K.get(id));
  const ext = Math.max(1, ...xs.map((a) => Math.max(...xs.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])))));
  for (const [id, c] of col) {
    const cov = [[Ninv[c][c], Ninv[c][c + 1]], [Ninv[c + 1][c], Ninv[c + 1][c + 1]]];
    out.cov.set(id, cov);
    if (Math.sqrt(cov[0][0] + cov[1][1]) > ext * 0.5) out.undetermined.push(id);
  }
  return out;
}

/** Inverse of a symmetric positive-definite matrix (Cholesky); null if singular. */
function invertSPD(N) {
  const n = N.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  let maxDiag = 0;
  for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, N[i][i]);
  for (let j = 0; j < n; j++) {
    let s = N[j][j];
    for (let k = 0; k < j; k++) s -= L[j][k] * L[j][k];
    if (s <= maxDiag * 1e-13) return null;
    L[j][j] = Math.sqrt(s);
    for (let i = j + 1; i < n; i++) {
      let t = N[i][j];
      for (let k = 0; k < j; k++) t -= L[i][k] * L[j][k];
      L[i][j] = t / L[j][j];
    }
  }
  // inverse of L, then L^-T L^-1
  const Li = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    Li[i][i] = 1 / L[i][i];
    for (let j = 0; j < i; j++) {
      let s = 0;
      for (let k = j; k < i; k++) s -= L[i][k] * Li[k][j];
      Li[i][j] = s / L[i][i];
    }
  }
  const inv = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = i; k < n; k++) s += Li[k][i] * Li[k][j];
      inv[i][j] = s; inv[j][i] = s;
    }
  }
  return inv;
}

/** 1-sigma error ellipse of a 2x2 covariance [[EE, EN], [NE, NN]]: semi-axes and azimuth of the major axis. */
function ellipse(c) {
  const a = c[0][0], b = c[0][1], d = c[1][1];
  const tr = a + d, det = a * d - b * b;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
  // major-axis direction (E, N)
  let ve = b, vn = l1 - a;
  if (Math.abs(ve) + Math.abs(vn) < 1e-30) { ve = a >= d ? 1 : 0; vn = a >= d ? 0 : 1; }
  return { a: Math.sqrt(l1), b: Math.sqrt(l2), az: norm2pi(Math.atan2(ve, vn)) };
}

/**
 * Iterative data snooping. Returns groups of suspect observations: each group
 * is one blunder (several entries when the network can't tell which of them).
 */
function snoop(K, ids, obs, O, Rr, az0) {
  const groups = [];
  const excluded = new Set();
  for (let round = 0; round < 3; round++) {
    const Kc = new Map([...K].map(([k, v]) => [k, [...v]]));
    const use = obs.filter((o) => !excluded.has(o));
    const a = adjust(Kc, ids, use, O, Rr, az0);
    if (a.undetermined.length) break;
    let worst = null;
    for (const o of use) {
      const st = a.stats.get(o);
      if (st && st.w !== undefined && (!worst || Math.abs(st.w) > Math.abs(worst.w))) worst = { o, w: st.w };
    }
    if (!worst || Math.abs(worst.w) <= STD_RES_FLAG) break;
    // readings the test can't separate from the worst one
    const group = use.filter((o) => {
      const st = a.stats.get(o);
      return st && st.w !== undefined && Math.abs(Math.abs(st.w) - Math.abs(worst.w)) < 0.05 * Math.abs(worst.w);
    });
    for (const o of group) {
      const st = a.stats.get(o);
      o.snoopW = st.w;
      o.snoopV = st.v / Math.max(st.rnum, 1e-6);   // estimated size of the blunder
      excluded.add(o);
    }
    groups.push(group);
  }
  return groups;
}
