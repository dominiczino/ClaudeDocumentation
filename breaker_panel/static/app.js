"use strict";

const SPAN = { blank: 1, single: 1, double: 2, triple: 3, tandem: 1, quad: 2 };
const KIND_LABEL = {
  blank: "Open space / filler",
  single: "1-pole",
  double: "2-pole",
  triple: "3-pole",
  tandem: "Tandem (2 in 1 space)",
  quad: "Quadplex (2×2-pole)",
};
const FEATURES = [["", "Std"], ["GFCI", "GFCI"], ["AFCI", "AFCI"], ["DF", "Dual"], ["SPD", "Surge"]];
const STORE_KEY = "panelDrafter.v1";

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
};

// ---------------------------------------------------------------- storage
function today() { return new Date().toISOString().slice(0, 10); }

function blankPanel(name = "New Panel") {
  return {
    name, location: "", manufacturer: "", model: "",
    voltage: "120/240V 1Φ 3W", phases: 1,
    main: { kind: "breaker", amps: 200 }, bus_amps: 200, fed_from: "",
    spaces: 40, numbering: "odd_even", breakers: [], notes: [],
    titleblock: { project: "", drawn_by: "", date: today(), dwg_no: "", rev: "", sheet: "1 OF 1", uppercase: "1" },
  };
}

let store = { panels: [], cur: 0 };
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.panels) && s.panels.length) store = s;
  } catch (_) { /* ignore */ }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_) { /* ignore */ }
}
const cfg = () => store.panels[store.cur];

// --------------------------------------------------------------- geometry
const rows = () => Math.floor(cfg().spaces / 2);
function slotOf(space) {
  const n = rows();
  if (cfg().numbering === "sequential") return { col: space <= n ? 0 : 1, row: (space - 1) % n };
  return { col: (space - 1) % 2, row: Math.floor((space - 1) / 2) };
}
function spaceAt(col, row) {
  return cfg().numbering === "sequential" ? row + 1 + col * rows() : row * 2 + 1 + col;
}
function spacesOf(b) {
  const s = slotOf(b.space);
  return Array.from({ length: SPAN[b.kind] }, (_, i) => spaceAt(s.col, s.row + i));
}
function phaseOf(row) {
  return Number(cfg().phases) === 3 ? "ABC"[row % 3] : "AB"[row % 2];
}
function occupancy() {
  const occ = {};
  for (const b of cfg().breakers) {
    if (b.space < 1 || b.space > cfg().spaces) continue;
    const s = slotOf(b.space);
    if (s.row + SPAN[b.kind] > rows()) continue;
    for (const sp of spacesOf(b)) occ[sp] = b;
  }
  return occ;
}

// ------------------------------------------------------------ form fields
function getPath(obj, path) { return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj); }
function setPath(obj, path, val) {
  const ks = path.split(".");
  let o = obj;
  for (const k of ks.slice(0, -1)) o = o[k] ??= {};
  o[ks.at(-1)] = val;
}

function bindFields() {
  document.querySelectorAll("[data-k]").forEach((inp) => {
    inp.addEventListener("input", () => {
      let v = inp.value;
      if (inp.hasAttribute("data-num")) v = v === "" ? null : Number(v);
      setPath(cfg(), inp.dataset.k, v);
      if (inp.dataset.k === "name") renderPanelList();
      if (inp.hasAttribute("data-structural") || inp.dataset.k === "phases") {
        if (inp.dataset.k === "spaces") {
          const n = Number(v);
          if (!(n >= 2 && n <= 84 && n % 2 === 0)) { changed(); return; }
          cfg().breakers = cfg().breakers.filter((b) => b.space <= n);
        }
        renderSlots();
      }
      changed();
    });
  });
  $("#notes").addEventListener("input", (e) => {
    cfg().notes = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
    changed();
  });
}

function fillFields() {
  document.querySelectorAll("[data-k]").forEach((inp) => {
    const v = getPath(cfg(), inp.dataset.k);
    inp.value = v == null ? "" : v;
    if (inp.tagName === "SELECT" && inp.selectedIndex < 0) inp.selectedIndex = 0;
  });
  $("#notes").value = (cfg().notes || []).join("\n");
}

// ----------------------------------------------------------- slot editor
function poleRow(pole, tag, onChange) {
  const amps = el("input", { class: "amps", type: "number", min: 0, step: 5, list: "ampList", placeholder: "A", value: pole.amps ?? "" });
  amps.addEventListener("input", () => { pole.amps = amps.value === "" ? null : Number(amps.value); onChange(); });
  const feat = el("select", { class: "feat", title: "Breaker type" },
    ...FEATURES.map(([v, t]) => el("option", { value: v, selected: (pole.feature || "") === v }, t)));
  feat.addEventListener("change", () => { pole.feature = feat.value; onChange(); });
  const label = el("input", { class: "label", placeholder: "Circuit description", value: pole.label || "" });
  label.addEventListener("input", () => { pole.label = label.value; onChange(); });
  return el("div", { class: "pole" },
    el("div", { class: "row" }, tag ? el("span", { class: "tag" }, tag) : null, amps, el("span", { class: "unit" }, "A"), feat),
    el("div", { class: "row" }, label));
}

