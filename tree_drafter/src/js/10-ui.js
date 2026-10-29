/* =========================================================================
 * UI: documents, the outline editor, settings, live preview, import/export.
 * ========================================================================= */

const STORE_KEY = "treeDrafter.v1";
const DEFAULTS = {
  layout: "flowchart", nodeStyle: "boxes", connector: "elbow", leafLabels: "horizontal", alignLabels: false,
  page: "letter", orient: "landscape", fill: false, font: DEFAULT_FONT, textSize: 10, boxWidth: 1.8,
  hGap: 0.2, vGap: 0.4, lineWeight: 1, title: "", subtitle: "", footnote: "", unit: "",
};
const CHOICES = {
  layout: Object.keys(LAYOUTS), nodeStyle: ["boxes", "labels"], connector: ["elbow", "rounded", "straight"],
  leafLabels: ["horizontal", "vertical"], page: Object.keys(PAGES), orient: ["portrait", "landscape"], font: Object.keys(FONTS),
};
const RANGES = { textSize: [5, 36], boxWidth: [0.4, 6], hGap: [0.02, 2], vGap: [0.05, 3], lineWeight: [0.25, 4] };

const APP = { store: { docs: [], cur: 0 }, doc: null, res: null, zoom: null, tab: "outline", sel: null };

// ------------------------------------------------------------- documents
function normalizeDoc(d = {}) {
  const s = { ...DEFAULTS };
  for (const [k, v] of Object.entries(d.s || {})) {
    if (!(k in DEFAULTS)) continue;
    if (CHOICES[k]) { if (CHOICES[k].includes(v)) s[k] = v; }
    else if (RANGES[k]) { const x = Number(v); if (Number.isFinite(x)) s[k] = clamp(x, ...RANGES[k]); }
    else if (typeof DEFAULTS[k] === "boolean") s[k] = !!v;
    else s[k] = String(v ?? "");
  }
  return { id: d.id || uid("t"), name: String(d.name || "Untitled tree"), text: String(d.text ?? ""), s };
}

const examples = () => JSON.parse($("#examples").textContent);
function newBlank() {
  return normalizeDoc({ name: `Tree ${APP.store.docs.length + 1}`, text: "Start here\n  First branch\n    A leaf\n    Another leaf\n  Second branch\n" });
}

function saveStore() {
  const text = JSON.stringify(APP.store);
  try { localStorage.setItem(STORE_KEY, text); } catch (_) { /* ignore */ }
  hostSave(text);
}
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.docs) && s.docs.length) APP.store = { docs: s.docs.map(normalizeDoc), cur: clamp(s.cur | 0, 0, s.docs.length - 1) };
  } catch (_) { /* ignore */ }
}

function switchDoc(i) {
  APP.store.cur = clamp(i, 0, APP.store.docs.length - 1);
  APP.doc = APP.store.docs[APP.store.cur];
  APP.zoom = null; APP.sel = null;
  $("#outline").value = APP.doc.text;
  $("#docName").value = APP.doc.name;
  renderDocList();
  buildStylePane();
  render();
  saveStore();
}
function addDoc(d) { APP.store.docs.push(d); switchDoc(APP.store.docs.length - 1); }

function renderDocList() {
  $("#docSelect").replaceChildren(...APP.store.docs.map((d, i) => el("option", { value: i, selected: i === APP.store.cur }, d.name || "Untitled")));
}

// ---------------------------------------------------------------- render
let _renderT = null;
function changed() {
  clearTimeout(_renderT);
  _renderT = setTimeout(() => { render(); saveStore(); }, 140);
}

