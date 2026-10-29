/* =========================================================================
 * Georeference: a least-squares fit of landmark latitude/longitude (GPS, or
 * picked on the imagery) to the local survey grid, and Web Mercator imagery
 * tiles drawn through that fit.
 *
 * The survey's own shape and scale are far better than any GPS, so the fit is
 * rigid (shift + rotation) unless the survey has no taped distance, in which
 * case the scale is fitted too. Coordinates go lat/lon -> local tangent plane
 * (metres east/north of the mean position) -> survey grid.
 * ========================================================================= */

/** Where a landmark's lat/lon came from: name and standard error (metres, per axis). */
const GPS_SOURCES = {
  phone: { name: "Phone / handheld GPS", sigma: 3.0 },
  image: { name: "Picked on imagery", sigma: 0.6 },
  rtk: { name: "Survey-grade GPS", sigma: 0.05 },
};

const IMAGERY = {
  esri: { name: "Esri World Imagery", maxZ: 19, attr: "Imagery © Esri, Maxar, Earthstar Geographics",
          url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" },
  usgs: { name: "USGS orthoimagery (US only)", maxZ: 16, attr: "Imagery: USGS The National Map",
          url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}" },
  custom: { name: "Custom tile server", maxZ: 20, attr: "", url: "" },
};

const M_PER_UNIT = { ft: 0.3048, m: 1 };
const WGS_A = 6378137, WGS_E2 = 6.69437999014e-3;
const TILE = 256;

/** Latitude or longitude in degrees from "40.7712", "-73.97", "40 46 16.3 N", "W 73°58'31\"". NaN if invalid. */
function parseLatLon(text, isLon) {
  let s = String(text ?? "").trim().toUpperCase();
  if (!s) return NaN;
  let sign = 1;
  const hm = /^([NSEW])\s*(.*)$/.exec(s) || /^(.*?)\s*([NSEW])$/.exec(s);
  if (hm) {
    const h = /^[NSEW]$/.test(hm[1]) ? hm[1] : hm[2];
    s = /^[NSEW]$/.test(hm[1]) ? hm[2] : hm[1];
    if (isLon !== (h === "E" || h === "W")) return NaN;
    if (h === "S" || h === "W") sign = -1;
  }
  const v = (parseAngle(s) / DEG) * sign;
  return Number.isFinite(v) && Math.abs(v) <= (isLon ? 180 : 90) ? v : NaN;
}

/** "40.771612, -73.974812" (as copied from a map app) -> [lat, lon], else null. */
function splitLatLon(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text ?? ""));
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

const fmtLat = (v) => `${Math.abs(v).toFixed(7)}° ${v < 0 ? "S" : "N"}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(7)}° ${v < 0 ? "W" : "E"}`;

/** Local tangent plane at (lat0, lon0): metres per degree east and north on the WGS 84 ellipsoid. */
function enuBasis(lat0, lon0) {
  const s = Math.sin(lat0 * DEG), w = 1 - WGS_E2 * s * s;
  const N = WGS_A / Math.sqrt(w), M = (WGS_A * (1 - WGS_E2)) / (w * Math.sqrt(w));
  return { lat0, lon0, kE: N * Math.cos(lat0 * DEG) * DEG, kN: M * DEG };
}

/**
 * Fit the survey grid to the landmarks that have a lat/lon.
 * Returns {ok, n, entered, theta (true azimuth of grid north), s, t, fitScale,
 *          resid: Map(id -> {d (survey units), z (in sigmas)}), sigma0, sigTheta, single}.
 */
