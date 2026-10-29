/* =========================================================================
 * Output: Sheet -> SVG (screen, print, PNG) and DXF (R2013, inches, 1:1).
 * ========================================================================= */

// name: [ACI colour, lineweight (1/100 mm), dashed]. Must match tools/make_dxf_template.py.
const LAYERS = {
  "PAGE": [8, 13], "TITLE": [7, 35], "TEXT": [7, 25], "TEXT-MINOR": [8, 18], "LABEL": [7, 18],
  "NODE": [7, 35], "NODE-FILL": [7, 0], "BRANCH": [7, 35], "BRANCH-DASHED": [7, 35, true],
  "LEADER": [8, 13, true], "SCALE": [7, 25],
};
const n4 = (v) => +v.toFixed(4);

function svgPathD(pts, closed, Y) {
  let d = `M${n4(pts[0][0])} ${Y(pts[0][1])}`;
  const n = pts.length, segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const [xa, ya, bulge] = pts[i], [xb, yb] = pts[(i + 1) % n];
    if (Math.abs(bulge || 0) < 1e-9) { d += `L${n4(xb)} ${Y(yb)}`; continue; }
    const theta = 4 * Math.atan(Math.abs(bulge));
    const chord = Math.hypot(xb - xa, yb - ya);
    if (chord < 1e-9) continue;
    const r = chord / (2 * Math.sin(theta / 2));
    // DXF positive bulge = counter-clockwise (y up) -> SVG sweep-flag 0 after the y flip
    d += `A${n4(r)} ${n4(r)} 0 ${theta > Math.PI ? 1 : 0} ${bulge > 0 ? 0 : 1} ${n4(xb)} ${Y(yb)}`;
  }
  return closed ? d + "Z" : d;
}

/**
 * SVG for a sheet W x H inches. opts: {width, height (CSS sizes), fonts (embed
 * @font-face CSS), background}. Entities are grouped per owner (data-owner).
 */
function sheetToSvg(sh, W, H, { width = `${W}in`, height = `${H}in`, fonts = "", background = "#fff" } = {}) {
  const Y = (y) => n4(H - y);
  const groups = new Map();
  const add = (o, s) => { if (!groups.has(o)) groups.set(o, []); groups.get(o).push(s); };
  const stroke = (e) => {
    const lw = (e.lw ?? (LAYERS[e.layer] || [7, 25])[1] / 100 / 0.3528) / 72;
    const col = e.color || "#000";
    const dash = e.dash === "dashed" ? ` stroke-dasharray="${n4(lw * 6)} ${n4(lw * 4)}"` : e.dash === "dotted" ? ` stroke-dasharray="0 ${n4(lw * 3.5)}"` : "";
    return `stroke="${col}" stroke-width="${n4(lw)}"${dash}`;
  };
  for (const e of sh.ents) {
    if (e.t === "line") add(e.owner, `<line x1="${n4(e.x0)}" y1="${Y(e.y0)}" x2="${n4(e.x1)}" y2="${Y(e.y1)}" ${stroke(e)}/>`);
    else if (e.t === "poly") add(e.owner, `<path d="${svgPathD(e.pts, e.closed, Y)}" fill="none" ${stroke(e)}/>`);
    else if (e.t === "fill") add(e.owner, `<path d="${svgPathD(e.pts, true, Y)}" fill="${e.color || "#000"}"${e.opacity != null && e.opacity < 1 ? ` fill-opacity="${e.opacity}"` : ""} stroke="none"/>`);
    else if (e.t === "text") {
      const [v, hz] = e.align;
      const fs = e.h / sh.font.cap;
      const dy = v === "M" ? e.h / 2 : v === "T" ? e.h : 0;   // baseline below the anchor, in the text's own frame
      const anchor = hz === "L" ? "start" : hz === "R" ? "end" : "middle";
      const col = e.color || (e.layer === "TEXT-MINOR" ? "#4b5260" : "#000");
      const attrs = `font-size="${n4(fs)}" text-anchor="${anchor}"${e.bold ? ' font-weight="bold"' : ""}${e.italic ? ' font-style="italic"' : ""} fill="${col}"` +
        (e.halo ? ` stroke="#fff" stroke-width="${n4(e.h * 0.55)}" stroke-linejoin="round" paint-order="stroke"` : "");
      const body = esc(e.s);
      if (e.rot) add(e.owner, `<g transform="translate(${n4(e.x)} ${Y(e.y)}) rotate(${-e.rot})"><text x="0" y="${n4(dy)}" ${attrs}>${body}</text></g>`);
      else add(e.owner, `<text x="${n4(e.x)}" y="${n4(H - e.y + dy)}" ${attrs}>${body}</text>`);
    }
  }
  let out = "";
  for (const [o, items] of groups) out += `<g data-owner="${esc(o)}">${items.join("")}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n4(W)} ${n4(H)}" width="${width}" height="${height}" ` +
    `font-family="${sh.font.css.replace(/"/g, "'")}" stroke-linecap="round" stroke-linejoin="round">` +
    (fonts ? `<style>${fonts}</style>` : "") +
    (background ? `<rect width="${n4(W)}" height="${n4(H)}" fill="${background}"/>` : "") + out + `</svg>`;
}