function render() {
  const doc = APP.doc;
  APP.res = renderDoc(doc);
  const { sheet, W, H, info, messages } = APP.res;
  $("#page").innerHTML = sheetToSvg(sheet, W, H, { width: "100%", height: "100%" });
  sizePage();
  markSelection();
  // summary and messages
  const fit = info.scale < 0.999 ? ` · shrunk to ${Math.round(info.scale * 100)}% (${info.textPt.toFixed(1)} pt text)` : "";
  $("#summary").textContent = info.nodes ? `${info.nodes} boxes · ${info.leaves} leaves${fit}` : "Empty";
  const box = $("#messages");
  box.replaceChildren(...messages.map((m) => el("div", {
    class: `msg ${m.lvl}`, onclick: m.line != null ? () => selectLine(m.line) : null,
  }, m.msg)));
  // style pane: what applies to this layout
  for (const [k, show] of Object.entries(applicable(doc.s))) {
    const f = $(`#paneStyle [data-k="${k}"]`);
    if (f) f.closest(".field").classList.toggle("off", !show);
  }
}

/** Which settings matter for the current layout and style. */
function applicable(s) {
  const phylo = s.layout === "phylogram";
  const labels = phylo || s.nodeStyle === "labels";
  return { nodeStyle: !phylo, leafLabels: labels, alignLabels: phylo, unit: phylo, fill: !phylo, vGap: !phylo };
}

function sizePage() {
  if (!APP.res) return;
  const { W, H } = APP.res;
  const wrap = $("#preview");
  const availW = wrap.clientWidth - 36, availH = wrap.clientHeight - 36;
  const fitZ = Math.max(0.1, Math.min(availW / (W * 96), availH / (H * 96)));
  const z = APP.zoom ?? fitZ;
  const page = $("#page");
  page.style.width = `${Math.round(W * 96 * z)}px`;
  page.style.height = `${Math.round(H * 96 * z)}px`;
  $("#zoomLabel").textContent = `${Math.round(z * 100)}%`;
}
function setZoom(z) { APP.zoom = clamp(z, 0.1, 6); sizePage(); }
const currentZoom = () => parseFloat($("#zoomLabel").textContent) / 100 || 1;

// -------------------------------------------------- outline <-> preview
function lineRange(text, line) {
  let start = 0;
  for (let i = 0; i < line; i++) { const j = text.indexOf("\n", start); if (j < 0) return [text.length, text.length]; start = j + 1; }
  const end = text.indexOf("\n", start);
  return [start, end < 0 ? text.length : end];
}

function selectLine(line) {
  if (APP.tab !== "outline") setTab("outline");
  const ta = $("#outline");
  const [a, b] = lineRange(ta.value, line);
  ta.focus();
  ta.setSelectionRange(a, b);
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  const want = line * lh - ta.clientHeight / 3;
  if (want > ta.scrollTop + ta.clientHeight * 0.6 || want < ta.scrollTop - ta.clientHeight * 0.3) ta.scrollTop = Math.max(0, want);
  syncSelectionFromCaret();
}

function syncSelectionFromCaret() {
  const ta = $("#outline");
  const line = ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
  const n = APP.res && APP.res.P.nodes.find((x) => x.line === line);
  APP.sel = n ? n.id : null;
  markSelection();
}
function markSelection() {
  for (const g of $$("#page g.sel")) g.classList.remove("sel");
  if (APP.sel) for (const g of $$(`#page g[data-owner="${APP.sel}"]`)) g.classList.add("sel");
}

// ------------------------------------------------------- outline editing
function replaceRange(ta, a, b, text) {
  ta.focus();
  ta.setSelectionRange(a, b);
  if (!document.execCommand || !document.execCommand("insertText", false, text)) ta.setRangeText(text, a, b, "end");
}