function georeference(p, sol) {
  const u = M_PER_UNIT[p.units];
  const pts = [];
  let entered = 0;
  for (const l of p.landmarks) {
    const lat = parseLatLon(l.lat, false), lon = parseLatLon(l.lon, true);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    entered++;
    const c = sol.coords.get(l.id);
    if (c) pts.push({ id: l.id, lat, lon, a: [c[0] * u, c[1] * u], w: 1 / GPS_SOURCES[l.gsrc || "phone"].sigma ** 2 });
  }
  const n = pts.length;
  if (!n) return { ok: false, n: 0, entered };
  const b = enuBasis(pts.reduce((s, q) => s + q.lat, 0) / n, pts.reduce((s, q) => s + q.lon, 0) / n);
  for (const q of pts) q.g = [(q.lon - b.lon0) * b.kE, (q.lat - b.lat0) * b.kN];
  const W = pts.reduce((s, q) => s + q.w, 0);
  const ac = [0, 1].map((k) => pts.reduce((s, q) => s + q.w * q.a[k], 0) / W);
  const gc = [0, 1].map((k) => pts.reduce((s, q) => s + q.w * q.g[k], 0) / W);
  let C = 0, S = 0, A2 = 0;
  for (const q of pts) {
    const da = [q.a[0] - ac[0], q.a[1] - ac[1]], dg = [q.g[0] - gc[0], q.g[1] - gc[1]];
    C += q.w * (dg[0] * da[0] + dg[1] * da[1]);
    S += q.w * (dg[0] * da[1] - dg[1] * da[0]);
    A2 += q.w * (da[0] * da[0] + da[1] * da[1]);
  }
  const single = n === 1 || A2 < 1e-12;
  const theta = single ? 0 : Math.atan2(S, C);
  const fitScale = !!sol.unscaled && !single;
  const s = fitScale ? Math.hypot(C, S) / A2 : 1;
  const G = { ok: true, n, entered, b, u, theta, s, fitScale, single, cos: Math.cos(theta), sin: Math.sin(theta) };
  const ra = localToEnuRaw(G, ac);
  G.t = [gc[0] - ra[0], gc[1] - ra[1]];
  G.resid = new Map();
  let chi2 = 0;
  for (const q of pts) {
    const m = localToEnu(G, [q.a[0] / u, q.a[1] / u]);
    const v = Math.hypot(q.g[0] - m[0], q.g[1] - m[1]);
    chi2 += q.w * v * v;
    G.resid.set(q.id, { d: v / u, z: v * Math.sqrt(q.w) });
  }
  const dof = 2 * n - (single ? 2 : fitScale ? 4 : 3);
  G.dof = dof;
  G.sigma0 = dof > 0 ? Math.sqrt(chi2 / dof) : null;
  G.sigTheta = single ? null : Math.max(1, G.sigma0 || 1) / (s * Math.sqrt(A2));
  return G;
}

/** Survey grid metres -> rotated/scaled, without the shift. */
function localToEnuRaw(G, a) {
  return [G.s * (G.cos * a[0] + G.sin * a[1]), G.s * (-G.sin * a[0] + G.cos * a[1])];
}
function localToEnu(G, X) {
  const r = localToEnuRaw(G, [X[0] * G.u, X[1] * G.u]);
  return [r[0] + G.t[0], r[1] + G.t[1]];
}
function enuToLocal(G, g) {
  const d = [(g[0] - G.t[0]) / G.s, (g[1] - G.t[1]) / G.s];
  return [(G.cos * d[0] - G.sin * d[1]) / G.u, (G.sin * d[0] + G.cos * d[1]) / G.u];
}
/** Survey [E, N] -> [lat, lon] degrees. */
function localToLL(G, X) {
  const g = localToEnu(G, X);
  return [G.b.lat0 + g[1] / G.b.kN, G.b.lon0 + g[0] / G.b.kE];
}
function llToLocal(G, lat, lon) {
  return enuToLocal(G, [(lon - G.b.lon0) * G.b.kE, (lat - G.b.lat0) * G.b.kN]);
}

/** RMS distance between the landmarks' lat/lon and their surveyed positions (survey units). */
function rmsGeo(G) {
  const r = [...G.resid.values()];
  return Math.sqrt(r.reduce((a, x) => a + x.d * x.d, 0) / Math.max(1, r.length));
}

