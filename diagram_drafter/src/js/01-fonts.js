/* =========================================================================
 * Fonts: embedded B612 / Jost, or system Arial. Text heights are cap heights.
 * ========================================================================= */

const FONTS = {
  b612: { label: "B612", css: "'DD B612', sans-serif", cap: 0.760,
          files: ["B612-Regular.ttf", "B612-Bold.ttf"], subst: {} },
  jost: { label: "Jost (Futura-style)", css: "'DD Jost', sans-serif", cap: 0.700,
          files: ["Jost-Regular.ttf", "Jost-Bold.ttf"], subst: { "Φ": "PH" } },
  arial: { label: "Arial", css: "Arial, 'Liberation Sans', Helvetica, sans-serif", cap: 0.716,
           files: ["arial.ttf", "arialbd.ttf"], subst: {} },
};
const DEFAULT_FONT = "b612";

/** Register the embedded TTFs with the page (preview, print and measurement). */
function loadEmbeddedFonts() {
  const data = JSON.parse(document.getElementById("font-data").textContent);
  const faces = [];
  for (const font of Object.values(FONTS)) {
    const family = font.css.match(/^'([^']+)'/);
    if (!family) continue;
    font.files.forEach((file, i) => {
      const bytes = Uint8Array.from(atob(data[file]), (c) => c.charCodeAt(0));
      const face = new FontFace(family[1], bytes.buffer, { weight: i ? "700" : "400" });
      document.fonts.add(face);
      faces.push(face.load());
    });
  }
  return Promise.all(faces);
}

function fontFileBlob(file) {
  const data = JSON.parse(document.getElementById("font-data").textContent);
  return new Blob([Uint8Array.from(atob(data[file]), (c) => c.charCodeAt(0))], { type: "font/ttf" });
}

let _measureCtx = null;
const _widthCache = new Map();

/** Width of `s` at cap height 1 in the given font. */
function unitWidth(s, bold, font) {
  const key = font.label + (bold ? "\u0001" : "\u0000") + s;
  let w = _widthCache.get(key);
  if (w === undefined) {
    if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
    _measureCtx.font = `${bold ? "bold " : ""}100px ${font.css}`;
    w = _measureCtx.measureText(s).width / 100 / font.cap;
    _widthCache.set(key, w);
  }
  return w;
}

function applySubst(s, font) {
  s = String(s);
  for (const [from, to] of Object.entries(font.subst)) s = s.split(from).join(to);
  return s;
}

/** Text measurement in sheet inches (with a little slack for CAD font differences). */
const textWidth = (s, h, bold, font) => unitWidth(applySubst(s, font), bold, font) * h * 1.04;
