/* =========================================================================
 * UI panels: palette, drawing list, properties, layout check, file/export.
 * ========================================================================= */

// ---------------------------------------------------------------- palette
const paletteEntries = () => PALETTE[libOf(ED.doc)];
const _previewCache = new Map();

function paletteSvg(entry) {
  const key = entry.sym + JSON.stringify(entry.props) + ED.doc.font;
  if (_previewCache.has(key)) return _previewCache.get(key);
  const sym = SYMBOLS[entry.sym];
  const n = { id: "pv", sym: entry.sym, x: 0, y: 0, rot: 0, flip: false, tag: "", text: "",
              props: Object.assign(defaultProps(entry.sym), entry.props || {}), labelPos: "none",
              ...(sym.bus ? { len: 1.0 } : {}) };
  const doc = { ...ED.doc, symScale: 1 };
  const sh = new Sheet(docFont(doc));
  sym.draw(new SymCtx(sh, 0, 0, 0, false, 1), n, doc);
  const g = computeGeom(doc, n, new Set());
  const b = R.inflate(g.body, 0.06);
  const w = Math.max(R.w(b), 0.5), h = Math.max(R.h(b), 0.3);
  const cx = R.cx(b), cy = SHEET_H - R.cy(b);
  const svg = `<svg viewBox="${cx - w / 2} ${cy - h / 2} ${w} ${h}" preserveAspectRatio="xMidYMid meet" font-family="${sh.font.css.replace(/"/g, "'")}">` +
              `${sheetToSvgContent(sh, { minStroke: 0.012 })}</svg>`;
  _previewCache.set(key, svg);
  return svg;
}

function renderPalette() {
  const list = $("#paletteList");
  const q = $("#paletteSearch").value.trim().toLowerCase();
  const entries = paletteEntries();
  const cats = [];
  entries.forEach((en, i) => {
    if (q && !(`${en.name} ${en.cat} ${SYMBOLS[en.sym].name}`.toLowerCase().includes(q))) return;
    let c = cats.find((x) => x.cat === en.cat);
    if (!c) cats.push(c = { cat: en.cat, items: [] });
    c.items.push([en, i]);
  });
  list.replaceChildren(...cats.flatMap(({ cat, items }) => [
    el("div", { class: "pal-cat" }, cat),
    el("div", { class: "pal-grid" }, items.map(([en, i]) => {
      const item = el("div", { class: "pal-item", draggable: "true", title: en.name });
      item.innerHTML = paletteSvg(en);
      item.append(el("span", {}, en.name));
      item.addEventListener("click", (ev) => onPaletteClick(en, item, ev));
      item.addEventListener("dragstart", (ev) => { ev.dataTransfer.setData("text/x-palette", String(i)); });
      return item;
    })),
  ]));
}

function onPaletteClick(entry, item, ev) {
  if (!ev.shiftKey && ED.sel.size === 1 && addConnected(entry)) return;
  if (ED.place && ED.place.sym === entry.sym && ED.place.name === entry.name) { cancelPlace(); return; }
  $$(".pal-item.active").forEach((x) => x.classList.remove("active"));
  item.classList.add("active");
  ED.place = { ...entry };
  svgEl().classList.add("placing");
  setStatus(`Click on the sheet to place ${entry.name} (drop it on a line to insert it). Shift-click places several; Esc cancels.`);
}

// ------------------------------------------------------------- doc list
function renderDocList() {
  const sel = $("#docSelect");
  sel.replaceChildren(...ED.store.docs.map((d, i) =>
    el("option", { value: i, selected: i === ED.store.cur }, `${d.name}  (${d.type === "pid" ? "P&ID" : "one-line"})`)));
}

function addDoc(doc) {
  ED.store.docs.push(doc);
  switchDoc(ED.store.docs.length - 1);
}

function examples() { return JSON.parse($("#examples").textContent); }

function loadExample(key) {
  const doc = normalizeDoc(clone(examples()[key]));
  doc.id = uid("d");
  autoArrange(doc);
  addDoc(doc);
  setStatus(`Loaded example "${doc.name}"`);
}

