/* =========================================================================
 * Drawing the site: shared by the on-screen map, the ANSI B plan sheet,
 * the report figure and the 1:1 DXF.
 * ========================================================================= */

/**
 * Draw the site into `sh`. T maps world [E, N] to sheet [x, y].
 * o: {th: text height, sym: symbol size, sights, ellipses (exaggeration or 0),
 *     letterEvery: spacing of utility letters (sheet units), hi: Set of ids to emphasise}
 */
function drawSite(sh, p, sol, T, o) {
  const th = o.th, sym = o.sym;
  const placed = [];   // label boxes, to keep labels apart
  const font = sh.font;
  const XY = (id) => (sol.coords.has(id) ? T(sol.coords.get(id)) : null);

  // obstacles, beneath everything else
  for (const ob of p.obstacles || []) {
    const pts = obstacleCoords(sol, ob).map(T);
    if (pts.length < 2) continue;
    const k = OBSTACLE_KINDS[ob.kind];
    const closed = ob.closed && pts.length >= 3;
    sh.owner = "obs:" + ob.id;
    if (closed && k.fill) sh.fill(pts, "OBSTACLE-FILL");
    sh.poly(pts, ob.blocks ? k.layer : "OBSTACLE-LOW", closed);
    if (!ob.name || o.labels === false) continue;
    const h = th * 0.85, w = textWidth(ob.name, h, false, font);
    let c;
    if (closed) {
      const bb = pts.reduce((b, q) => R.union(b, [q[0], q[1], q[0], q[1]]), null);
      if (R.w(bb) < w * 1.15 || R.h(bb) < h * 2) continue;
      c = [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length];
      if (!pointInPoly(c, pts)) continue;
    } else {
      let li = 1;
      for (let i = 1; i < pts.length; i++) if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) > Math.hypot(pts[li][0] - pts[li - 1][0], pts[li][1] - pts[li - 1][1])) li = i;
      c = [(pts[li][0] + pts[li - 1][0]) / 2, (pts[li][1] + pts[li - 1][1]) / 2 + h];
    }
    sh.text(ob.name, c[0], c[1], h, "MC", "TEXT-MINOR");
    placed.push([c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2]);
  }

  // sight lines
  if (o.sights) {
    const seen = new Set();
    for (const ob of sol.obs) {
      if (ob.kind !== "angle") continue;
      const k = ob.at + ">" + ob.fs;
      if (seen.has(k)) continue;
      seen.add(k);
      const a = XY(ob.at), b = XY(ob.fs);
      if (!a || !b) continue;
      sh.owner = "sight:" + k;
      sh.line(a[0], a[1], b[0], b[1], "SIGHT");
    }
  }

  // lines (utilities, fences, property lines)
  for (const line of p.lines) {
    const pts = line.pts.map(XY).filter(Boolean);
    if (pts.length < 2) continue;
    const ty = TYPES[line.type] || TYPES[""];
    sh.owner = "line:" + line.id;
    const letter = ty.letter;
    if (!letter || !o.letterEvery) { sh.poly(pts, ty.layer); continue; }
    // letters sit mid-segment (away from the point symbols), the line broken around them
    const lw = sh.width(letter, th * 0.9, true) + th * 0.8;
    const clearEnds = sym * 0.6 + lw / 2;
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const at = (t) => [a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L];
      const usable = L - 2 * clearEnds;
      const n = usable <= 0 ? 0 : Math.max(1, Math.round(usable / o.letterEvery));
      let s0 = 0;
      for (let k = 0; k < n; k++) {
        const m = clearEnds + (usable * (k + 0.5)) / n;
        sh.poly([at(s0), at(m - lw / 2)], ty.layer);
        const c = at(m);
        sh.text(letter, c[0], c[1], th * 0.9, "MC", ty.layer, true);
        s0 = m + lw / 2;
      }
      sh.poly([at(s0), b], ty.layer);
    }
  }

  // error ellipses (95 %, exaggerated)
  if (o.ellipses) {
    for (const [id, inf] of sol.info) {
      const c = XY(id);
      if (!c || !inf.ellipse || inf.ellipse.a < 1e-9) continue;
      const e = inf.ellipse, k = 2.4477 * o.ellipses * (o.k || 1);
      const pts = [];
      for (let i = 0; i < 48; i++) {
        const t = (i / 48) * TAU;
        const u = e.a * k * Math.cos(t), v = e.b * k * Math.sin(t);
        // u along the major axis (azimuth e.az), v across it
        pts.push([c[0] + u * Math.sin(e.az) + v * Math.cos(e.az), c[1] + u * Math.cos(e.az) - v * Math.sin(e.az)]);
      }
      sh.owner = id;
      sh.poly(pts, "ELLIPSE", true);
    }
  }

  // symbols, then labels avoiding each other
  const items = [];
  for (const l of p.landmarks) {
    const c = XY(l.id);
    if (!c) continue;
    sh.owner = l.id;
    const s = sym;
    sh.poly([[c[0], c[1] + s * 0.62], [c[0] - s * 0.54, c[1] - s * 0.31], [c[0] + s * 0.54, c[1] - s * 0.31]], "CONTROL", true);
    sh.fill([[c[0] - s * 0.08, c[1], 1], [c[0] + s * 0.08, c[1], 1]]);
    placed.push([c[0] - s * 0.55, c[1] - s * 0.35, c[0] + s * 0.55, c[1] + s * 0.65]);
    items.push({ id: l.id, c, name: l.name, bold: true, r: s * 0.6, layer: "TEXT" });
  }
  for (const x of p.points) {
    const c = XY(x.id);
    if (!c) continue;
    const ty = TYPES[x.type] || TYPES[""];
    sh.owner = x.id;
    const r = sym * 0.22;
    sh.circle(c[0], c[1], r, ty.layer === "FEATURE" || ty.layer === "PROPERTY" ? "POINT" : ty.layer);
    sh.fill([[c[0] - r * 0.35, c[1], 1], [c[0] + r * 0.35, c[1], 1]]);
    placed.push([c[0] - r, c[1] - r, c[0] + r, c[1] + r]);
    items.push({ id: x.id, c, name: x.name, bold: false, r, layer: "LABEL" });
  }
  if (o.labels !== false) {
    for (const it of items) {
      const h = it.bold ? th * 1.05 : th;
      const w = textWidth(it.name, h, it.bold, font);
      const g = it.r + th * 0.35;
      const cands = [["BL", g, g * 0.6], ["BR", -g, g * 0.6], ["TL", g, -g * 0.6], ["TR", -g, -g * 0.6],
                     ["ML", g * 1.2, 0], ["MR", -g * 1.2, 0]];
      let pick = null;
      for (const [al, dx, dy] of cands) {
        const x = it.c[0] + dx, y = it.c[1] + dy;
        const x0 = al[1] === "L" ? x : x - w;
        const y0 = al[0] === "B" ? y : al[0] === "T" ? y - h : y - h / 2;
        const box = [x0, y0, x0 + w, y0 + h];
        const hit = placed.some((b) => R.overlaps(R.inflate(box, th * 0.15), b));
        if (!pick || !hit) pick = { al, x, y, box, hit };
        if (!hit) break;
      }
      placed.push(pick.box);
      sh.owner = it.id;
      sh.text(it.name, pick.x, pick.y, h, pick.al, it.layer, it.bold);
    }
  }
  sh.owner = "sheet";
}