/** Messages about the georeference (bad GPS fixes, single fix). */
function geoMessages(p, G) {
  const out = [];
  if (!G || !G.ok) return out;
  const ents = entities(p);
  if (G.single) out.push({ lvl: "info", msg: "Only one landmark has a latitude/longitude, so grid north is taken as true north. Add a second for the rotation.", ids: [] });
  if (G.n >= 3) {
    for (const [id, r] of G.resid) {
      if (r.z > 3.5) {
        const l = p.landmarks.find((x) => x.id === id);
        out.push({ lvl: "warn", ids: [id], msg: `${ents.get(id)?.name}'s latitude/longitude is ${fmtLen(p, r.d, 1)} from where the survey puts it ` +
          `(${GPS_SOURCES[l.gsrc || "phone"].name.toLowerCase()} should be within about ${fmtLen(p, (2.5 * GPS_SOURCES[l.gsrc || "phone"].sigma) / G.u, 1)}). Check it, or re-pick it on the imagery.` });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ imagery tiles
function llToPx(lat, lon, z) {
  const n = TILE * 2 ** z, s = Math.sin(clamp(lat, -85, 85) * DEG);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}
function pxToLl(x, y, z) {
  const n = TILE * 2 ** z;
  return [Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / DEG, (x / n) * 360 - 180];
}

function imageryTemplate(p) {
  const src = IMAGERY[p.geo.source] || IMAGERY.esri;
  return p.geo.source === "custom" ? p.geo.custom.trim() : src.url;
}

/**
 * Tiles covering a target area. toT/fromT map survey [E, N] <-> target
 * [x, y] (y down, e.g. screen pixels). rect = [x0, y0, x1, y1] in target units;
 * mpp = metres per target unit wanted. Returns [{href, m: [a, b, c, d, e, f]}]
 * where m places a 256 x 256 tile image in target coordinates.
 */
function imageryTiles(p, G, toT, fromT, rect, mpp, maxTiles = 90) {
  const tpl = imageryTemplate(p);
  if (!G || !G.ok || !tpl || !/\{z\}/.test(tpl)) return [];
  const src = IMAGERY[p.geo.source] || IMAGERY.esri;
  const lat0 = G.b.lat0;
  let z = clamp(Math.ceil(Math.log2((156543.034 * Math.cos(lat0 * DEG) * G.s) / Math.max(mpp, 1e-6))), 1, src.maxZ);
  const corners = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[0], rect[3]], [rect[2], rect[3]]].map((c) => localToLL(G, fromT(c)));
  let tx0, tx1, ty0, ty1;
  for (;;) {
    const px = corners.map(([la, lo]) => llToPx(la, lo, z));
    tx0 = Math.floor(Math.min(...px.map((q) => q[0])) / TILE); tx1 = Math.floor(Math.max(...px.map((q) => q[0])) / TILE);
    ty0 = Math.floor(Math.min(...px.map((q) => q[1])) / TILE); ty1 = Math.floor(Math.max(...px.map((q) => q[1])) / TILE);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= maxTiles || z <= 1) break;
    z--;
  }
  const n = 2 ** z;
  const at = (x, y) => { const [la, lo] = pxToLl(x, y, z); return toT(llToLocal(G, la, lo)); };
  const out = [];
  for (let ty = Math.max(0, ty0); ty <= Math.min(n - 1, ty1); ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const P0 = at(tx * TILE, ty * TILE), P1 = at((tx + 1) * TILE, ty * TILE), P2 = at(tx * TILE, (ty + 1) * TILE);
      const x = ((tx % n) + n) % n;
      out.push({
        href: tpl.replace("{z}", z).replace("{x}", x).replace("{y}", ty).replace("{s}", "abc"[(x + ty) % 3]),
        m: [(P1[0] - P0[0]) / TILE, (P1[1] - P0[1]) / TILE, (P2[0] - P0[0]) / TILE, (P2[1] - P0[1]) / TILE, P0[0], P0[1]],
      });
    }
  }
  return out;
}

/** SVG <image> elements for tiles (slightly oversized to hide seams). */
function tilesSvg(tiles) {
  return tiles.map((t) => `<image href="${esc(t.href)}" width="${TILE + 0.6}" height="${TILE + 0.6}" preserveAspectRatio="none" ` +
    `transform="matrix(${t.m.map((v) => +v.toFixed(6)).join(" ")})"/>`).join("");
}