// ------------------------------------------------------------ properties
function field(label, input) { return el("label", { class: "field" }, el("span", {}, label), input); }

function textInput(value, onInput, attrs = {}) {
  const i = el("input", { type: "text", value: value ?? "", ...attrs });
  i.addEventListener("input", () => { onInput(i.value); scheduleRender(); });
  i.addEventListener("change", () => commit());
  return i;
}
function textArea(value, onInput, rows = 3, attrs = {}) {
  const t = el("textarea", { rows, ...attrs });
  t.value = value ?? "";
  t.addEventListener("input", () => { onInput(t.value); scheduleRender(); });
  t.addEventListener("change", () => commit());
  return t;
}
function selectInput(value, options, onChange) {
  const s = el("select", {}, options.map(([v, t]) => el("option", { value: v, selected: String(v) === String(value) }, t)));
  s.addEventListener("change", () => { onChange(s.value); commit(); render(); renderProps(); });
  return s;
}
function button(text, onClick, cls = "") { return el("button", { class: cls, onclick: onClick }, text); }

/** Reroute the connections of these nodes after a property change that moves ports. */
function rerouteAround(ids) {
  fitBuses(ED.doc, new Set(ids));
  routeEdges(ED.doc, incidentEdges(new Set(ids)));
}

function renderProps() {
  const box = $("#props");
  const nodes = selNodes(), edges = selEdges();
  if (nodes.length === 1 && !edges.length) return box.replaceChildren(...nodeProps(nodes[0]));
  if (edges.length === 1 && !nodes.length) return box.replaceChildren(...edgeProps(edges[0]));
  if (nodes.length + edges.length > 1) return box.replaceChildren(...multiProps(nodes, edges));
  box.replaceChildren(...docProps());
}

function nodeProps(n) {
  const sym = SYMBOLS[n.sym];
  const out = [el("h3", {}, sym.name), el("div", { class: "sub" }, n.tag || "untagged")];
  const geomChange = () => { rerouteAround([n.id]); };
  const tag = textInput(n.tag, (v) => { n.tag = v; geomChange(); }, { placeholder: sym.tag ? `${sym.tag}-1` : "" });
  const tagRow = el("div", { class: "row" }, tag);
  if (sym.tag) tagRow.append(el("button", { style: "flex:none", title: "Next free number", onclick: () => {
    n.tag = nextTag(ED.doc, sym.tag); commit(); render(); renderProps();
  } }, "Auto"));
  out.push(field("Tag", tagRow));
  for (const p of sym.props) {
    const cur = n.props[p.k] ?? "";
    const input = p.type === "select"
      ? selectInput(cur, p.options.map((o) => [o, o || "—"]), (v) => { n.props[p.k] = v; geomChange(); })
      : textInput(cur, (v) => { n.props[p.k] = v; geomChange(); });
    out.push(field(p.label, input));
  }
  out.push(field("Additional text (one line each)", textArea(n.text, (v) => { n.text = v; geomChange(); }, 2)));
  out.push(field("Label position", selectInput(n.labelPos, [["auto", "Automatic"], ["right", "Right"], ["left", "Left"],
    ["above", "Above"], ["below", "Below"], ["none", "Hidden"], ...(sym.bus ? [["end", "At end"]] : [])],
    (v) => { n.labelPos = v; geomChange(); })));
  if (sym.bus) {
    const auto = el("input", { type: "checkbox", checked: n.autoLen !== false });
    auto.addEventListener("change", () => { n.autoLen = auto.checked; rerouteAround([n.id]); commit(); render(); renderProps(); });
    out.push(el("label", { class: "check" }, auto, "Length follows its connections"));
    if (n.autoLen === false) {
      out.push(field("Length (in)", textInput(n.len ?? sym.defLen, (v) => { const x = parseFloat(v); if (x > 0.2) { n.len = x; geomChange(); } })));
    }
  }
  out.push(el("div", { class: "section" }, "Arrange"));
  out.push(el("div", { class: "btnrow" },
    button("⟲ Rotate", () => rotateSelection(90)), button("⟳", () => rotateSelection(-90)),
    button("Mirror", () => flipSelection()), button("Delete", () => deleteSelection(), "danger")));
  out.push(el("p", { class: "note" }, "Drag a port (circle) to another symbol to connect. Click a palette symbol now to add it connected after this one."));
  return out;
}