/** PNG of the sheet at `dpi`, as a Blob. */
async function sheetToPng(sh, W, H, dpi = 200) {
  const svg = sheetToSvg(sh, W, H, { width: `${Math.round(W * dpi)}`, height: `${Math.round(H * dpi)}`, fonts: fontFaceCss(sh.font) });
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("The drawing couldn't be rendered to an image.")); img.src = url; });
    const cv = document.createElement("canvas");
    cv.width = Math.round(W * dpi); cv.height = Math.round(H * dpi);
    const g = cv.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0, cv.width, cv.height);
    return await new Promise((res) => cv.toBlob(res, "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------- DXF
const LWEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

/**
 * DXF: the entities spliced into the embedded R2013 template (layers, text
 * styles, linetypes; see tools/make_dxf_template.py). Inches, page at 1:1,
 * with the page outline on the non-plotting PAGE layer.
 */
function sheetToDxf(sh, W, H) {
  const tpl = JSON.parse(document.getElementById("dxf-template").textContent);
  let handle = parseInt(tpl.seed, 16);
  const out = [];
  const tag = (code, value) => out.push(String(code).padStart(3, " "), String(value));
  const num = (v) => { let s = String(+v.toFixed(6)); if (s === "-0") s = "0"; return s.includes(".") || s.includes("e") ? s : s + ".0"; };
  const head = (type, e, sub) => {
    tag(0, type); tag(5, (handle++).toString(16).toUpperCase()); tag(330, tpl.owner);
    tag(100, "AcDbEntity"); tag(8, e.layer || "TEXT");
    if (e.lw != null) {
      const mm100 = e.lw * 35.28;
      tag(370, LWEIGHTS.reduce((a, b) => (Math.abs(b - mm100) < Math.abs(a - mm100) ? b : a)));
    }
    if (e.color && !/^#0{6}$/.test(e.color)) tag(420, parseInt(e.color.slice(1), 16));
    tag(100, sub);
  };
  const ALIGN_H = { L: 0, C: 1, R: 2 }, ALIGN_V = { B: 1, M: 2, T: 3 };
  const ents = [{ t: "poly", layer: "PAGE", pts: [[0, 0, 0], [W, 0, 0], [W, H, 0], [0, H, 0]], closed: true }, ...sh.ents];
  for (const e of ents) {
    if (e.t === "line") {
      head("LINE", e, "AcDbLine");
      tag(10, num(e.x0)); tag(20, num(e.y0)); tag(30, "0.0");
      tag(11, num(e.x1)); tag(21, num(e.y1)); tag(31, "0.0");
    } else if (e.t === "poly") {
      head("LWPOLYLINE", e, "AcDbPolyline");
      tag(90, e.pts.length); tag(70, e.closed ? 1 : 0);
      for (const [x, y, b] of e.pts) { tag(10, num(x)); tag(20, num(y)); if (b) tag(42, num(b)); }
    } else if (e.t === "fill") {
      if (e.opacity != null && e.opacity < 1) continue;      // tints are for the screen and print only
      if (/^#f{6}$/i.test(e.color || "")) continue;          // white backing
      const bulges = e.pts.some((p) => p[2]);
      head("HATCH", e, "AcDbHatch");
      tag(10, "0.0"); tag(20, "0.0"); tag(30, "0.0"); tag(210, "0.0"); tag(220, "0.0"); tag(230, "1.0");
      tag(2, "SOLID"); tag(70, 1); tag(71, 0);
      tag(91, 1); tag(92, 3); tag(72, bulges ? 1 : 0); tag(73, 1); tag(93, e.pts.length);
      for (const [x, y, b] of e.pts) { tag(10, num(x)); tag(20, num(y)); if (bulges) tag(42, num(b || 0)); }
      tag(97, 0); tag(75, 1); tag(76, 1); tag(98, 0);
    } else if (e.t === "text") {
      head("TEXT", e, "AcDbText");
      tag(10, num(e.x)); tag(20, num(e.y)); tag(30, "0.0"); tag(40, num(e.h));
      tag(1, e.s.replace(/%%/g, "%%%"));
      if (e.rot) tag(50, num(((e.rot % 360) + 360) % 360));
      if (e.italic) tag(51, "15.0");
      tag(7, e.bold ? "TD-BOLD" : "TD-STD");
      const hz = ALIGN_H[e.align[1]];
      if (hz) tag(72, hz);
      tag(11, num(e.x)); tag(21, num(e.y)); tag(31, "0.0");
      tag(100, "AcDbText"); tag(73, ALIGN_V[e.align[0]]);
    }
  }
  const [reg, bold] = sh.font.files;
  return tpl.dxf
    .replace("\n  3\narial.ttf\n", () => `\n  3\n${reg}\n`)
    .replace("\n  3\narialbd.ttf\n", () => `\n  3\n${bold}\n`)
    .replace("%%ENTITIES%%", () => (out.length ? out.join("\n") + "\n" : ""))
    .replace("%%HANDSEED%%", () => handle.toString(16).toUpperCase());
}
