/* =========================================================================
 * Utilities
 * ========================================================================= */
"use strict";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const snap = (v, g) => Math.round(v / g) * g;
const round4 = (v) => Math.round(v * 1e4) / 1e4;
const clone = (o) => JSON.parse(JSON.stringify(o));
let _uidCounter = 0;
const uid = (p = "n") => `${p}${Date.now().toString(36)}${(_uidCounter++).toString(36)}`;

// rectangles are [x0, y0, x1, y1] with x0 <= x1, y0 <= y1
const R = {
  of: (x0, y0, x1, y1) => [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)],
  union: (a, b) => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]),
  inflate: (r, d) => [r[0] - d, r[1] - d, r[2] + d, r[3] + d],
  overlaps: (a, b, eps = 1e-6) => a[0] < b[2] - eps && b[0] < a[2] - eps && a[1] < b[3] - eps && b[1] < a[3] - eps,
  contains: (r, x, y, eps = 0) => x >= r[0] - eps && x <= r[2] + eps && y >= r[1] - eps && y <= r[3] + eps,
  w: (r) => r[2] - r[0],
  h: (r) => r[3] - r[1],
  cx: (r) => (r[0] + r[2]) / 2,
  cy: (r) => (r[1] + r[3]) / 2,
  shift: (r, dx, dy) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy],
};

// 2D transforms for symbols: local -> world. rot is CCW degrees in {0,90,180,270}.
function rotVec(x, y, rot) {
  switch (((rot % 360) + 360) % 360) {
    case 90: return [-y, x];
    case 180: return [-x, -y];
    case 270: return [y, -x];
    default: return [x, y];
  }
}

/** Rotation (CCW deg) that maps unit vector a onto unit vector b (axis-aligned). */
function rotBetween(a, b) {
  for (const r of [0, 90, 180, 270]) {
    const [x, y] = rotVec(a[0], a[1], r);
    if (Math.abs(x - b[0]) < 1e-9 && Math.abs(y - b[1]) < 1e-9) return r;
  }
  return 0;
}

const DIRS = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] };
const dirName = (v) => (v[1] > 0.5 ? "N" : v[1] < -0.5 ? "S" : v[0] > 0.5 ? "E" : "W");

function isoToday() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/** Binary min-heap keyed by numeric priority. */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item, pri) {
    const a = this.a;
    a.push([pri, item]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top[1];
  }
}