// ---------------------------------------------------------------- KML export
function kmlColor(hex, alpha = "ff") {
  const h = hex.replace("#", "");
  return alpha + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
}

/** Google Earth KML of landmarks, points, lines and obstacles. */
function siteKml(p, sol, G) {
  const x = (s) => esc(String(s ?? ""));
  const ll = (X) => { const [la, lo] = localToLL(G, X); return `${lo.toFixed(8)},${la.toFixed(8)},0`; };
  const layerCol = (layer) => ACI_RGB[(LAYERS[layer] || [7])[0]] || "#000000";
  const styles = new Set();
  const style = (id, body) => { styles.add(`<Style id="${id}">${body}</Style>`); return `#${id}`; };
  const marks = [];
  const desc = (rows) => `<description><![CDATA[${rows.filter((r) => r[1]).map(([k, v]) => `<b>${k}:</b> ${String(v).replace(/]]>/g, "")}`).join("<br>")}]]></description>`;
  for (const [id, e] of entities(p)) {
    const c = sol.coords.get(id);
    if (!c) continue;
    const inf = sol.info.get(id);
    const ty = TYPES[e.type] || TYPES[""];
    const sId = e.kind === "lm" ? style("lm", `<IconStyle><color>ff00ffff</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/triangle.png</href></Icon></IconStyle>`)
      : style(`pt-${ty.layer}`, `<IconStyle><color>${kmlColor(ty.layer === "FEATURE" ? "#ffffff" : layerCol(ty.layer))}</color><scale>0.8</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle>`);
    marks.push(`<Placemark><name>${x(e.name)}</name><styleUrl>${sId}</styleUrl>` +
      desc([["Description", e.desc], ["Type", e.kind === "lm" ? "Landmark" : ty.name], ["Depth", e.depth],
            ["Local N, E", `${c[1].toFixed(2)}, ${c[0].toFixed(2)} ${unitAbbr(p)}`], ["±95%", inf ? `${inf.r95.toFixed(2)} ${unitAbbr(p)}` : ""]]) +
      `<Point><coordinates>${ll(c)}</coordinates></Point></Placemark>`);
  }
  for (const l of p.lines) {
    const pts = linePoints(sol, l);
    if (pts.length < 2) continue;
    const ty = TYPES[l.type] || TYPES[""];
    const sId = style(`ln-${ty.layer}`, `<LineStyle><color>${kmlColor(ty.layer === "FEATURE" || ty.layer === "PROPERTY" ? "#ffffff" : layerCol(ty.layer))}</color><width>3</width></LineStyle>`);
    marks.push(`<Placemark><name>${x(l.name)}</name><styleUrl>${sId}</styleUrl>${desc([["Type", ty.name], ["Depth", l.depth], ["Description", l.desc]])}` +
      `<LineString><tessellate>1</tessellate><coordinates>${pts.map(ll).join(" ")}</coordinates></LineString></Placemark>`);
  }
  for (const o of p.obstacles) {
    const pts = obstacleCoords(sol, o);
    if (pts.length < 2) continue;
    const sId = style("obs", `<LineStyle><color>ff9a9a9a</color><width>2</width></LineStyle><PolyStyle><color>66c8c8c8</color></PolyStyle>`);
    const geom = o.closed && pts.length >= 3
      ? `<Polygon><outerBoundaryIs><LinearRing><coordinates>${[...pts, pts[0]].map(ll).join(" ")}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
      : `<LineString><coordinates>${pts.map(ll).join(" ")}</coordinates></LineString>`;
    marks.push(`<Placemark><name>${x(o.name)}</name><styleUrl>${sId}</styleUrl>${desc([["Kind", OBSTACLE_KINDS[o.kind].name], ["Description", o.desc]])}${geom}</Placemark>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(p.name)}</name>` +
    `<description>${x(`${p.location} — positions from the site survey, placed by a fit to ${G.n} landmark latitude/longitude${G.n > 1 ? "s" : ""}.`)}</description>` +
    `${[...styles].join("")}${marks.join("")}</Document></kml>\n`;
}