function onOutlineKey(e) {
  const ta = e.target;
  const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
  if (e.key === "Tab") {
    e.preventDefault();
    const ls = v.lastIndexOf("\n", a - 1) + 1;
    let le = v.indexOf("\n", b > a && v[b - 1] === "\n" ? b - 1 : b);
    if (le < 0) le = v.length;
    const lines = v.slice(ls, le).split("\n");
    const out = lines.map((l) => (e.shiftKey ? l.replace(/^( {1,2}|\t)/, "") : "  " + l));
    const delta0 = out[0].length - lines[0].length;
    replaceRange(ta, ls, le, out.join("\n"));
    if (a === b) ta.setSelectionRange(Math.max(ls, a + delta0), Math.max(ls, a + delta0));
    else ta.setSelectionRange(ls, ls + out.join("\n").length);
    onOutlineInput();
  } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const ls = v.lastIndexOf("\n", a - 1) + 1;
    const indent = /^[ \t]*/.exec(v.slice(ls, a))[0];
    if (!indent) return;
    e.preventDefault();
    replaceRange(ta, a, b, "\n" + indent);
    onOutlineInput();
  }
}
function onOutlineInput() {
  APP.doc.text = $("#outline").value;
  changed();
}

// ---------------------------------------------------------- style pane
function buildStylePane() {
  const s = APP.doc.s;
  const opt = (k, labels) => CHOICES[k].map((v) => el("option", { value: v, selected: s[k] === v }, labels[v] || v));
  const sel = (k, label, labels = {}) => field(label, el("select", { "data-k": k, id: `opt-${k}` }, opt(k, labels)));
  const num = (k, label, step) => field(label, el("input", { "data-k": k, id: `opt-${k}`, type: "number", step, min: RANGES[k][0], max: RANGES[k][1], value: s[k] }));
  const txt = (k, label, ph = "") => field(label, el("input", { "data-k": k, id: `opt-${k}`, type: "text", value: s[k], placeholder: ph }));
  const chk = (k, label) => el("label", { class: "field check" }, el("input", { "data-k": k, id: `opt-${k}`, type: "checkbox", checked: !!s[k] }), label);
  const pane = $("#paneStyle");
  pane.replaceChildren(
    el("div", { class: "section" }, "Layout"),
    el("div", { class: "grid2" },
      sel("layout", "Layout", LAYOUTS),
      sel("nodeStyle", "Nodes", { boxes: "Boxes", labels: "Labels only (phylogenetic)" }),
      sel("connector", "Connectors", { elbow: "Square brackets", rounded: "Rounded brackets", straight: "Straight lines" }),
      sel("leafLabels", "Leaf labels", { horizontal: "Horizontal", vertical: "Vertical (many leaves)" }),
      txt("unit", "Branch length unit (scale bar)", "e.g. Myr, substitutions/site"),
      chk("alignLabels", "Align leaf labels at the bottom"),
      chk("fill", "Stretch to fill the page height")),
    el("div", { class: "section" }, "Page"),
    el("div", { class: "grid2" },
      sel("page", "Paper", Object.fromEntries(Object.entries(PAGES).map(([k, v]) => [k, v[2]]))),
      sel("orient", "Orientation", { portrait: "Portrait", landscape: "Landscape" }),
      txt("title", "Title"), txt("subtitle", "Subtitle"),
      txt("footnote", "Footnote (bottom left)", "source, date, author…")),
    el("div", { class: "section" }, "Type and spacing"),
    el("div", { class: "grid2" },
      sel("font", "Font", Object.fromEntries(Object.entries(FONTS).map(([k, f]) => [k, f.label]))),
      num("textSize", "Text size (pt, before fitting)", "0.5"),
      num("boxWidth", "Box / label width limit (in)", "0.1"),
      num("lineWeight", "Line weight (pt)", "0.25"),
      num("hGap", "Gap between neighbours (in)", "0.02"),
      num("vGap", "Gap between levels (in)", "0.05")),
    el("p", { class: "hint" }, "The tree is shrunk to fit the page when needed (never enlarged); the summary above the preview shows the text size it ends up at."),
  );
  for (const inp of $$("[data-k]", pane)) {
    const ev = inp.type === "text" || inp.type === "number" ? "input" : "change";
    inp.addEventListener(ev, () => {
      const k = inp.dataset.k;
      let v = inp.type === "checkbox" ? inp.checked : inp.value;
      if (RANGES[k]) { v = Number(v); if (!Number.isFinite(v)) return; v = clamp(v, ...RANGES[k]); }
      APP.doc.s[k] = v;
      if (k === "page" || k === "orient") APP.zoom = null;
      changed();
    });
  }
}
const field = (label, input) => el("label", { class: "field" }, el("span", {}, label), input);

