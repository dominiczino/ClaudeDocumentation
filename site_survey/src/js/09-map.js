/* =========================================================================
 * Interactive map (screen pixels, y up internally) and the SVG converter
 * used for it and for the report figure.
 * ========================================================================= */

/** Sheet in pixel units -> SVG markup (height H for the y flip). Groups by owner. */
function sheetToPxSvg(sh, H, { strokeScale = 1 } = {}) {
  const Y = (y) => +(H - y).toFixed(2);
  const f = (v) => +v.toFixed(2);
  const groups = new Map();
  const add = (o, s) => { if (!groups.has(o)) groups.set(o, []); groups.get(o).push(s); };
  const col = (layer) => ACI_RGB[(LAYERS[layer] || [7])[0]] || "#000";
  const stroke = (layer) => {
    const [, lw, dashed] = LAYERS[layer] || [7, 25];
    const w = Math.max(0.9, (Math.max(lw, 13) / 100 / 25.4) * 96 * strokeScale);
    return `stroke="${col(layer)}" stroke-width="${w.toFixed(2)}"${dashed ? ` stroke-dasharray="${(6 * strokeScale).toFixed(1)} ${(4 * strokeScale).toFixed(1)}"` : ""}`;
  };
  for (const e of sh.ents) {
    if (e.t === "line") add(e.owner, `<line x1="${f(e.x0)}" y1="${Y(e.y0)}" x2="${f(e.x1)}" y2="${Y(e.y1)}" ${stroke(e.layer)}/>`);
    else if (e.t === "circle") add(e.owner, `<circle cx="${f(e.x)}" cy="${Y(e.y)}" r="${f(e.r)}" fill="#fff" ${stroke(e.layer)}/>`);
    else if (e.t === "poly") add(e.owner, `<path d="${svgPathD(e.pts, e.closed, Y)}" fill="${e.closed && e.layer === "CONTROL" ? "#fff" : "none"}" ${stroke(e.layer)}/>`);
    else if (e.t === "fill") add(e.owner, `<path d="${svgPathD(e.pts, true, Y)}" fill="${col(e.layer)}" stroke="none"/>`);
    else if (e.t === "text") {
      const [v, hz] = e.align;
      const base = v === "M" ? e.y - e.h / 2 : v === "T" ? e.y - e.h : e.y;
      const anchor = hz === "L" ? "start" : hz === "R" ? "end" : "middle";
      add(e.owner, `<text x="${f(e.x)}" y="${Y(base)}" font-size="${f(e.h / sh.font.cap)}" text-anchor="${anchor}"` +
        `${e.bold ? ' font-weight="bold"' : ""} fill="${col(e.layer)}" paint-order="stroke" stroke="#fff" stroke-width="${(2.5 * strokeScale).toFixed(1)}" stroke-linejoin="round">${esc(e.s)}</text>`);
    }
  }
  let out = "";
  for (const [o, items] of groups) out += `<g data-owner="${esc(o)}">${items.join("")}</g>`;
  return out;
}

const MAP = {
  view: null,          // {cx, cy, ppu}
  opts: { sights: true, ellipses: true, labels: true },
  onPick: null,        // (worldXY, ownerId) => void
  find: null,          // {target: [E, N], setups: [option...]}
  selected: null,
};

function mapSize() {
  const r = $("#mapSvg").getBoundingClientRect();
  return [Math.max(200, r.width), Math.max(200, r.height)];
}

function mapFit(sol) {
  const ext = siteExtents(sol);
  const [W, H] = mapSize();
  if (!ext) { MAP.view = { cx: 5000, cy: 5000, ppu: 3 }; return; }
  const w = Math.max(R.w(ext), 10), h = Math.max(R.h(ext), 10);
  MAP.view = { cx: R.cx(ext), cy: R.cy(ext), ppu: Math.min((W - 140) / w, (H - 120) / h) };
}

const mapT = () => {
  const [W, H] = mapSize(), v = MAP.view;
  return { T: (w) => [(w[0] - v.cx) * v.ppu + W / 2, (w[1] - v.cy) * v.ppu + H / 2],
           Ti: (x, y) => [v.cx + (x - W / 2) / v.ppu, v.cy + (y - H / 2) / v.ppu], W, H };
}