function edgeProps(e) {
  const lib = libOf(ED.doc);
  const styles = Object.entries(EDGE_STYLES).sort((a, b) => (a[1].lib === lib ? 0 : 1) - (b[1].lib === lib ? 0 : 1));
  const from = nodeById(e.from.n), to = nodeById(e.to.n);
  const nm = (n) => n.tag || SYMBOLS[n.sym].name;
  const out = [el("h3", {}, "Connection"), el("div", { class: "sub" }, `${nm(from)} → ${nm(to)}`)];
  out.push(field("Line type", selectInput(e.style, styles.map(([k, v]) => [k, v.name]), (v) => { e.style = v; })));
  out.push(field(lib === "pid" ? "Line label (size, service, number)" : "Conductor / raceway label",
    textArea(e.label, (v) => { e.label = v; }, 2, { placeholder: lib === "pid" ? '3/4" CW' : "(3) #6 CU + #10 G, 1\" PVC" })));
  out.push(field("Flow arrow", selectInput(e.arrow, [["none", "None"], ["mid", "Mid-line"], ["end", "At end"]], (v) => { e.arrow = v; })));
  out.push(el("div", { class: "btnrow" },
    button("Reverse direction", () => {
      [e.from, e.to] = [e.to, e.from];
      if (e.pts) e.pts = [...e.pts].reverse();
      commit("Reversed"); render(); renderProps();
    }),
    button("Re-route", () => { routeEdges(ED.doc, new Set([e.id])); commit("Re-routed"); render(); }),
    button("Delete", () => deleteSelection(), "danger")));
  out.push(el("p", { class: "note" }, "Click a palette symbol now to insert it into this line."));
  return out;
}

function multiProps(nodes, edges) {
  const out = [el("h3", {}, `${nodes.length + edges.length} selected`),
    el("div", { class: "sub" }, `${nodes.length} symbol(s), ${edges.length} connection(s)`)];
  if (nodes.length > 1) {
    out.push(el("div", { class: "section" }, "Align"));
    out.push(el("div", { class: "btnrow" },
      button("Left", () => alignSelection("left")), button("Centre", () => alignSelection("hcenter")),
      button("Right", () => alignSelection("right"))));
    out.push(el("div", { class: "btnrow" },
      button("Top", () => alignSelection("top")), button("Middle", () => alignSelection("vcenter")),
      button("Bottom", () => alignSelection("bottom"))));
    out.push(el("div", { class: "btnrow" },
      button("Distribute ↔", () => alignSelection("hdist")), button("Distribute ↕", () => alignSelection("vdist"))));
  }
  if (edges.length) {
    out.push(el("div", { class: "section" }, "Connections"));
    const lib = libOf(ED.doc);
    out.push(field("Set line type", selectInput("", [["", "—"], ...Object.entries(EDGE_STYLES).filter(([, v]) => v.lib === lib).map(([k, v]) => [k, v.name])],
      (v) => { if (v) for (const e of edges) e.style = v; })));
  }
  out.push(el("div", { class: "btnrow" },
    button("⟲ Rotate", () => rotateSelection(90)), button("Mirror", () => flipSelection()),
    button("Delete", () => deleteSelection(), "danger")));
  return out;
}