/** Extents of located points and obstacle outlines (world), or null. */
function siteExtents(sol, p = null) {
  let b = null;
  for (const [, c] of sol.coords) b = R.union(b, [c[0], c[1], c[0], c[1]]);
  for (const o of p ? p.obstacles : []) for (const c of obstacleCoords(sol, o)) b = R.union(b, [c[0], c[1], c[0], c[1]]);
  return b;
}

// --------------------------------------------------------------- plan sheet
const SCALES = {
  ft: [5, 10, 20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400, 500, 1000, 2000],   // feet per inch
  m: [50, 100, 200, 250, 500, 1000, 1250, 2000, 2500, 5000, 10000, 20000],        // 1:n
};
const unitsPerInch = (p, s) => (p.units === "m" ? (s * 0.0254) : s);
const scaleText = (p, s) => (p.units === "m" ? `1:${s}` : `1" = ${s}'`);

function niceStep(x) {
  const e = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * e >= x) return m * e;
  return 10 * e;
}

function drawBorder(sh) {
  sh.rect(FRAME, FRAME, SHEET_W - FRAME, SHEET_H - FRAME, "FRAME-THIN");
  sh.rect(IX0, IY0, IX1, IY1, "FRAME");
  const ncol = 8, nrow = 4;
  const zw = (SHEET_W - 2 * FRAME) / ncol, zh = (SHEET_H - 2 * FRAME) / nrow;
  for (let i = 0; i < ncol; i++) {
    const x0 = SHEET_W - FRAME - (i + 1) * zw;
    if (i < ncol - 1) { sh.line(x0, FRAME, x0, IY0, "FRAME-THIN"); sh.line(x0, IY1, x0, SHEET_H - FRAME, "FRAME-THIN"); }
    for (const yc of [FRAME + BAND / 2, SHEET_H - FRAME - BAND / 2]) sh.text(String(i + 1), x0 + zw / 2, yc, 0.11);
  }
  for (let j = 0; j < nrow; j++) {
    const y0 = FRAME + j * zh;
    if (j) { sh.line(FRAME, y0, IX0, y0, "FRAME-THIN"); sh.line(IX1, y0, SHEET_W - FRAME, y0, "FRAME-THIN"); }
    for (const xc of [FRAME + BAND / 2, SHEET_W - FRAME - BAND / 2]) sh.text("ABCD"[j], xc, y0 + zh / 2, 0.11);
  }
}

