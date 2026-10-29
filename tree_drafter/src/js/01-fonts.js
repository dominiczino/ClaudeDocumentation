/* =========================================================================
 * Fonts: embedded B612 / Jost, or the system's Arial / Times. Text heights
 * are cap heights in inches; a font size in points is pt / 72 * cap.
 * ========================================================================= */

const FONTS = {
  b612: { label: "B612", css: "'TD B612', sans-serif", cap: 0.760, files: ["B612-Regular.ttf", "B612-Bold.ttf"] },
  jost: { label: "Jost (Futura-style)", css: "'TD Jost', sans-serif", cap: 0.700, files: ["Jost-Regular.ttf", "Jost-Bold.ttf"] },
  arial: { label: "Arial / Helvetica", css: "Arial, 'Liberation Sans', Helvetica, sans-serif", cap: 0.716, files: ["arial.ttf", "arialbd.ttf"] },
  times: { label: "Times (serif)", css: "'Times New Roman', 'Liberation Serif', Times, serif", cap: 0.662, files: ["times.ttf", "timesbd.ttf"] },
};
const DEFAULT_FONT = "b612";
const LINE_SPACING = 1.55;   // baseline pitch / cap height

/** Register the embedded TTFs with the page (preview, export and measurement). */
function loadEmbeddedFonts() {
  const data = JSON.parse(document.getElementById("font-data").textContent);
  const faces = [];
  for (const font of Object.values(FONTS)) {
    const family = font.css.match(/^'([^']+)'/);
    if (!family || !font.files.every((f) => data[f])) continue;
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

/** Width of `s` at cap height 1. Italic is drawn as a slant, so it measures like upright text. */
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

/** Text width in inches for cap height h (a little slack for CAD font differences). */
const textWidth = (s, h, bold, font) => unitWidth(String(s), bold, font) * h * 1.03;

/** Greedy word wrap to width w. Explicit newlines are kept. */
function wrapText(s, w, h, bold, font) {
  const lines = [];
  for (const para of String(s).split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const trial = cur ? cur + " " + word : word;
      if (!cur || textWidth(trial, h, bold, font) <= w) cur = trial;
      else { lines.push(cur); cur = word; }
    }
    lines.push(cur);
  }
  return lines;
}