function docProps() {
  const d = ED.doc, tb = d.titleblock;
  const out = [el("h3", {}, "Drawing"), el("div", { class: "sub" }, d.type === "pid" ? "Piping & instrumentation diagram" : "One-line diagram")];
  out.push(field("Name", textInput(d.name, (v) => { d.name = v; renderDocList(); })));
  out.push(field("Flow direction", selectInput(d.flow, [["down", "Top to bottom"], ["right", "Left to right"]],
    (v) => { d.flow = v; setStatus("Flow changed — press Auto-arrange to re-lay the drawing."); })));
  out.push(field("Spacing", selectInput(d.spacing, [["compact", "Compact"], ["normal", "Normal"], ["airy", "Airy"]],
    (v) => { d.spacing = v; routeEdges(d); })));
  out.push(field("Symbol size", selectInput(String(d.symScale), [...new Set([0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.25, d.symScale])]
    .sort((a, b) => a - b).map((v) => [String(v), `${Math.round(v * 100)}%`]), (v) => { d.symScale = +v; routeEdges(d); })));
  out.push(field("Line crossings", selectInput(d.crossing, [["hop", "Hop (arc)"], ["gap", "Break the lighter line"], ["none", "Plain"]],
    (v) => { d.crossing = v; })));
  out.push(field("Font", selectInput(d.font, Object.entries(FONTS).map(([k, f]) => [k, f.label]), (v) => {
    d.font = v; _previewCache.clear(); renderPalette(); routeEdges(d);
  })));
  const fnote = el("p", { class: "note font-note" });
  const font = docFont(d);
  if (font === FONTS.arial) fnote.append("Arial comes with Windows and macOS.");
  else {
    const links = font.files.map((f) => { const a = el("a", { href: "#" }, f); a.onclick = (e) => { e.preventDefault(); downloadBlob(fontFileBlob(f), f); }; return a; });
    fnote.append("For the DXF to look right in CAD, install ", links[0], " and ", links[1], " (SIL Open Font License).");
  }
  out.push(fnote);
  const up = el("input", { type: "checkbox", checked: d.uppercase });
  up.addEventListener("change", () => { d.uppercase = up.checked; routeEdges(d); commit(); render(); });
  out.push(el("label", { class: "check" }, up, "Labels in capitals"));

  out.push(el("div", { class: "section" }, "Title block"));
  const tbf = [["project", "Project / property"], ["title", "Drawing title (blank = automatic)"], ["drawn_by", "Drawn by"],
    ["date", "Date"], ["dwg_no", "Drawing number"], ["rev", "Revision"], ["sheet", "Sheet"], ["scale", "Scale"]];
  for (const [k, label] of tbf) out.push(field(label, textInput(tb[k], (v) => { tb[k] = v; })));
  out.push(el("div", { class: "section" }, "Notes"));
  out.push(textArea(d.notes.join("\n"), (v) => { d.notes = v.split("\n").map((x) => x.trim()).filter(Boolean); }, 5,
    { placeholder: "One note per line" }));
  out.push(el("div", { class: "section" }, "Shortcuts"));
  const kb = el("div", { class: "kbd" });
  kb.innerHTML = "<b>A</b> auto-arrange · <b>R</b> rotate · <b>F</b> mirror · <b>Del</b> delete<br>" +
    "<b>Ctrl+Z / Ctrl+Shift+Z</b> undo / redo · <b>Ctrl+C / V / D</b> copy, paste, duplicate<br>" +
    "<b>Arrows</b> nudge (Shift ×4) · <b>Ctrl+wheel</b> zoom · <b>wheel</b> or <b>Space+drag</b> pan · <b>0</b> fit";
  out.push(kb);
  return out;
}