function cell(sh, x0, y0, x1, y1, label, value, { vh = 0.11, bold = false, align = "left", maxLines = 2 } = {}) {
  sh.text(label, x0 + 0.05, y1 - 0.05, 0.055, "TL", "TEXT-MINOR");
  sh.textBox(value, x0, y0, x1, y1 - 0.09, vh, { hMin: 0.06, align, bold, maxLines });
}

function drawTitleBlock(sh, p, scaleStr) {
  const tb = p.titleblock;
  const up = (v, def = "") => String(v || def).toUpperCase();
  const x0 = IX1 - TB_W, y0 = IY0, x1 = IX1, y1 = IY0 + TB_H;
  sh.rect(x0, y0, x1, y1, "TITLE");
  const ys = [y1];
  for (const h of [0.40, 0.45, 0.35, 0.35]) ys.push(ys[ys.length - 1] - h);
  for (const y of ys.slice(1, -1)) sh.line(x0, y, x1, y, "TITLE-GRID");
  cell(sh, x0, ys[1], x1, ys[0], "PROJECT / PROPERTY", up(tb.project || p.location), { vh: 0.14, bold: true, maxLines: 1 });
  cell(sh, x0, ys[2], x1, ys[1], "DRAWING TITLE", up(tb.title, `${p.name} — SITE SURVEY`), { vh: 0.13, bold: true });
  const k = TB_W / 4.6;
  const row3 = [["DRAWN BY", up(tb.drawn_by || p.surveyor), 1.6], ["DATE", tb.date || isoToday(), 1.5], ["SCALE", up(scaleStr), 1.5]];
  const row4 = [["SIZE", "B", 0.55], ["DWG NO.", up(tb.dwg_no), 2.15], ["REV", up(tb.rev), 0.55], ["SHEET", up(tb.sheet, "1 OF 1"), 1.35]];
  for (const [row, ya, yb] of [[row3, ys[3], ys[2]], [row4, ys[4], ys[3]]]) {
    let x = x0;
    row.forEach(([lab, val, w], i) => {
      w *= k;
      if (i) sh.line(x, ya, x, yb, "TITLE-GRID");
      cell(sh, x, ya, x + w, yb, lab, val, { vh: lab === "SIZE" ? 0.15 : 0.11, align: "center", maxLines: 1, bold: lab === "SIZE" || lab === "REV" });
      x += w;
    });
  }
}