function renderMap(p, sol) {
  if (!MAP.view) mapFit(sol);
  const { T, W, H } = mapT();
  const sh = new Sheet(FONTS[p.font] || FONTS[DEFAULT_FONT]);
  // ellipse exaggeration: largest 95 % ellipse drawn ~ 18 px
  let maxR = 0;
  for (const [, inf] of sol.info) maxR = Math.max(maxR, inf.r95 || 0);
  const exag = maxR > 0 ? Math.max(1, Math.round(18 / (maxR * MAP.view.ppu))) : 1;
  drawSite(sh, p, sol, T, { th: 9, sym: 15, sights: MAP.opts.sights, ellipses: MAP.opts.ellipses ? exag : 0,
                            letterEvery: 150, k: MAP.view.ppu, labels: MAP.opts.labels });
  // find overlay
  const parts = [];
  if (MAP.find && MAP.find.target) {
    const X = T(MAP.find.target);
    for (const o of MAP.find.setups || []) {
      if (!sol.coords.has(o.station)) continue;
      const S = T(sol.coords.get(o.station)), B = T(sol.coords.get(o.backsight));
      parts.push(`<line x1="${S[0]}" y1="${H - S[1]}" x2="${B[0]}" y2="${H - B[1]}" class="find-bs"/>`);
      parts.push(`<line x1="${S[0]}" y1="${H - S[1]}" x2="${X[0]}" y2="${H - X[1]}" class="find-ray"/>`);
    }
    parts.push(`<circle cx="${X[0]}" cy="${H - X[1]}" r="9" class="find-target"/>`,
               `<path d="M${X[0] - 14} ${H - X[1]}h28M${X[0]} ${H - X[1] - 14}v28" class="find-target"/>`);
  }
  if (MAP.selected && sol.coords.has(MAP.selected)) {
    const c = T(sol.coords.get(MAP.selected));
    parts.push(`<circle cx="${c[0]}" cy="${H - c[1]}" r="14" class="sel-ring"/>`);
  }
  // north arrow and scale bar (screen furniture)
  const unit = niceStep(90 / MAP.view.ppu);
  const bw = unit * MAP.view.ppu;
  parts.push(`<g class="furniture"><path d="M${W - 34} 22l9 26l-9-7l-9 7z" fill="#333"/><text x="${W - 34}" y="18" text-anchor="middle" font-weight="bold" font-size="13">N</text>` +
             `<rect x="16" y="${H - 26}" width="${bw}" height="6" fill="#333"/><text x="16" y="${H - 32}" font-size="11">${+unit.toFixed(2)} ${unitAbbr(p)}` +
             `${MAP.opts.ellipses && maxR > 0 ? ` · ellipses ×${exag}` : ""}</text></g>`);
  $("#mapSvg").setAttribute("viewBox", `0 0 ${W} ${H}`);
  $("#mapSvg").innerHTML = `<rect width="${W}" height="${H}" fill="#fbfcfd"/>` + mapGrid(T, W, H) +
    sheetToPxSvg(sh, H) + parts.join("");
  $("#mapSvg").setAttribute("font-family", sh.font.css.replace(/"/g, "'"));
}

function mapGrid(T, W, H) {
  const { Ti } = mapT();
  const step = niceStep(110 / MAP.view.ppu);
  const [e0, n0] = Ti(0, 0), [e1, n1] = Ti(W, H);
  let s = "";
  for (let e = Math.ceil(e0 / step) * step; e <= e1; e += step) {
    const x = T([e, 0])[0];
    s += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" class="grid"/><text x="${x + 3}" y="${H - 6}" class="grid-label">E ${+e.toFixed(1)}</text>`;
  }
  for (let n = Math.ceil(n0 / step) * step; n <= n1; n += step) {
    const y = H - T([0, n])[1];
    s += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" class="grid"/><text x="4" y="${y - 3}" class="grid-label">N ${+n.toFixed(1)}</text>`;
  }
  return s;
}

function bindMap(getState) {
  const svg = $("#mapSvg");
  let drag = null;
  const local = (ev) => { const r = svg.getBoundingClientRect(); return [ev.clientX - r.left, r.height - (ev.clientY - r.top)]; };
  svg.addEventListener("pointerdown", (ev) => {
    drag = { start: local(ev), view: { ...MAP.view }, moved: false, target: ev.target };
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const [x, y] = local(ev);
    const dx = x - drag.start[0], dy = y - drag.start[1];
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    MAP.view = { ...drag.view, cx: drag.view.cx - dx / drag.view.ppu, cy: drag.view.cy - dy / drag.view.ppu };
    const { p, sol } = getState();
    renderMap(p, sol);
  });
  svg.addEventListener("pointerup", (ev) => {
    const d = drag;
    drag = null;
    if (!d || d.moved) return;
    const g = d.target.closest && d.target.closest("[data-owner]");
    const owner = g ? g.dataset.owner : null;
    const { Ti } = mapT();
    const [x, y] = local(ev);
    if (MAP.onPick) MAP.onPick(Ti(x, y), owner);
  });
  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const [x, y] = local(ev);
    const { Ti } = mapT();
    const before = Ti(x, y);
    MAP.view.ppu = clamp(MAP.view.ppu * Math.exp(-ev.deltaY * 0.0015), 0.01, 2000);
    const after = mapT().Ti(x, y);
    MAP.view.cx += before[0] - after[0];
    MAP.view.cy += before[1] - after[1];
    const { p, sol } = getState();
    renderMap(p, sol);
  }, { passive: false });
}
