/* =========================================================================
 * Obstacles: buildings, sheds, hedges, walls. Outlines are drawn on the
 * site and, when they block sight lines, used by the Find tool to rule out
 * setups that can't see the spot.
 *
 * A vertex is either the id of a landmark/point (follows its solved
 * position) or a fixed [E, N].
 * ========================================================================= */

const OBSTACLE_KINDS = {
  building: { name: "Building", closed: true, fill: true, layer: "OBSTACLE" },
  structure: { name: "Shed / garage / deck", closed: true, fill: true, layer: "OBSTACLE" },
  trees: { name: "Trees / hedge", closed: true, fill: false, layer: "OBSTACLE-VEG" },
  wall: { name: "Wall / solid fence", closed: false, fill: false, layer: "OBSTACLE" },
  other: { name: "Other", closed: true, fill: false, layer: "OBSTACLE" },
};

/** Resolved vertices of an obstacle (vertices on unlocated points are skipped). */
function obstacleCoords(sol, o) {
  return o.pts.map((v) => (typeof v === "string" ? sol.coords.get(v) : v)).filter(Boolean);
}

/** Obstacles that block sight, with their geometry: [{o, pts, closed}]. */
function blockingShapes(p, sol) {
  const out = [];
  for (const o of p.obstacles) {
    if (!o.blocks) continue;
    const pts = obstacleCoords(sol, o);
    const closed = o.closed && pts.length >= 3;
    if (pts.length >= 2) out.push({ o, pts, closed });
  }
  return out;
}

function pointInPoly(P, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > P[1]) !== (yj > P[1]) && P[0] < ((xj - xi) * (P[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSeg(P, A, B) {
  const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
  const t = L2 ? clamp(((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2, 0, 1) : 0;
  return Math.hypot(P[0] - A[0] - dx * t, P[1] - A[1] - dy * t);
}

/** Closed shape strictly containing P (more than `tol` inside its outline). */
function insideShape(shapes, P, tol) {
  for (const sh of shapes) {
    if (!sh.closed || !pointInPoly(P, sh.pts)) continue;
    let d = Infinity;
    for (let i = 0; i < sh.pts.length; i++) d = Math.min(d, distToSeg(P, sh.pts[i], sh.pts[(i + 1) % sh.pts.length]));
    if (d > tol) return sh.o;
  }
  return null;
}

/**
 * First obstacle the sight line A -> B passes through, or null. Crossings
 * within `tol` of either end don't count (a mark on a wall or a deck post can
 * still be sighted), nor do shapes that contain an end (that end is inside).
 */
function sightBlocker(shapes, A, B, tol) {
  const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
  if (L < 1e-9) return null;
  const eps = tol / L;
  for (const sh of shapes) {
    if (sh.closed && (insideShape([sh], A, tol) || insideShape([sh], B, tol))) continue;
    const n = sh.pts.length, edges = sh.closed ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      const C = sh.pts[i], D = sh.pts[(i + 1) % n];
      const ex = D[0] - C[0], ey = D[1] - C[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const cx = C[0] - A[0], cy = C[1] - A[1];
      const t = (cx * ey - cy * ex) / den, u = (cx * dy - cy * dx) / den;
      if (t > eps && t < 1 - eps && u >= -1e-9 && u <= 1 + 1e-9) return sh.o;
    }
  }
  return null;
}

const sightTol = (p) => (p.units === "m" ? 0.08 : 0.25);

/** Field-book sight lines that pass through a blocking obstacle (outline wrong, or built since). */
function obstacleMessages(p, sol) {
  const shapes = blockingShapes(p, sol);
  if (!shapes.length) return [];
  const ents = entities(p), done = new Set(), out = [];
  for (const o of sol.obs) {
    if (o.kind !== "angle") continue;
    const k = o.at + ">" + o.fs;
    if (done.has(k) || !sol.coords.has(o.at) || !sol.coords.has(o.fs)) continue;
    done.add(k);
    const b = sightBlocker(shapes, sol.coords.get(o.at), sol.coords.get(o.fs), sightTol(p));
    if (b) out.push({ lvl: "info", ids: [o.fs], ref: o.ref,
      msg: `${ents.get(o.at)?.name} → ${ents.get(o.fs)?.name} was sighted, but the line passes through ${b.name || "an obstacle"}. Fine if it was built later; otherwise check its outline.` });
  }
  return out;
}