/** Notes printed on the plan: the datum and precision basis, then the user's notes. */
/** "3°58'12\" west of true north" for a grid-north azimuth theta. */
function gridNorthText(theta) {
  return `${fmtDMS(Math.abs(theta)).replace(/^0+(?=\d)/, "")} ${theta < 0 ? "west" : "east"} of true north`;
}

function planNotes(p, sol, G = null) {
  const ents = entities(p);
  const nm = (id) => ents.get(id)?.name || "?";
  const u = unitAbbr(p);
  const auto = [
    `Local coordinates in ${UNITS[p.units].name}: ${nm(p.datum.origin)} = N ${p.datum.originN.toFixed(2)}, E ${p.datum.originE.toFixed(2)}.`,
    `Basis of bearings: ${nm(p.datum.origin)} to ${nm(p.datum.orient)} = ${fmtBearing(parseBearing(p.datum.bearing))}.`,
    `Positions adjusted by least squares from ${sol.obs.filter((o) => o.kind === "angle").length} angles and ${sol.obs.filter((o) => o.kind === "dist").length} distances; ` +
      `angle reading precision ${p.angleSigma}". ± values are 95% radii (${u}).`,
  ];
  if (sol.unscaled) auto.push("NO MEASURED DISTANCE: drawing is to an arbitrary scale.");
  if (G && G.ok && !G.single) auto.push(`Grid north is ${gridNorthText(G.theta)} (fit to latitude/longitude of ${G.n} landmarks, ±${fmtDMS(2 * G.sigTheta).replace(/^0°/, "")}).`);
  return [...auto, ...p.notes.filter((n) => n.trim())];
}

function notesBlock(sh, notes, x0, x1, y0) {
  const h = 0.075, w = x1 - x0 - 0.45;
  const blocks = notes.map((n) => sh.wrap(n, w, h));
  const need = 0.26 + blocks.reduce((a, b) => a + b.length, 0) * h * LINE_SPACING + 0.05;
  const y1 = y0 + need;
  sh.rect(x0, y0, x1, y1, "TITLE");
  sh.text("NOTES", x0 + 0.08, y1 - 0.07, 0.08, "TL", "TEXT", true);
  let y = y1 - 0.26 - h / 2;
  blocks.forEach((b, i) => {
    sh.text(`${i + 1}.`, x0 + 0.1, y, h, "ML");
    for (const ln of b) { sh.text(ln, x0 + 0.33, y, h, "ML"); y -= h * LINE_SPACING; }
  });
  return y1;
}

/** Coordinate table in the right-hand column. Returns the y of its bottom edge. */
function table(sh, x0, x1, yTop, yMin, title, cols, rows) {
  const rh = 0.155, th = 0.07, hh = 0.2;
  let y = yTop;
  sh.text(title, x0, y - 0.02, 0.085, "TL", "TEXT", true);
  y -= 0.16;
  const W = x1 - x0;
  const widths = cols.map((c) => c.w * W);
  const head = y;
  sh.rect(x0, y - hh, x1, y, "TITLE");
  let x = x0;
  cols.forEach((c, i) => { sh.textBox(c.name, x, y - hh, x + widths[i], y, 0.06, { align: "center", bold: true, pad: 0.02, maxLines: 1 }); x += widths[i]; });
  y -= hh;
  const room = Math.max(0, Math.floor((y - yMin) / rh));
  const shown = rows.length > room ? rows.slice(0, Math.max(0, room - 1)) : rows;
  for (const r of shown) {
    x = x0;
    cols.forEach((c, i) => {
      sh.textBox(String(r[i] ?? ""), x, y - rh, x + widths[i], y, th, { hMin: 0.05, align: c.align || "left", pad: 0.03, maxLines: 1, layer: i ? "LABEL" : "TEXT", bold: i === 0 });
      x += widths[i];
    });
    y -= rh;
    sh.line(x0, y, x1, y, "TITLE-GRID");
  }
  if (shown.length < rows.length) {
    sh.text(`… ${rows.length - shown.length} more — see the survey report`, x0 + 0.05, y - rh / 2, th, "ML", "TEXT-MINOR");
    y -= rh;
  }
  sh.rect(x0, y, x1, head, "TITLE");
  x = x0;
  for (let i = 0; i < cols.length - 1; i++) { x += widths[i]; sh.line(x, y, x, head, "TITLE-GRID"); }
  return y;
}

