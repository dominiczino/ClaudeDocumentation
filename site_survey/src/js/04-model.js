/* =========================================================================
 * Project model.
 *
 * project = {
 *   name, location, surveyor, units: "ft"|"m", circle: "cw"|"ccw",
 *   angleSigma (arc-seconds, one reading), distSigma: {fixed, ratio},
 *   datum: {origin, originN, originE, orient, bearing},
 *   landmarks: [{id, name, desc, lat, lon, gsrc}],   lat/lon as typed; gsrc = GPS_SOURCES key
 *   points:    [{id, name, type, depth, desc}],
 *   setups:    [{id, date, station, backsight, bsReading, note,
 *                readings: [{id, target, reading, dist, note}]}],
 *   baselines: [{id, a, b, dist, note}],
 *   lines:     [{id, name, type, pts: [ids], depth, desc}],
 *   obstacles: [{id, name, kind, closed, blocks, pts: [id | [E, N]], desc}],
 *   geo:       {source, custom, opacity, show, print},   imagery settings
 *   titleblock, notes
 * }
 * ========================================================================= */

/** Feature / point types. Utility colours and letters follow the APWA uniform color code. */
const TYPES = {
  "": { name: "General", layer: "FEATURE", letter: "" },
  elec: { name: "Electric", layer: "UT-ELEC", letter: "E" },
  gas: { name: "Gas / oil", layer: "UT-GAS", letter: "G" },
  comm: { name: "Communications", layer: "UT-COMM", letter: "C" },
  water: { name: "Water", layer: "UT-WATER", letter: "W" },
  sewer: { name: "Sewer / septic", layer: "UT-SEWER", letter: "SS" },
  storm: { name: "Storm / drain", layer: "UT-STORM", letter: "SD" },
  irrig: { name: "Irrigation", layer: "UT-IRRIG", letter: "IRR" },
  other: { name: "Other utility", layer: "UT-OTHER", letter: "U" },
  fence: { name: "Fence / edge", layer: "FEATURE", letter: "" },
  property: { name: "Property line", layer: "PROPERTY", letter: "" },
};

/** Instrument presets: standard deviation of one horizontal angle, arc-seconds. */
const ANGLE_PRESETS = [
  [300, "Builder's transit / level (5')"],
  [60, "Transit, 1' vernier"],
  [30, "Transit, 30\" vernier"],
  [20, "Transit, 20\" vernier"],
  [10, "Theodolite, 10\""],
  [5, "Theodolite / total station, 5\""],
  [2, "Total station, 2\""],
];

const UNITS = { ft: { name: "feet", abbr: "ft" }, m: { name: "metres", abbr: "m" } };

let _id = 0;
const sid = (p) => `${p}${Date.now().toString(36)}${(_id++).toString(36)}`;

function newProject(name = "New survey") {
  return normalizeProject({ name });
}

function normalizeProject(d) {
  const str = (v) => String(v ?? "");
  const p = {
    v: 1,
    id: d.id || sid("p"),
    name: str(d.name) || "Untitled survey",
    location: str(d.location),
    surveyor: str(d.surveyor),
    units: d.units === "m" ? "m" : "ft",
    circle: d.circle === "ccw" ? "ccw" : "cw",
    angleSigma: clamp(Number(d.angleSigma) || 60, 0.5, 3600),
    distSigma: { fixed: Math.max(0, Number(d.distSigma?.fixed ?? 0.02)), ratio: Math.max(100, Number(d.distSigma?.ratio ?? 5000)) },
    datum: { origin: "", originN: 5000, originE: 5000, orient: "", bearing: "N 0 00 00 E", ...(d.datum || {}) },
    landmarks: (d.landmarks || []).map((l) => ({ id: l.id || sid("L"), name: str(l.name), desc: str(l.desc),
                                                 lat: str(l.lat), lon: str(l.lon), gsrc: l.gsrc in GPS_SOURCES ? l.gsrc : "phone" })),
    points: (d.points || []).map((x) => ({ id: x.id || sid("P"), name: str(x.name), type: x.type in TYPES ? x.type : "",
                                           depth: str(x.depth), desc: str(x.desc) })),
    setups: (d.setups || []).map((s) => ({
      id: s.id || sid("S"), date: str(s.date), station: str(s.station), backsight: str(s.backsight),
      bsReading: str(s.bsReading ?? "0 00 00"), note: str(s.note),
      readings: (s.readings || []).map((r) => ({ id: r.id || sid("R"), target: str(r.target), reading: str(r.reading),
                                                  dist: str(r.dist), note: str(r.note), off: !!r.off })),
    })),
    baselines: (d.baselines || []).map((b) => ({ id: b.id || sid("B"), a: str(b.a), b: str(b.b), dist: str(b.dist), note: str(b.note), off: !!b.off })),
    lines: (d.lines || []).map((l) => ({ id: l.id || sid("F"), name: str(l.name), type: l.type in TYPES ? l.type : "",
                                         pts: (l.pts || []).map(str), depth: str(l.depth), desc: str(l.desc) })),
    obstacles: (d.obstacles || []).map((o) => {
      const kind = o.kind in OBSTACLE_KINDS ? o.kind : "building";
      return { id: o.id || sid("O"), name: str(o.name), kind, desc: str(o.desc),
               closed: o.closed === undefined ? OBSTACLE_KINDS[kind].closed : !!o.closed, blocks: o.blocks === undefined ? true : !!o.blocks,
               pts: (o.pts || []).filter((v) => typeof v === "string" || (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)))
                                 .map((v) => (typeof v === "string" ? v : [+v[0], +v[1]])) };
    }),
    geo: { source: d.geo?.source in IMAGERY ? d.geo.source : "esri", custom: str(d.geo?.custom),
           opacity: clamp(Number(d.geo?.opacity ?? 0.6), 0.05, 1), show: d.geo?.show !== false, print: !!d.geo?.print },
    titleblock: Object.assign({ project: "", title: "", drawn_by: "", date: isoToday(), dwg_no: "", rev: "", sheet: "1 OF 1" },
                              d.titleblock || {}),
    notes: (d.notes || []).map(str),
    font: d.font in FONTS ? d.font : DEFAULT_FONT,
    plotScale: d.plotScale ? +d.plotScale : "",
    planSights: !!d.planSights,
  };
  p.datum.originN = Number(p.datum.originN) || 0;
  p.datum.originE = Number(p.datum.originE) || 0;
  if (!p.landmarks.some((l) => l.id === p.datum.origin)) p.datum.origin = p.landmarks[0]?.id || "";
  if (!p.landmarks.some((l) => l.id === p.datum.orient) || p.datum.orient === p.datum.origin) {
    p.datum.orient = p.landmarks.find((l) => l.id !== p.datum.origin)?.id || "";
  }
  return p;
}

