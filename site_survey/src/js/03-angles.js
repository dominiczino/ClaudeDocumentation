/* =========================================================================
 * Angles: parsing field entries and formatting DMS / bearings.
 * Internally everything is radians; azimuths are clockwise from grid north.
 * ========================================================================= */

const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;
const SEC = DEG / 3600;
const norm2pi = (a) => ((a % TAU) + TAU) % TAU;
const normPi = (a) => { a = norm2pi(a); return a > Math.PI ? a - TAU : a; };

/**
 * Parse an angle in degrees. Accepts "123 45 20", "123°45'20\"", "123-45-20",
 * "123d45m20s", "123 45.5" (deg + decimal minutes) and "123.7556" (decimal).
 * Returns radians, or NaN.
 */
function parseAngle(text) {
  const s = String(text ?? "").trim().replace(/,/g, ".");
  if (!s) return NaN;
  const neg = s.startsWith("-");
  const parts = s.replace(/^-/, "").split(/[^0-9.]+/).filter(Boolean).map(Number);
  if (!parts.length || parts.length > 3 || parts.some((x) => !Number.isFinite(x))) return NaN;
  const [d, m = 0, sec = 0] = parts;
  if (parts.length > 1 && (m >= 60 || sec >= 60 || !Number.isInteger(d))) return NaN;
  if (parts.length > 2 && !Number.isInteger(m)) return NaN;
  const v = (d + m / 60 + sec / 3600) * DEG;
  return neg ? -v : v;
}

/** Parse a bearing ("N 23 15 20 E", "S45W") or an azimuth ("123 45 20"). Returns azimuth radians or NaN. */
function parseBearing(text) {
  const s = String(text ?? "").trim().toUpperCase();
  const m = /^([NS])\s*(.*?)\s*([EW])$/.exec(s);
  if (!m) return norm2pi(parseAngle(s));
  const a = parseAngle(m[2]);
  if (!Number.isFinite(a) || a > Math.PI / 2 + 1e-12) return NaN;
  if (m[1] === "N") return norm2pi(m[3] === "E" ? a : -a);
  return norm2pi(m[3] === "E" ? Math.PI - a : Math.PI + a);
}

/** Split radians into whole degrees, minutes and (rounded) seconds with carries. */
function dmsParts(rad, secDecimals = 0) {
  const sign = rad < 0 ? -1 : 1;
  const f = 10 ** secDecimals;
  let totalSec = Math.round((Math.abs(rad) / SEC) * f) / f;
  const d = Math.floor(totalSec / 3600 + 1e-12);
  totalSec -= d * 3600;
  const m = Math.floor(totalSec / 60 + 1e-12);
  const s = totalSec - m * 60;
  return { sign, d, m, s: Math.max(0, +s.toFixed(secDecimals)) };
}

function fmtDMS(rad, secDecimals = 0) {
  if (!Number.isFinite(rad)) return "—";
  const { sign, d, m, s } = dmsParts(rad, secDecimals);
  const ss = secDecimals ? s.toFixed(secDecimals).padStart(3 + secDecimals, "0") : String(Math.round(s)).padStart(2, "0");
  return `${sign < 0 ? "-" : ""}${d}°${String(m).padStart(2, "0")}'${ss}"`;
}

/** Azimuth -> quadrant bearing, e.g. N 23°15'20" E. */
function fmtBearing(az) {
  if (!Number.isFinite(az)) return "—";
  az = norm2pi(az);
  let ns, ew, a;
  if (az <= Math.PI / 2) { ns = "N"; ew = "E"; a = az; }
  else if (az <= Math.PI) { ns = "S"; ew = "E"; a = Math.PI - az; }
  else if (az <= 1.5 * Math.PI) { ns = "S"; ew = "W"; a = az - Math.PI; }
  else { ns = "N"; ew = "W"; a = TAU - az; }
  return `${ns} ${fmtDMS(a)} ${ew}`;
}

/** Seconds of arc, for residuals. */
const fmtSec = (rad) => `${Math.round(rad / SEC) || 0}"`;

/** Azimuth from (x1, y1) to (x2, y2): x = east, y = north, clockwise from north. */
const azimuth = (x1, y1, x2, y2) => norm2pi(Math.atan2(x2 - x1, y2 - y1));