function setKind(space, kind) {
  const c = cfg();
  const old = c.breakers.find((b) => b.space === space);
  const keep = old ? (old.kind === "tandem" || old.kind === "quad" ? old.a || {} : old) : {};
  c.breakers = c.breakers.filter((b) => b.space !== space);
  if (kind !== "blank") {
    const s = slotOf(space);
    if (s.row + SPAN[kind] > rows()) {
      alert(`A ${KIND_LABEL[kind]} breaker at space ${space} would run past the bottom of the panel.`);
      if (old) c.breakers.push(old);
      renderSlots();
      return;
    }
    const nb = { space, kind };
    if (kind === "tandem" || kind === "quad") {
      nb.a = { amps: keep.amps ?? null, label: keep.label || "", feature: keep.feature || "" };
      nb.b = { amps: null, label: "", feature: "" };
    } else {
      Object.assign(nb, { amps: keep.amps ?? null, label: keep.label || "", feature: keep.feature || "" });
    }
    const claimed = new Set(spacesOf(nb));
    c.breakers = c.breakers.filter((b) => !spacesOf(b).some((sp) => claimed.has(sp)));
    c.breakers.push(nb);
  }
  c.breakers.sort((a, b) => a.space - b.space);
  renderSlots();
  changed();
}

function renderSlots() {
  const c = cfg();
  const box = $("#slots");
  box.replaceChildren();
  const occ = occupancy();
  box.style.gridTemplateRows = `auto repeat(${rows()}, minmax(44px, auto))`;
  box.append(el("div", { class: "col-title", style: "grid-column:1;grid-row:1" }, "Left column"));
  box.append(el("div", { class: "col-title", style: "grid-column:2;grid-row:1" }, "Right column"));
  for (let col = 0; col < 2; col++) {
    for (let row = 0; row < rows(); row++) {
      const sp = spaceAt(col, row);
      const b = occ[sp];
      if (b && b.space !== sp) continue; // covered by a multi-space breaker
      const kind = b ? b.kind : "blank";
      const span = SPAN[kind];
      const phases = Array.from({ length: span }, (_, i) => phaseOf(row + i)).join("");
      const nums = Array.from({ length: span }, (_, i) => spaceAt(col, row + i)).join("/");

      const kindSel = el("select", { class: "kind" },
        ...Object.entries(KIND_LABEL).map(([k, t]) => el("option", { value: k, selected: k === kind }, t)));
      kindSel.addEventListener("change", () => setKind(sp, kindSel.value));
      const head = el("div", { class: "row" }, kindSel);

      const body = el("div", { class: "body" }, head);
      if (kind === "single") {
        const below = row + 1 < rows() ? occ[spaceAt(col, row + 1)] : null;
        if (below && below.kind === "single" && below.space === spaceAt(col, row + 1)) {
          const cb = el("input", { type: "checkbox", checked: !!b.tie_below });
          cb.addEventListener("change", () => { b.tie_below = cb.checked; changed(); });
          head.append(el("label", { class: "tie", title: "Handle tie to the 1-pole breaker below (e.g. multi-wire branch circuit)" }, cb, "tie ↓"));
        } else if (b.tie_below) { b.tie_below = false; }
        body.append(poleRow(b, null, changed));
      } else if (kind === "double" || kind === "triple") {
        body.append(poleRow(b, null, changed));
      } else if (kind === "tandem") {
        body.append(poleRow(b.a, `${sp}A`, changed), poleRow(b.b, `${sp}B`, changed));
      } else if (kind === "quad") {
        body.append(poleRow(b.a, "Outer", changed), poleRow(b.b, "Inner", changed));
      }

      const card = el("div", {
        class: `slot ${kind === "blank" ? "blank" : ""} span-${span}`,
        style: `grid-column:${col + 1};grid-row:${row + 2} / span ${span}`,
      }, el("div", { class: "num" }, nums, el("span", { class: "phase" }, phases)), body);
      box.append(card);
    }
  }
  updateUsage();
}

function updateUsage() {
  const used = cfg().breakers.reduce((n, b) => n + SPAN[b.kind], 0);
  $("#usage").textContent = `${used} of ${cfg().spaces} spaces used · ${cfg().spaces - used} open`;
}

// ---------------------------------------------------------- panel list
function renderPanelList() {
  const sel = $("#panelSelect");
  sel.replaceChildren(...store.panels.map((p, i) => el("option", { value: i, selected: i === store.cur }, p.name || `Panel ${i + 1}`)));
}
function switchTo(i) {
  store.cur = Math.max(0, Math.min(i, store.panels.length - 1));
  renderAll();
}
function renderAll() {
  renderPanelList();
  fillFields();
  renderSlots();
  changed();
}