function setTab(t) {
  APP.tab = t;
  for (const b of $$(".tabs button")) b.classList.toggle("active", b.dataset.tab === t);
  $("#paneOutline").hidden = t !== "outline";
  $("#paneStyle").hidden = t !== "style";
}

// ------------------------------------------------------- import / export
function fileName(ext) { return `${(APP.doc.name || "tree").replace(/[^A-Za-z0-9_-]+/g, "_")}.${ext}`; }

/** A new document from Newick text: a phylogram if it has branch lengths, else a cladogram. */
function docFromNewick(text, name) {
  const trees = parseNewick(text);
  const hasLen = /:\s*[+-]?[\d.]/.test(text);
  return normalizeDoc({ name, text: treesToOutline(trees),
    s: { layout: hasLen ? "phylogram" : "cladogram", nodeStyle: "labels", orient: "landscape" } });
}

async function importFile(f) {
  const text = await f.text();
  const base = f.name.replace(/\.[^.]+$/, "");
  try {
    if (/\.json$/i.test(f.name) || /^\s*[[{]/.test(text)) {
      const d = JSON.parse(text);
      const list = Array.isArray(d) ? d : Array.isArray(d.docs) ? d.docs : [d];
      list.forEach((x) => APP.store.docs.push(normalizeDoc({ ...x, id: null })));
      switchDoc(APP.store.docs.length - 1);
    } else if (/\.(nwk|newick|tre|tree)$/i.test(f.name) || /^\s*\(/.test(text)) {
      addDoc(docFromNewick(text, base));
    } else {
      addDoc(normalizeDoc({ name: base, text }));
    }
  } catch (err) {
    uiAlert(`Couldn't read ${f.name}: ${err.message}`);
  }
}

async function pasteNewick() {
  const t = await uiPrompt("Paste a Newick tree, e.g. ((A:0.1,B:0.2):0.05,C:0.3);", "", { okText: "Make tree", title: "Newick" });
  if (t === null || !t.trim()) return;
  try { addDoc(docFromNewick(t, "Newick tree")); } catch (err) { uiAlert(`That isn't valid Newick: ${err.message}.`); }
}

function exportSvg() {
  const { sheet, W, H } = APP.res;
  saveFile(fileName("svg"), sheetToSvg(sheet, W, H, { fonts: fontFaceCss(sheet.font) }));
}
async function exportPng() {
  const { sheet, W, H } = APP.res;
  try { saveFile(fileName("png"), await sheetToPng(sheet, W, H, 200)); } catch (err) { uiAlert(err.message); }
}
function exportDxf() { const { sheet, W, H } = APP.res; saveFile(fileName("dxf"), sheetToDxf(sheet, W, H)); }
function exportNewick() {
  if (!APP.res.P.roots.length) { uiAlert("The outline is empty."); return; }
  saveFile(fileName("nwk"), toNewick(APP.res.P.roots));
}
function printSheet() {
  const { sheet, W, H } = APP.res;
  $("#printSheet").innerHTML = sheetToSvg(sheet, W, H);
  $("#pageCss").textContent = `@page { size: ${W}in ${H}in; margin: 0; } #printSheet svg { width: ${W}in; height: ${H}in; }`;
  const prev = document.title;
  document.title = fileName("pdf").replace(/\.pdf$/, "");
  window.print();
  document.title = prev;
}

// ------------------------------------------------------------------ wiring
function bindUi() {
  for (const b of $$(".tabs button")) b.addEventListener("click", () => setTab(b.dataset.tab));
  $("#docSelect").addEventListener("change", (e) => switchDoc(+e.target.value));
  $("#docName").addEventListener("input", (e) => { APP.doc.name = e.target.value; renderDocList(); changed(); });
  const ta = $("#outline");
  ta.addEventListener("input", onOutlineInput);
  ta.addEventListener("keydown", onOutlineKey);
  for (const ev of ["click", "keyup", "focus"]) ta.addEventListener(ev, syncSelectionFromCaret);

  for (const m of $$(".menu")) {
    m.querySelector("button").addEventListener("click", (e) => { e.stopPropagation(); for (const o of $$(".menu.open")) if (o !== m) o.classList.remove("open"); m.classList.toggle("open"); });
  }
  document.addEventListener("click", () => { for (const o of $$(".menu.open")) o.classList.remove("open"); });
  $("#btnBlank").addEventListener("click", () => addDoc(newBlank()));
  $("#exampleList").replaceChildren(...Object.values(examples()).map((ex) =>
    el("button", { onclick: () => addDoc(normalizeDoc(clone(ex))) }, ex.name)));
  $("#btnDup").addEventListener("click", () => { const d = normalizeDoc(clone(APP.doc)); d.id = uid("t"); d.name += " (copy)"; addDoc(d); });
  $("#btnDel").addEventListener("click", async () => {
    if (!await uiConfirm(`Delete "${APP.doc.name}"? This can't be undone.`, { okText: "Delete", danger: true })) return;
    APP.store.docs.splice(APP.store.cur, 1);
    if (!APP.store.docs.length) APP.store.docs.push(newBlank());
    switchDoc(Math.min(APP.store.cur, APP.store.docs.length - 1));
  });
  $("#btnImport").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); });
  $("#btnNewick").addEventListener("click", pasteNewick);
  $("#btnSaveJson").addEventListener("click", () => saveFile(fileName("json"), JSON.stringify(APP.doc, null, 1)));
  $("#btnSvg").addEventListener("click", exportSvg);
  $("#btnPng").addEventListener("click", exportPng);
  $("#btnDxf").addEventListener("click", exportDxf);
  $("#btnNwk").addEventListener("click", exportNewick);
  if (HOSTED) {
    // a hosted page can't print: the main button saves a PNG instead
    $("#btnPrint").textContent = "Save PNG";
    $("#btnPrint").title = "The page as a 200 dpi PNG (Export has SVG and DXF)";
    $("#btnPrint").addEventListener("click", exportPng);
  } else $("#btnPrint").addEventListener("click", printSheet);

  $("#zoomIn").addEventListener("click", () => setZoom(currentZoom() * 1.25));
  $("#zoomOut").addEventListener("click", () => setZoom(currentZoom() / 1.25));
  $("#zoomFit").addEventListener("click", () => { APP.zoom = null; sizePage(); });
  $("#page").addEventListener("click", (e) => {
    const g = e.target.closest("[data-owner]");
    const n = g && APP.res.P.nodes.find((x) => x.id === g.dataset.owner);
    if (n) selectLine(n.line);
  });
  window.addEventListener("resize", sizePage);
}

(async function init() {
  try { await loadEmbeddedFonts(); } catch (e) { console.error("font load failed", e); }
  loadStore();
  if (!APP.store.docs.length) {
    APP.store.docs = Object.values(examples()).map((ex) => normalizeDoc(clone(ex)));
    APP.store.cur = 0;
  }
  bindUi();
  switchDoc(APP.store.cur);
  connectHost((s) => {
    // trees saved in the account replace this browser's copy
    if (!s || !Array.isArray(s.docs) || !s.docs.length) return;
    APP.store = { docs: s.docs.map(normalizeDoc), cur: clamp(s.cur | 0, 0, s.docs.length - 1) };
    switchDoc(APP.store.cur);
  });
  window.TD = { APP, parseOutline, parseNewick, treesToOutline, toNewick, layoutTree, renderDoc, sheetToSvg, sheetToDxf, sheetToPng,
                normalizeDoc, examples, effective, PAGES, HOST, makeZip };
})();