function chooseScale(p, ext, w, h) {
  const list = SCALES[p.units];
  if (p.plotScale && list.includes(+p.plotScale)) return +p.plotScale;
  const W = Math.max(R.w(ext), 1e-6), H = Math.max(R.h(ext), 1e-6);
  return list.find((s) => W / unitsPerInch(p, s) <= w && H / unitsPerInch(p, s) <= h) || list[list.length - 1];
}

/** The ANSI B plan sheet. */
function renderPlan(p, sol, opts = {}) {
  const sh = new Sheet(FONTS[p.font] || FONTS[DEFAULT_FONT]);
  drawBorder(sh);
  const ext = siteExtents(sol, p) || [0, 0, 1, 1];
  const mx0 = IX0 + 0.2, my0 = IY0 + 0.2, mx1 = IX1 - TB_W - 0.25, my1 = IY1 - 0.2;
  const margin = 0.6;
  const scale = chooseScale(p, ext, mx1 - mx0 - 2 * margin, my1 - my0 - 2 * margin);
  const upi = unitsPerInch(p, scale);
  const scaleStr = scaleText(p, scale);
  drawTitleBlock(sh, p, scaleStr);
  // map frame and transform (centred)
  sh.rect(mx0, my0, mx1, my1, "MAP-FRAME");
  const cx = (mx0 + mx1) / 2, cy = (my0 + my1) / 2;
  const ec = [R.cx(ext), R.cy(ext)];
  const T = (w) => [cx + (w[0] - ec[0]) / upi, cy + (w[1] - ec[1]) / upi];
  const Ti = (x, y) => [ec[0] + (x - cx) * upi, ec[1] + (y - cy) * upi];

  // coordinate grid: ticks every ~1.5 in, labelled on the frame
  const step = niceStep(1.5 * upi);
  const [we0] = Ti(mx0, my0), [we1] = Ti(mx1, my1);
  const wn0 = Ti(mx0, my0)[1], wn1 = Ti(mx1, my1)[1];
  const tick = 0.06;
  for (let e = Math.ceil(we0 / step) * step; e <= we1; e += step) {
    const x = T([e, 0])[0];
    if (x < mx0 + 0.3 || x > mx1 - 0.3) continue;
    sh.line(x, my0, x, my0 + 0.1, "GRID"); sh.line(x, my1, x, my1 - 0.1, "GRID");
    sh.text(`E ${e.toFixed(0)}`, x, my0 + 0.14, 0.06, "BC", "TEXT-MINOR");
    for (let n = Math.ceil(wn0 / step) * step; n <= wn1; n += step) {
      const y = T([0, n])[1];
      if (y < my0 + 0.3 || y > my1 - 0.3) continue;
      sh.line(x - tick, y, x + tick, y, "GRID"); sh.line(x, y - tick, x, y + tick, "GRID");
    }
  }
  for (let n = Math.ceil(wn0 / step) * step; n <= wn1; n += step) {
    const y = T([0, n])[1];
    if (y < my0 + 0.3 || y > my1 - 0.3) continue;
    sh.line(mx0, y, mx0 + 0.1, y, "GRID"); sh.line(mx1, y, mx1 - 0.1, y, "GRID");
    sh.text(`N ${n.toFixed(0)}`, mx0 + 0.14, y, 0.06, "ML", "TEXT-MINOR");
  }

  drawSite(sh, p, sol, T, { th: 0.08, sym: 0.14, sights: opts.sights ?? !!p.planSights, ellipses: 0, letterEvery: 1.4, k: 1 / upi });

  // north arrow (grid north) and scale bar
  const nx = mx1 - 0.55, ny = my1 - 0.85;
  sh.owner = "north";
  sh.circle(nx, ny, 0.28, "NORTH");
  sh.fill([[nx, ny + 0.36], [nx - 0.1, ny - 0.18], [nx, ny - 0.08]]);
  sh.poly([[nx, ny + 0.36], [nx + 0.1, ny - 0.18], [nx, ny - 0.08]], "NORTH", true);
  sh.text("N", nx, ny + 0.46, 0.13, "BC", "TEXT", true);
  sh.text("GRID", nx, ny - 0.36, 0.055, "TC", "TEXT-MINOR");
  const G = opts.geo;
  if (G && G.ok && !G.single) {
    // true north: a thin line at azimuth -theta from the arrow's centre
    const a = -G.theta, L = 0.5;
    const ex = nx + L * Math.sin(a), ey = ny + L * Math.cos(a);
    sh.line(nx + 0.3 * Math.sin(a), ny + 0.3 * Math.cos(a), ex, ey, "NORTH");
    sh.text("TN", ex + 0.06 * Math.sign(Math.sin(a) || 1), ey + 0.02, 0.06, Math.sin(a) < 0 ? "BR" : "BL", "TEXT-MINOR");
  }
  const barUnit = niceStep(upi * 0.75);   // one block ~0.75 in
  const bw = barUnit / upi, bx = mx0 + 0.35, by = my0 + 0.45;
  for (let i = 0; i < 4; i++) {
    const r = [bx + i * bw, by, bx + (i + 1) * bw, by + 0.07];
    if (i % 2 === 0) sh.fill([[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]);
    sh.rect(...r, "NORTH");
    sh.text(String(+(i * barUnit).toFixed(2)), bx + i * bw, by + 0.11, 0.06, "BC", "TEXT-MINOR");
  }
  sh.text(`${+(4 * barUnit).toFixed(2)} ${unitAbbr(p).toUpperCase()}`, bx + 4 * bw, by + 0.11, 0.06, "BC", "TEXT-MINOR");
  sh.text(`SCALE ${scaleStr}`, bx, by - 0.07, 0.075, "TL", "TEXT", true);
  sh.owner = "sheet";

  // right column: notes above the title block, tables above them
  const cx0 = IX1 - TB_W, cx1 = IX1;
  const notesTop = notesBlock(sh, planNotes(p, sol, opts.geo), cx0, cx1, IY0 + TB_H);
  const lmRows = p.landmarks.filter((l) => sol.coords.has(l.id)).map((l) => {
    const c = sol.coords.get(l.id);
    return [l.name, c[1].toFixed(2), c[0].toFixed(2), l.desc];
  });
  let y = IY1 - 0.15;
  y = table(sh, cx0 + 0.1, cx1 - 0.1, y, notesTop + 1.2, "CONTROL (LANDMARKS)",
    [{ name: "NAME", w: 0.15 }, { name: "NORTHING", w: 0.17, align: "right" }, { name: "EASTING", w: 0.17, align: "right" },
     { name: "DESCRIPTION", w: 0.51 }], lmRows);
  const ptRows = p.points.filter((x) => sol.coords.has(x.id)).map((x) => {
    const c = sol.coords.get(x.id), inf = sol.info.get(x.id);
    return [x.name, (TYPES[x.type] || TYPES[""]).name, c[1].toFixed(2), c[0].toFixed(2), inf ? inf.r95.toFixed(2) : "", x.depth];
  });
  table(sh, cx0 + 0.1, cx1 - 0.1, y - 0.2, notesTop + 0.1, "POINTS",
    [{ name: "NAME", w: 0.13 }, { name: "TYPE", w: 0.2 }, { name: "NORTHING", w: 0.17, align: "right" },
     { name: "EASTING", w: 0.17, align: "right" }, { name: "±95%", w: 0.11, align: "right" }, { name: "DEPTH", w: 0.22 }], ptRows);
  return { sheet: sh, scale, upi, T, Ti, frame: [mx0, my0, mx1, my1] };
}

/**
 * Imagery for the printed plan: tiles at ~200 dpi clipped to the map frame,
 * as SVG to place right after the sheet's white background.
 */
function planImagery(p, G, plan) {
  if (!G || !G.ok) return { svg: "", tiles: [] };
  const [x0, y0, x1, y1] = plan.frame;
  const toS = (w) => { const q = plan.T(w); return [q[0], SHEET_H - q[1]]; };
  const tiles = imageryTiles(p, G, toS, (q) => plan.Ti(q[0], SHEET_H - q[1]), [x0, SHEET_H - y1, x1, SHEET_H - y0], (plan.upi * G.u * G.s) / 200, 150);
  const attr = p.geo.source === "custom" ? "" : IMAGERY[p.geo.source].attr;
  const svg = `<defs><clipPath id="mapclip"><rect x="${x0}" y="${SHEET_H - y1}" width="${x1 - x0}" height="${y1 - y0}"/></clipPath></defs>` +
    `<g clip-path="url(#mapclip)"><g opacity="${p.geo.opacity}">${tilesSvg(tiles)}</g>` +
    (attr ? `<text x="${x1 - 0.06}" y="${SHEET_H - y0 - 0.06}" text-anchor="end" font-size="0.075" fill="#fff" stroke="#000" stroke-width="0.012" paint-order="stroke">${esc(attr)}</text>` : "") + `</g>`;
  return { svg, tiles };
}

// --------------------------------------------------------- 1:1 DXF and CSV
/** Site in world units (1:1), text sized for plotting at the plan scale. */
function renderSiteWorld(p, sol) {
  const ext = siteExtents(sol, p) || [0, 0, 1, 1];
  const scale = chooseScale(p, ext, IX1 - TB_W - IX0 - 2.2, IY1 - IY0 - 2.2);
  const upi = unitsPerInch(p, scale);
  const sh = new Sheet(FONTS[p.font] || FONTS[DEFAULT_FONT]);
  drawSite(sh, p, sol, (w) => w, { th: 0.08 * upi, sym: 0.14 * upi, sights: true, ellipses: 0, letterEvery: 1.4 * upi, k: 1 });
  return sh;
}

function worldDxf(p, sol) {
  const dxf = sheetToDxf(renderSiteWorld(p, sol));
  // drawing units: feet (2) or metres (6)
  return dxf.replace("$INSUNITS\n 70\n1\n", `$INSUNITS\n 70\n${p.units === "m" ? 6 : 2}\n`);
}

/** PNEZD-style CSV: point, northing, easting, (blank elevation), description. */
function coordinatesCsv(p, sol, G = null) {
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const geo = G && G.ok;
  const rows = [["Point", "Northing", "Easting", "Elevation", "Description", "Kind", "Type", "Depth", "Plus/minus 95%", "Checked",
                 ...(geo ? ["Latitude", "Longitude"] : [])]];
  for (const [id, ent] of entities(p)) {
    const c = sol.coords.get(id);
    if (!c) continue;
    const inf = sol.info.get(id);
    rows.push([ent.name, c[1].toFixed(3), c[0].toFixed(3), "", ent.desc, ent.kind === "lm" ? "landmark" : "point",
               ent.kind === "pt" ? (TYPES[ent.type] || TYPES[""]).name : "control", ent.depth || "", inf ? inf.r95.toFixed(3) : "",
               inf && inf.checked ? "yes" : "no", ...(geo ? localToLL(G, c).map((v) => v.toFixed(8)) : [])]);
  }
  return rows.map((r) => r.map((v, i) => (i === 1 || i === 2 || (i > 9 && r !== rows[0]) ? v : q(v))).join(",")).join("\r\n");
}