/** All named things that can be sighted: id -> {id, name, kind: "lm"|"pt", ...}. */
function entities(p) {
  const m = new Map();
  for (const l of p.landmarks) m.set(l.id, { ...l, kind: "lm" });
  for (const x of p.points) m.set(x.id, { ...x, kind: "pt" });
  return m;
}

const unitAbbr = (p) => UNITS[p.units].abbr;
const fmtLen = (p, v, d = 2) => (Number.isFinite(v) ? `${v.toFixed(d)} ${unitAbbr(p)}` : "—");
const fmtCoord = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");

/** Standard deviation of a measured distance. */
const distSigma = (p, d) => p.distSigma.fixed + Math.abs(d) / p.distSigma.ratio;

/**
 * Observations derived from the field book:
 *   {kind: "angle", at, bs, fs, value, sigma, ref}   angle right at `at` from bs to fs
 *   {kind: "dist", a, b, value, sigma, ref}           horizontal distance
 * ref = {setup, reading} or {baseline} for linking back to the entry.
 * Also returns entry-level problems (unparseable readings etc).
 */
function observations(p) {
  const ents = entities(p);
  const obs = [], problems = [];
  const sigA = p.angleSigma * SEC * Math.SQRT2; // an angle is the difference of two readings
  for (const s of p.setups) {
    const st = ents.get(s.station), bs = ents.get(s.backsight);
    if (!st || st.kind !== "lm") { if (s.readings.length) problems.push({ ref: { setup: s.id }, msg: "Setup has no instrument station (must be a landmark)." }); continue; }
    const bsRead = parseAngle(s.bsReading || "0");
    for (const r of s.readings) {
      const ref = { setup: s.id, reading: r.id };
      const tgt = ents.get(r.target);
      if (!r.target && !r.reading && !r.dist) continue;
      if (r.off) continue;   // ticked "ignore" in the field book
      if (!tgt) { problems.push({ ref, msg: "Reading has no target." }); continue; }
      if (r.target === s.station) { problems.push({ ref, msg: "A setup can't sight its own station." }); continue; }
      if (String(r.reading).trim() && r.target !== s.backsight) {
        const fsRead = parseAngle(r.reading);
        if (!bs) problems.push({ ref, msg: "Setup has no backsight, so its angles can't be used." });
        else if (!Number.isFinite(fsRead) || !Number.isFinite(bsRead)) problems.push({ ref, msg: `Can't read the angle "${r.reading}".` });
        else {
          const ang = norm2pi(p.circle === "cw" ? fsRead - bsRead : bsRead - fsRead);
          obs.push({ kind: "angle", at: s.station, bs: s.backsight, fs: r.target, value: ang, sigma: sigA, ref });
        }
      }
      if (String(r.dist).trim()) {
        const d = Number(String(r.dist).replace(/,/g, ""));
        if (!(d > 0)) problems.push({ ref, msg: `Can't read the distance "${r.dist}".` });
        else obs.push({ kind: "dist", a: s.station, b: r.target, value: d, sigma: distSigma(p, d), ref });
      }
    }
  }
  for (const b of p.baselines) {
    const ref = { baseline: b.id };
    if ((!b.a && !b.b && !b.dist) || b.off) continue;
    const d = Number(String(b.dist).replace(/,/g, ""));
    if (!ents.get(b.a) || !ents.get(b.b) || b.a === b.b) problems.push({ ref, msg: "Distance needs two different ends." });
    else if (!(d > 0)) problems.push({ ref, msg: `Can't read the distance "${b.dist}".` });
    else obs.push({ kind: "dist", a: b.a, b: b.b, value: d, sigma: distSigma(p, d), ref });
  }
  return { obs, problems };
}