// ----------------------------------------------------------- layout check
function checkLayout(doc) {
  const issues = [];
  const geoms = allGeoms(doc);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const nodeById = (id) => byId.get(id);
  const name = (n) => (n ? n.tag || SYMBOLS[n.sym].name : "?");
  const ns = doc.nodes;
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      const a = geoms.get(ns[i].id), b = geoms.get(ns[j].id);
      if (R.overlaps(a.outer, b.outer)) issues.push({ lvl: "error", msg: `${name(ns[i])} and ${name(ns[j])} overlap.`, ids: [ns[i].id, ns[j].id] });
      else if (R.overlaps(a.keep, b.keep)) issues.push({ lvl: "warn", msg: `${name(ns[i])} and ${name(ns[j])} are closer than the clearance.`, ids: [ns[i].id, ns[j].id] });
    }
  }
  const area = [IX0, IY0, IX1, IY1];
  const reserved = [IX1 - TB_W, IY0, IX1, notesLayout(doc).top];
  for (const n of ns) {
    const g = geoms.get(n.id);
    if (!R.contains(area, g.outer[0], g.outer[1]) || !R.contains(area, g.outer[2], g.outer[3])) {
      issues.push({ lvl: "error", msg: `${name(n)} is outside the drawing border.`, ids: [n.id] });
    } else if (R.overlaps(g.outer, reserved)) {
      issues.push({ lvl: "error", msg: `${name(n)} overlaps the title block / notes.`, ids: [n.id] });
    }
    const tp = throughPorts(n, doc);
    const used = connectedPorts(doc, n.id);
    if (tp && (!used.has(tp.inP.id) || !used.has(tp.outP.id)) && !SYMBOLS[n.sym].junction) {
      issues.push({ lvl: "info", msg: `${name(n)} has an unconnected ${!used.has(tp.inP.id) ? "inlet" : "outlet"}.`, ids: [n.id] });
    }
  }
  const paths = edgePaths(doc, geoms);
  const avoid = labelObstacles(doc, geoms);
  for (const e of doc.edges) {
    if (e.routeFailed) issues.push({ lvl: "warn", msg: `Connection ${name(nodeById(e.from.n))} → ${name(nodeById(e.to.n))} could not be routed cleanly.`, ids: [e.id] });
    const lab = edgeLabelLayout(doc, e, paths.get(e.id), avoid);
    if (lab) {
      avoid.push(lab.box);
      for (const n of ns) {
        const g = geoms.get(n.id);
        if (R.overlaps(lab.box, g.outer)) { issues.push({ lvl: "warn", msg: `The label on ${name(nodeById(e.from.n))} → ${name(nodeById(e.to.n))} runs into ${name(n)}.`, ids: [e.id, n.id] }); break; }
      }
    }
  }
  const tags = new Map();
  for (const n of ns) if (n.tag) { const k = n.tag.toUpperCase(); tags.set(k, [...(tags.get(k) || []), n.id]); }
  for (const [t, ids] of tags) if (ids.length > 1) issues.push({ lvl: "warn", msg: `Tag ${t} is used ${ids.length} times.`, ids });
  return issues;
}

function showCheck() {
  const issues = checkLayout(ED.doc);
  const list = $("#checkList");
  if (!issues.length) list.replaceChildren(el("div", { class: "ok" }, "No problems found."));
  else {
    const order = { error: 0, warn: 1, info: 2 };
    issues.sort((a, b) => order[a.lvl] - order[b.lvl]);
    list.replaceChildren(...issues.map((it) => el("div", {
      class: "issue",
      onclick: () => { ED.sel = new Set(it.ids); $("#checkDialog").hidden = true; renderOverlay(); renderProps(); },
    }, el("span", { class: `lvl ${it.lvl}` }, it.lvl === "warn" ? "WARNING" : it.lvl.toUpperCase()), el("span", {}, it.msg))));
  }
  $("#checkDialog").hidden = false;
}

// ------------------------------------------------------------- file / export
function fileName(ext) { return `${(ED.doc.name || "drawing").replace(/[^A-Za-z0-9_-]+/g, "_")}.${ext}`; }
function downloadBlob(blob, name) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function exportDxf() {
  const { sheet } = renderDoc(ED.doc);
  downloadBlob(new Blob([sheetToDxf(sheet)], { type: "application/dxf" }), fileName("dxf"));
  setStatus(`Downloaded ${fileName("dxf")}`);
}

function printSheet() {
  const { sheet } = renderDoc(ED.doc);
  $("#printSheet").innerHTML = sheetToSvg(sheet, { width: "17in", height: "11in" });
  const prev = document.title;
  document.title = fileName("pdf").replace(/\.pdf$/, "");
  window.print();
  document.title = prev;
}