// --------------------------------------------------------------- preview
let timer = null, seq = 0, ctrl = null;
function changed() {
  save();
  updateUsage();
  $("#sheet").classList.add("stale");
  $("#status").textContent = "Updating…";
  clearTimeout(timer);
  timer = setTimeout(refresh, 350);
}

async function refresh() {
  const my = ++seq;
  if (ctrl) ctrl.abort();
  ctrl = new AbortController();
  try {
    const r = await fetch("/api/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg()), signal: ctrl.signal,
    });
    const j = await r.json();
    if (my !== seq) return;
    const msgs = $("#messages");
    msgs.replaceChildren();
    if (!r.ok) {
      (j.errors || ["Error"]).forEach((e) => msgs.append(el("div", { class: "err" }, e)));
      $("#status").textContent = "Fix errors to update the drawing";
      return;
    }
    (j.warnings || []).forEach((w) => msgs.append(el("div", { class: "warn" }, w)));
    $("#sheet").innerHTML = j.svg;
    $("#sheet").classList.remove("stale");
    const s = j.stats;
    $("#status").textContent = `${s.circuits} circuits · ${s.used}/${s.spaces} spaces used`;
  } catch (e) {
    if (e.name !== "AbortError") $("#status").textContent = "Preview failed: " + e.message;
  }
}

// ------------------------------------------------------------------ zoom
let zoom = 1;
function applyZoom() {
  const wrap = $("#sheetWrap");
  const w = wrap.clientWidth - 36, h = wrap.clientHeight - 36;
  const fit = Math.max(200, Math.min(w, h * 11 / 17));
  $("#sheet").style.width = `${fit * zoom}px`;
}
$("#zoomIn").onclick = () => { zoom = Math.min(zoom * 1.4, 6); applyZoom(); };
$("#zoomOut").onclick = () => { zoom = Math.max(zoom / 1.4, 0.4); applyZoom(); };
$("#zoomFit").onclick = () => { zoom = 1; applyZoom(); };
window.addEventListener("resize", applyZoom);

// -------------------------------------------------------------- actions
function fileName(ext) {
  return `${(cfg().name || "panel").replace(/[^A-Za-z0-9_-]+/g, "_")}.${ext}`;
}
function downloadBlob(blob, name) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function exportAs(fmt) {
  $("#status").textContent = `Generating ${fmt.toUpperCase()}…`;
  const r = await fetch(`/api/export/${fmt}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg()),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({ errors: [r.statusText] }));
    alert((j.errors || []).join("\n"));
    $("#status").textContent = "Export failed";
    return;
  }
  downloadBlob(await r.blob(), fileName(fmt));
  $("#status").textContent = `Downloaded ${fileName(fmt)}`;
}

$("#btnDxf").onclick = () => exportAs("dxf");
$("#btnDwg").onclick = () => exportAs("dwg");
$("#btnPdf").onclick = () => exportAs("pdf");
$("#btnExportJson").onclick = () =>
  downloadBlob(new Blob([JSON.stringify(cfg(), null, 2)], { type: "application/json" }), fileName("json"));
$("#btnImport").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const list = Array.isArray(data) ? data : [data];
    for (const p of list) store.panels.push(Object.assign(blankPanel(), p));
    switchTo(store.panels.length - 1);
  } catch (err) { alert("Could not read file: " + err.message); }
  e.target.value = "";
};
$("#panelSelect").onchange = (e) => switchTo(Number(e.target.value));
$("#btnNew").onclick = () => { store.panels.push(blankPanel(`Panel ${store.panels.length + 1}`)); switchTo(store.panels.length - 1); };
$("#btnDup").onclick = () => {
  const c = JSON.parse(JSON.stringify(cfg()));
  c.name += " (copy)";
  store.panels.push(c);
  switchTo(store.panels.length - 1);
};
$("#btnDel").onclick = () => {
  if (!confirm(`Delete "${cfg().name}"?`)) return;
  store.panels.splice(store.cur, 1);
  if (!store.panels.length) store.panels.push(blankPanel());
  switchTo(store.cur);
};

// ---------------------------------------------------------------- start
(async function init() {
  bindFields();
  load();
  if (!store.panels.length) {
    try {
      const r = await fetch("/api/example");
      store.panels.push(await r.json());
    } catch (_) { store.panels.push(blankPanel()); }
  }
  try {
    const caps = await (await fetch("/api/capabilities")).json();
    if (!caps.dwg) { $("#btnDwg").disabled = true; $("#btnDwg").title = "DWG needs ODA File Converter installed on the server — use DXF"; }
  } catch (_) { /* ignore */ }
  applyZoom();
  renderAll();
})();