function bindUi() {
  $("#paletteSearch").addEventListener("input", renderPalette);
  $("#docSelect").addEventListener("change", (e) => switchDoc(+e.target.value));
  const menu = $(".menu");
  $("#btnNew").addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("open"); });
  document.addEventListener("click", () => menu.classList.remove("open"));
  $$("[data-new]").forEach((b) => b.addEventListener("click", () => addDoc(newDoc(b.dataset.new))));
  $("#exampleList").replaceChildren(...Object.entries(examples()).map(([k, ex]) =>
    el("button", { onclick: () => loadExample(k) }, ex.name)));
  $("#btnDup").addEventListener("click", () => {
    const d = normalizeDoc(JSON.parse(cleanDoc(ED.doc)));
    d.id = uid("d"); d.name += " (copy)";
    addDoc(d);
  });
  $("#btnDelDoc").addEventListener("click", () => {
    if (!confirm(`Delete the drawing "${ED.doc.name}"? This cannot be undone.`)) return;
    ED.store.docs.splice(ED.store.cur, 1);
    if (!ED.store.docs.length) ED.store.docs.push(newDoc("oneline"));
    switchDoc(Math.min(ED.store.cur, ED.store.docs.length - 1));
  });
  $("#btnUndo").addEventListener("click", doUndo);
  $("#btnRedo").addEventListener("click", doRedo);
  $("#btnArrange").addEventListener("click", runAutoArrange);
  $("#btnRoute").addEventListener("click", runReroute);
  $("#btnCheck").addEventListener("click", showCheck);
  $("#checkClose").addEventListener("click", () => { $("#checkDialog").hidden = true; });
  $("#checkDialog").addEventListener("click", (e) => { if (e.target.id === "checkDialog") e.target.hidden = true; });
  $("#btnImport").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list = Array.isArray(data) ? data : [data];
      for (const d of list) {
        const doc = normalizeDoc(d);
        doc.id = uid("d");
        if (doc.nodes.some((n) => !n.x && !n.y)) autoArrange(doc); else routeEdges(doc);
        ED.store.docs.push(doc);
      }
      switchDoc(ED.store.docs.length - 1);
      setStatus(`Imported ${list.length} drawing(s)`);
    } catch (err) { alert("Could not read that file: " + err.message); }
  });
  $("#btnSaveJson").addEventListener("click", () =>
    downloadBlob(new Blob([JSON.stringify(JSON.parse(cleanDoc(ED.doc)), null, 1)], { type: "application/json" }), fileName("json")));
  $("#btnDxf").addEventListener("click", exportDxf);
  $("#btnPrint").addEventListener("click", printSheet);
  $("#zoomIn").addEventListener("click", () => zoomAt(1.25, ED.view.x + ED.view.w / 2, ED.view.y + ED.view.h / 2));
  $("#zoomOut").addEventListener("click", () => zoomAt(0.8, ED.view.x + ED.view.w / 2, ED.view.y + ED.view.h / 2));
  $("#zoomFit").addEventListener("click", zoomFit);
  for (const [id, k] of [["#optKeep", "keep"], ["#optGrid", "grid"], ["#optAvoid", "avoid"]]) {
    $(id).checked = ED.opts[k];
    $(id).addEventListener("change", (e) => { ED.opts[k] = e.target.checked; renderGrid(); renderOverlay(); });
  }
}

// ------------------------------------------------------------------ start
(async function init() {
  try { await loadEmbeddedFonts(); } catch (e) { console.error("font load failed", e); }
  loadStore();
  if (!ED.store.docs.length) {
    for (const ex of Object.values(examples())) {
      const doc = normalizeDoc(clone(ex));
      autoArrange(doc);
      ED.store.docs.push(doc);
    }
    ED.store.cur = 0;
  }
  bindUi();
  bindCanvas();
  renderGrid();
  switchDoc(ED.store.cur);
  window.DD = { ED, autoArrange, routeEdges, renderDoc, sheetToDxf, sheetToSvg, normalizeDoc, checkLayout, nodeGeom, allGeoms };
})();
