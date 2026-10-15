/* =========================================================================
 * UI: tabs and forms, live solution, map wiring, storage, import/export.
 * ========================================================================= */

const APP = {
  store: { projects: [], cur: 0 },
  p: null, sol: null, tab: "book", sel: null, hiRef: null,
  find: { mode: "point", id: "", line: "", s: "", n: "", e: "", snap: true, target: null, label: "" },
};
const STORE_KEY = "siteSurvey.v1";

// ------------------------------------------------------------- storage
let _saveT = null;
function save() {
  clearTimeout(_saveT);
  _saveT = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(APP.store)); } catch (_) { /* ignore */ } }, 200);
}
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.projects) && s.projects.length) {
      APP.store = { projects: s.projects.map(normalizeProject), cur: clamp(s.cur | 0, 0, s.projects.length - 1) };
    }
  } catch (_) { /* ignore */ }
}
const exampleProject = () => normalizeProject(JSON.parse(JSON.stringify(JSON.parse($("#examples").textContent).example_property)));

function switchProject(i) {
  APP.store.cur = clamp(i, 0, APP.store.projects.length - 1);
  APP.p = APP.store.projects[APP.store.cur];
  APP.sel = null; APP.find.target = null; MAP.find = null; MAP.selected = null; MAP.view = null;
  save();
  renderProjList();
  solve(true);
  renderPane();
}
function addProject(p) { APP.store.projects.push(p); switchProject(APP.store.projects.length - 1); }

function renderProjList() {
  $("#projSelect").replaceChildren(...APP.store.projects.map((p, i) => el("option", { value: i, selected: i === APP.store.cur }, p.name)));
}

// --------------------------------------------------------------- solving
let _solveT = null;
function changed(structural = false) {
  save();
  if (structural) { solve(); renderPane(); return; }
  clearTimeout(_solveT);
  _solveT = setTimeout(() => solve(), 120);
}

function solve(fit = false) {
  APP.sol = solveProject(APP.p);
  if (fit) MAP.view = null;
  updateFind(false);
  renderMap(APP.p, APP.sol);
  renderMessages();
  renderSummary();
  refreshComputed();
  renderTabCounts();
}

function renderSummary() {
  const p = APP.p, sol = APP.sol;
  const total = p.landmarks.length + p.points.length;
  let worst = null;
  for (const [id, inf] of sol.info) if (!worst || inf.r95 > worst.r) worst = { id, r: inf.r95 };
  const ents = entities(p);
  const sus = sol.obs.filter((o) => o.flag).length;
  $("#summary").innerHTML = total ? `<b>${sol.coords.size}</b> of ${total} located · ${sol.dof} redundant` +
    (worst && worst.r > 0 ? ` · worst ±${worst.r.toFixed(2)} ${unitAbbr(p)} (${esc(ents.get(worst.id)?.name || "")})` : "") +
    (sus ? ` · <span style="color:var(--warn)">${sus} suspect reading${sus > 1 ? "s" : ""}</span>` : "") +
    (sol.unscaled ? ` · <span style="color:var(--danger)">no distance yet</span>` : "") : "Add landmarks to begin.";
}

function renderMessages() {
  const box = $("#messages");
  const msgs = APP.sol.messages;
  if (!msgs.length) {
    box.replaceChildren(APP.sol.coords.size > 1 ? el("div", { class: "msg" }, el("span", { class: "lvl ok" }, "OK"),
      el("span", {}, "Everything is located and the readings agree.")) : "");
    return;
  }
  const order = { error: 0, warn: 1, info: 2 };
  box.replaceChildren(...[...msgs].sort((a, b) => order[a.lvl] - order[b.lvl]).map((m) => el("div", {
    class: "msg",
    onclick: () => {
      if (m.ref && (m.ref.setup || m.ref.baseline)) { APP.hiRef = m.ref; APP.tab = "book"; renderPane(); }
      else if (m.ids && m.ids[0]) selectEntity(m.ids[0]);
    },
  }, el("span", { class: `lvl ${m.lvl}` }, m.lvl === "warn" ? "CHECK" : m.lvl === "error" ? "TO DO" : "NOTE"), el("span", {}, m.msg))));
}

/** Update every computed value in the pane without rebuilding it (keeps focus). */
function refreshComputed() {
  const p = APP.p, sol = APP.sol, u = unitAbbr(p);
  for (const node of $$("[data-calc]")) {
    const [kind, id] = node.dataset.calc.split(":");
    if (kind === "pt") {
      const c = sol.coords.get(id), inf = sol.info.get(id);
      if (!c) { node.innerHTML = `<span class="badge no">not located</span>`; continue; }
      const sights = inf.rays ? `seen from ${inf.rays}` : "";
      node.innerHTML = `N ${fmtCoord(c[1])} &nbsp;E ${fmtCoord(c[0])} &nbsp;±${inf.r95.toFixed(2)} ${u}` +
        `${sights ? " · " + sights : ""} &nbsp;${id === p.datum.origin ? '<span class="badge ok">origin</span>' :
          inf.checked ? `<span class="badge ok" title="A misread angle on this point would be flagged. The largest error that could slip through unflagged moves it ${fmtLen(p, inf.shift)}.">checked</span>` :
          `<span class="badge unchk" title="${Number.isFinite(inf.shift) ? `A misread that would not be flagged could move it ${fmtLen(p, inf.shift)}. ` : ""}${inf.rays >= 3 ? "Its sight lines are poorly spread, so add a sighting from a different direction." : "Add a sighting from another landmark so a misread angle would show up."}">no check</span>`}`;
    } else if (kind === "ang" || kind === "res") {
      const [sId, rId] = id.split("/");
      const st = p.setups.find((s) => s.id === sId), r = st && st.readings.find((x) => x.id === rId);
      if (!r) continue;
      if (kind === "ang") {
        const o = sol.obs.find((x) => x.kind === "angle" && x.ref?.reading === rId);
        node.textContent = o ? fmtDMS(o.value) : r.target === st.backsight && r.reading ? "backsight" : "";
      } else {
        const oa = sol.obs.find((x) => x.kind === "angle" && x.ref?.reading === rId);
        const od = sol.obs.find((x) => x.kind === "dist" && x.ref?.reading === rId);
        const parts = [];
        if (oa && oa.v !== undefined) parts.push(fmtSec(oa.v));
        if (od && od.v !== undefined) parts.push(`${od.v.toFixed(3)}`);
        node.textContent = parts.join(" / ");
        const flag = (oa && oa.flag) || (od && od.flag);
        node.classList.toggle("flag", !!flag);
        node.closest("tr")?.classList.toggle("flag", !!flag);
        node.title = flag ? "This reading disagrees with the others; see the messages under the map." : "Residual: measured minus adjusted";
      }
    } else if (kind === "bres") {
      const o = sol.obs.find((x) => x.kind === "dist" && x.ref?.baseline === id);
      node.textContent = o && o.v !== undefined ? o.v.toFixed(3) : "";
      node.classList.toggle("flag", !!(o && o.flag));
    } else if (kind === "len") {
      const l = p.lines.find((x) => x.id === id);
      node.textContent = l ? `Length ${fmtLen(p, lineLength(sol, l), 1)}` : "";
    } else if (kind === "bearing") {
      const az = parseBearing(p.datum.bearing);
      node.textContent = Number.isFinite(az) ? `= ${fmtBearing(az)} (azimuth ${fmtDMS(az)})` : "Can't read this bearing";
      node.classList.toggle("bad", !Number.isFinite(az));
    } else if (kind === "angle") {
      node.classList.toggle("bad", !!node.value.trim() && !Number.isFinite(parseAngle(node.value)));
    }
  }
  if (APP.tab === "find") renderFindResult();
}

function renderTabCounts() {
  const p = APP.p;
  const counts = { landmarks: p.landmarks.length, book: p.setups.length, points: p.points.length, lines: p.lines.length };
  for (const b of $$("#tabs button")) {
    const n = counts[b.dataset.tab];
    b.innerHTML = b.dataset.label + (n ? `<span class="count">${n}</span>` : "");
    b.classList.toggle("active", b.dataset.tab === APP.tab);
  }
}

// ---------------------------------------------------------------- inputs
function inp(value, onInput, attrs = {}) {
  const i = el("input", { type: "text", ...attrs });
  i.value = value ?? "";
  i.addEventListener("input", () => { onInput(i.value); changed(); });
  return i;
}
function area(value, onInput, rows = 2, attrs = {}) {
  const t = el("textarea", { rows, ...attrs });
  t.value = value ?? "";
  t.addEventListener("input", () => { onInput(t.value); changed(); });
  return t;
}
function sel(value, options, onChange, attrs = {}) {
  const s = el("select", attrs, options.map((o) => (o.group
    ? el("optgroup", { label: o.group }, o.items.map(([v, t]) => el("option", { value: v, selected: v === value }, t)))
    : el("option", { value: o[0], selected: o[0] === value }, o[1]))));
  s.addEventListener("change", () => onChange(s.value, s));
  return s;
}
const field = (label, input) => el("label", { class: "field" }, el("span", {}, label), input);
const btn = (text, onClick, cls = "") => el("button", { class: cls, onclick: onClick }, text);
const lmOptions = (excl = null) => APP.p.landmarks.filter((l) => l.id !== excl).map((l) => [l.id, l.name || "(unnamed)"]);

function targetOptions(excl) {
  return [
    ["", "—"],
    { group: "Landmarks", items: APP.p.landmarks.filter((l) => l.id !== excl).map((l) => [l.id, l.name || "(unnamed)"]) },
    { group: "Points", items: APP.p.points.map((x) => [x.id, x.name || "(unnamed)"]) },
    ["__new__", "+ New point…"],
  ];
}

function nextName(list, prefix) {
  let i = list.length + 1;
  while (list.some((x) => x.name === `${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

// ------------------------------------------------------------------ tabs
function renderPane() {
  const pane = $("#pane");
  const fn = { project: paneProject, landmarks: paneLandmarks, book: paneBook, points: panePoints, lines: paneLines, find: paneFind }[APP.tab];
  const scroll = pane.scrollTop;
  pane.replaceChildren(...fn());
  pane.scrollTop = scroll;
  renderTabCounts();
  refreshComputed();
  MAP.onPick = APP.tab === "find" && APP.find.mode === "map" ? pickFindTarget : pickEntity;
  const hi = $(".card.sel, tr.hi");
  if (hi) hi.scrollIntoView({ block: "center" });
}

function paneProject() {
  const p = APP.p;
  const out = [el("h3", {}, "Project")];
  out.push(el("div", { class: "grid2" },
    field("Name", inp(p.name, (v) => { p.name = v; renderProjList(); })),
    field("Location / address", inp(p.location, (v) => { p.location = v; })),
    field("Surveyed by", inp(p.surveyor, (v) => { p.surveyor = v; })),
    field("Units", sel(p.units, [["ft", "Feet"], ["m", "Metres"]], (v) => { p.units = v; changed(true); }))));

  out.push(el("div", { class: "section" }, "Instrument"));
  const presetVal = ANGLE_PRESETS.some(([s]) => s === p.angleSigma) ? String(p.angleSigma) : "custom";
  const custom = inp(p.angleSigma, (v) => { const x = Number(v); if (x > 0) p.angleSigma = x; }, { type: "number", min: "0.5", step: "1" });
  out.push(el("div", { class: "grid2" },
    field("Angle reading precision", sel(presetVal, [...ANGLE_PRESETS.map(([s, t]) => [String(s), t]), ["custom", "Other (seconds)…"]],
      (v) => { if (v !== "custom") { p.angleSigma = +v; changed(true); } else custom.focus(); })),
    field("Precision of one reading (seconds of arc)", custom),
    field("Horizontal circle numbering", sel(p.circle, [["cw", "Clockwise (angle right)"], ["ccw", "Counter-clockwise"]], (v) => { p.circle = v; changed(true); })),
    field("Distance precision", el("div", { class: "row" },
      inp(p.distSigma.fixed, (v) => { const x = Number(v); if (x >= 0) p.distSigma.fixed = x; }, { type: "number", step: "0.005", style: "width:80px" }),
      el("span", { class: "calc" }, `${unitAbbr(p)} + 1:`),
      inp(p.distSigma.ratio, (v) => { const x = Number(v); if (x >= 100) p.distSigma.ratio = x; }, { type: "number", step: "1000", style: "width:90px" })))));

  out.push(el("div", { class: "section" }, "Datum (how the map is placed)"));
  out.push(el("p", { class: "hint" }, "Angles fix the shape of your network. The origin landmark pins its position, the bearing from the origin to the orientation landmark sets which way is north, and at least one taped distance sets the size. For a purely local survey, any bearing works; enter a compass bearing of that line if you want the map close to true north."));
  out.push(el("div", { class: "grid2" },
    field("Origin landmark", sel(p.datum.origin, lmOptions(), (v) => { p.datum.origin = v; if (p.datum.orient === v) p.datum.orient = lmOptions(v)[0]?.[0] || ""; changed(true); })),
    field("Orientation landmark", sel(p.datum.orient, lmOptions(p.datum.origin), (v) => { p.datum.orient = v; changed(true); })),
    field("Origin northing", inp(p.datum.originN, (v) => { const x = Number(v); if (Number.isFinite(x)) p.datum.originN = x; }, { type: "number" })),
    field("Origin easting", inp(p.datum.originE, (v) => { const x = Number(v); if (Number.isFinite(x)) p.datum.originE = x; }, { type: "number" }))));
  out.push(field("Bearing from origin to orientation landmark (e.g. N 12 30 00 E, or an azimuth)",
    inp(p.datum.bearing, (v) => { p.datum.bearing = v; })));
  out.push(el("div", { class: "parsed", "data-calc": "bearing" }));

  out.push(el("div", { class: "section" }, "Plan sheet & report"));
  const scales = SCALES[p.units];
  out.push(el("div", { class: "grid2" },
    field("Plan scale", sel(String(p.plotScale || ""), [["", "Automatic"], ...scales.map((s) => [String(s), scaleText(p, s)])], (v) => { p.plotScale = v ? +v : ""; save(); })),
    field("Font", sel(p.font, Object.entries(FONTS).map(([k, f]) => [k, f.label]), (v) => { p.font = v; changed(true); })),
    field("Sight lines on the plan", sel(p.planSights ? "1" : "", [["", "Hide"], ["1", "Show"]], (v) => { p.planSights = !!v; save(); })),
    field("Drawing number", inp(p.titleblock.dwg_no, (v) => { p.titleblock.dwg_no = v; })),
    field("Revision", inp(p.titleblock.rev, (v) => { p.titleblock.rev = v; })),
    field("Drawing title (blank = automatic)", inp(p.titleblock.title, (v) => { p.titleblock.title = v; })),
    field("Date", inp(p.titleblock.date, (v) => { p.titleblock.date = v; }))));
  out.push(field("Notes (one per line)", area(p.notes.join("\n"), (v) => { p.notes = v.split("\n").map((x) => x.trim()).filter(Boolean); }, 4)));
  if (p.font !== "arial") {
    const f = FONTS[p.font];
    const links = f.files.map((name) => { const a = el("a", { href: "#" }, name); a.onclick = (e) => { e.preventDefault(); downloadBlob(fontFileBlob(name), name); }; return a; });
    out.push(el("p", { class: "hint" }, "For DXF text to fit in CAD, install ", links[0], " and ", links[1], " on that computer."));
  }
  return out;
}

function paneLandmarks() {
  const p = APP.p;
  const out = [el("h3", {}, "Landmarks"),
    el("p", { class: "hint" }, "Permanent marks you can set the transit over: rebar with caps, chiseled marks in concrete, etc. Describe each well enough to find it again. Each needs sightings from two located landmarks (or a setup on it sighting two), and at least one distance between two landmarks must be taped.")];
  if (!p.landmarks.length) out.push(el("div", { class: "empty" }, "No landmarks yet."));
  for (const l of p.landmarks) {
    out.push(el("div", { class: `card${APP.sel === l.id ? " sel" : ""}`, "data-id": l.id },
      el("div", { class: "row" },
        inp(l.name, (v) => { l.name = v; }, { style: "width:110px; font-weight:600", placeholder: "Name" }),
        el("div", { class: "calc grow", "data-calc": `pt:${l.id}` }),
        btn("Find", () => { APP.find = { ...APP.find, mode: "point", id: l.id }; APP.tab = "find"; renderPane(); }, "small"),
        btn("✕", () => deleteEntity(l.id), "small danger")),
      el("div", { style: "margin-top:6px" }, area(l.desc, (v) => { l.desc = v; }, 2, { placeholder: "Description: what it is and how to find it" }))));
  }
  out.push(btn("+ Add landmark", () => {
    p.landmarks.push({ id: sid("L"), name: nextName(p.landmarks, "LM-"), desc: "" });
    if (!p.datum.origin) p.datum.origin = p.landmarks[0].id;
    if (!p.datum.orient && p.landmarks.length > 1) p.datum.orient = p.landmarks[1].id;
    changed(true);
  }));
  return out;
}

function paneBook() {
  const p = APP.p, u = unitAbbr(p);
  const out = [el("h3", {}, "Field book"),
    el("p", { class: "hint" }, `One card per instrument setup: set up over a landmark, sight the backsight landmark and note the circle reading (usually zero it), then read the circle on each target. Angles can be typed as 123 45 20, 123°45'20", 123-45-20 or decimal degrees. Distances are optional (${u}). Press Enter in the last row to add another.`)];
  if (p.landmarks.length < 2) out.push(el("div", { class: "empty" }, "Add at least two landmarks first."));
  p.setups.forEach((s, si) => out.push(setupCard(s, si)));
  out.push(el("div", { class: "row" }, btn("+ New setup", () => {
    const prev = p.setups[p.setups.length - 1];
    const used = new Set(p.setups.map((x) => x.station));
    const st = p.landmarks.find((l) => !used.has(l.id))?.id || p.landmarks[0]?.id || "";
    const bs = p.landmarks.find((l) => l.id !== st)?.id || "";
    p.setups.push({ id: sid("S"), date: prev?.date || isoToday(), station: st, backsight: bs, bsReading: "0 00 00", note: "",
                    readings: [{ id: sid("R"), target: "", reading: "", dist: "", note: "", off: false }] });
    changed(true);
  })));

  out.push(el("div", { class: "section" }, "Taped distances"));
  out.push(el("p", { class: "hint" }, "Horizontal distances measured between any two named marks. At least one between two landmarks sets the scale."));
  const tb = el("table", { class: "book" }, el("tr", {}, ...["From", "To", `Distance (${u})`, "Residual", "Ignore", "Note", ""].map((t) => el("th", {}, t))));
  for (const b of p.baselines) {
    const opts = [["", "—"], { group: "Landmarks", items: lmOptions() }, { group: "Points", items: p.points.map((x) => [x.id, x.name]) }];
    tb.append(el("tr", { class: b.off ? "off" : "" },
      el("td", {}, sel(b.a, opts, (v) => { b.a = v; changed(); })),
      el("td", {}, sel(b.b, opts, (v) => { b.b = v; changed(); })),
      el("td", { style: "width:110px" }, inp(b.dist, (v) => { b.dist = v; }, { inputmode: "decimal" })),
      el("td", { class: "res", "data-calc": `bres:${b.id}` }),
      el("td", { class: "c" }, checkbox(b.off, (v) => { b.off = v; changed(true); })),
      el("td", {}, inp(b.note, (v) => { b.note = v; })),
      el("td", {}, btn("✕", () => { p.baselines = p.baselines.filter((x) => x !== b); changed(true); }, "small danger"))));
  }
  out.push(tb, btn("+ Taped distance", () => {
    p.baselines.push({ id: sid("B"), a: p.datum.origin, b: p.datum.orient, dist: "", note: "", off: false });
    changed(true);
  }));
  return out;
}

function checkbox(v, on) {
  const c = el("input", { type: "checkbox", checked: !!v });
  c.addEventListener("change", () => on(c.checked));
  return c;
}

function setupCard(s, si) {
  const p = APP.p;
  const hiSetup = APP.hiRef && APP.hiRef.setup === s.id;
  const card = el("div", { class: `card${hiSetup ? " sel" : ""}` });
  card.append(el("div", { class: "row" },
    el("b", { style: "flex:none" }, `#${si + 1}`),
    el("input", { type: "date", value: s.date, style: "width:140px", oninput: (e) => { s.date = e.target.value; changed(); } }),
    el("span", { class: "calc" }, "At"),
    sel(s.station, [["", "—"], ...lmOptions()], (v) => { s.station = v; if (s.backsight === v) s.backsight = ""; changed(true); }, { class: "grow" }),
    el("span", { class: "calc" }, "BS"),
    sel(s.backsight, [["", "—"], ...lmOptions(s.station)], (v) => { s.backsight = v; changed(true); }, { class: "grow" }),
    el("span", { class: "calc" }, "@"),
    inp(s.bsReading, (v) => { s.bsReading = v; }, { style: "width:90px", title: "Circle reading on the backsight", "data-calc": "angle" }),
    btn("✕", () => { if (confirm("Delete this setup and its readings?")) { APP.p.setups = APP.p.setups.filter((x) => x !== s); changed(true); } }, "small danger")));
  const t = el("table", { class: "book" }, el("tr", {}, ...["Target", "Circle reading", "Angle right", "Dist.", "Resid.", "Ign.", "Note", ""].map((x) => el("th", {}, x))));
  s.readings.forEach((r, ri) => {
    const hi = APP.hiRef && APP.hiRef.reading === r.id;
    const tsel = sel(r.target, targetOptions(s.station), (v) => {
      if (v === "__new__") {
        const name = prompt("Name of the new point:", nextName(p.points, "P"));
        if (name) { const id = sid("P"); p.points.push({ id, name, type: "", depth: "", desc: "" }); r.target = id; }
        changed(true);
        return;
      }
      r.target = v; changed(true);
    });
    const read = inp(r.reading, (v) => { r.reading = v; }, { placeholder: "ddd mm ss", "data-calc": "angle", inputmode: "decimal" });
    const dist = inp(r.dist, (v) => { r.dist = v; }, { inputmode: "decimal" });
    const note = inp(r.note, (v) => { r.note = v; });
    const addOnEnter = (e) => {
      if (e.key === "Enter" && ri === s.readings.length - 1) {
        e.preventDefault();
        s.readings.push({ id: sid("R"), target: "", reading: "", dist: "", note: "", off: false });
        changed(true);
        requestAnimationFrame(() => { const rows = $$(`[data-setup="${s.id}"] select`); rows[rows.length - 1]?.focus(); });
      }
    };
    for (const x of [read, dist, note]) x.addEventListener("keydown", addOnEnter);
    t.append(el("tr", { class: `${r.off ? "off" : ""}${hi ? " hi flag" : ""}`, "data-setup": s.id },
      el("td", { style: "width:26%" }, tsel),
      el("td", { style: "width:17%" }, read),
      el("td", { class: "calc", "data-calc": `ang:${s.id}/${r.id}`, style: "white-space:nowrap" }),
      el("td", { style: "width:11%" }, dist),
      el("td", { class: "res", "data-calc": `res:${s.id}/${r.id}` }),
      el("td", { class: "c" }, checkbox(r.off, (v) => { r.off = v; changed(true); })),
      el("td", {}, note),
      el("td", {}, btn("✕", () => { s.readings = s.readings.filter((x) => x !== r); changed(true); }, "small danger"))));
  });
  card.append(t, el("div", { class: "row", style: "margin-top:6px" },
    btn("+ Reading", () => { s.readings.push({ id: sid("R"), target: "", reading: "", dist: "", note: "", off: false }); changed(true); }, "small"),
    inp(s.note, (v) => { s.note = v; }, { placeholder: "Setup note (weather, instrument height, who read it…)", class: "grow" })));
  return card;
}

function panePoints() {
  const p = APP.p;
  const out = [el("h3", {}, "Points of interest"),
    el("p", { class: "hint" }, "Anything you want to find again: pipe bends and tees, valves, junction boxes, tank lids. Sight each from at least two landmarks; three gives a check. Add them here or straight from the field book (“+ New point…”).")];
  if (!p.points.length) out.push(el("div", { class: "empty" }, "No points yet."));
  for (const x of p.points) {
    out.push(el("div", { class: `card${APP.sel === x.id ? " sel" : ""}`, "data-id": x.id },
      el("div", { class: "row" },
        inp(x.name, (v) => { x.name = v; }, { style: "width:90px; font-weight:600", placeholder: "Name" }),
        sel(x.type, Object.entries(TYPES).map(([k, t]) => [k, t.name]), (v) => { x.type = v; changed(); }, { style: "width:140px" }),
        inp(x.depth, (v) => { x.depth = v; }, { placeholder: "Depth", style: "width:80px" }),
        inp(x.desc, (v) => { x.desc = v; }, { placeholder: "Description", class: "grow" }),
        btn("Find", () => { APP.find = { ...APP.find, mode: "point", id: x.id }; APP.tab = "find"; renderPane(); }, "small"),
        btn("✕", () => deleteEntity(x.id), "small danger")),
      el("div", { class: "calc", style: "margin-top:4px", "data-calc": `pt:${x.id}` })));
  }
  out.push(btn("+ Add point", () => { p.points.push({ id: sid("P"), name: nextName(p.points, "P"), type: "", depth: "", desc: "" }); changed(true); }));
  return out;
}

function paneLines() {
  const p = APP.p;
  const ents = entities(p);
  const out = [el("h3", {}, "Lines"), el("p", { class: "hint" }, "Connect points into runs (water service, conduit, fence) so they are drawn and so you can find any spot along them. Colours follow the APWA utility color code.")];
  if (!p.lines.length) out.push(el("div", { class: "empty" }, "No lines yet."));
  for (const l of p.lines) {
    const chips = el("div", { class: "chips" }, ...l.pts.map((id, i) => el("span", { class: "chip" }, ents.get(id)?.name || "?",
      el("button", { title: "Remove", onclick: () => { l.pts.splice(i, 1); changed(true); } }, "×"))),
      sel("", [["", "+ add point…"], { group: "Points", items: p.points.map((x) => [x.id, x.name]) }, { group: "Landmarks", items: lmOptions() }],
        (v) => { if (v) { l.pts.push(v); changed(true); } }, { style: "width:130px" }));
    const along = inp("", () => {}, { placeholder: `distance (${unitAbbr(p)})`, style: "width:110px", inputmode: "decimal" });
    out.push(el("div", { class: "card" },
      el("div", { class: "row" },
        inp(l.name, (v) => { l.name = v; }, { style: "width:150px; font-weight:600", placeholder: "Name" }),
        sel(l.type, Object.entries(TYPES).map(([k, t]) => [k, t.name]), (v) => { l.type = v; changed(); }, { style: "width:140px" }),
        inp(l.depth, (v) => { l.depth = v; }, { placeholder: "Depth", style: "width:80px" }),
        el("span", { class: "calc grow", "data-calc": `len:${l.id}` }),
        btn("✕", () => { p.lines = p.lines.filter((x) => x !== l); changed(true); }, "small danger")),
      el("div", { style: "margin:6px 0" }, chips),
      el("div", { class: "row" }, inp(l.desc, (v) => { l.desc = v; }, { placeholder: "Description (size, material…)", class: "grow" }),
        el("span", { class: "calc" }, "Find at"), along,
        btn("Find", () => { APP.find = { ...APP.find, mode: "line", line: l.id, s: along.value || "0" }; APP.tab = "find"; renderPane(); }, "small"))));
  }
  out.push(btn("+ Add line", () => { p.lines.push({ id: sid("F"), name: nextName(p.lines, "Line "), type: "", pts: [], depth: "", desc: "" }); changed(true); }));
  return out;
}

// ------------------------------------------------------------------ find
function paneFind() {
  const p = APP.p, f = APP.find;
  const out = [el("h3", {}, "Find a point"),
    el("p", { class: "hint" }, "Pick what to find. The best two setups are chosen so their sight lines cross squarely, preferring setups you have already sighted from (known line of sight). Mark both lines on the ground; the point is where they cross. The tape distances give an independent check.")];
  const modes = [["point", "A point or landmark"], ["line", "Along a line"], ["coord", "Coordinates"], ["map", "Click on the map"]];
  out.push(el("div", { class: "row", style: "flex-wrap:wrap; gap:12px; margin-bottom:10px" }, ...modes.map(([k, t]) => {
    const r = el("input", { type: "radio", name: "fmode", checked: f.mode === k });
    r.addEventListener("change", () => { f.mode = k; renderPane(); updateFind(); });
    return el("label", { class: "row" }, r, t);
  })));
  if (f.mode === "point") {
    out.push(field("Target", sel(f.id, [["", "—"], { group: "Points", items: p.points.map((x) => [x.id, x.name]) }, { group: "Landmarks", items: lmOptions() }],
      (v) => { f.id = v; updateFind(); })));
  } else if (f.mode === "line") {
    out.push(el("div", { class: "grid2" },
      field("Line", sel(f.line, [["", "—"], ...p.lines.map((l) => [l.id, l.name])], (v) => { f.line = v; updateFind(); })),
      field(`Distance from its first point (${unitAbbr(p)})`, inp(f.s, (v) => { f.s = v; updateFind(); }, { inputmode: "decimal" }))));
  } else if (f.mode === "coord") {
    out.push(el("div", { class: "grid2" },
      field("Northing", inp(f.n, (v) => { f.n = v; updateFind(); }, { inputmode: "decimal" })),
      field("Easting", inp(f.e, (v) => { f.e = v; updateFind(); }, { inputmode: "decimal" }))));
  } else {
    out.push(el("p", { class: "hint" }, "Click anywhere on the map, e.g. where you plan to dig."),
      el("label", { class: "row" }, checkbox(f.snap, (v) => { f.snap = v; }), "Snap to the nearest line when close to one"));
  }
  out.push(el("div", { class: "find-out", id: "findOut" }));
  updateFind(false);
  return out;
}

/** Work out the find target from the inputs and update the map overlay. */
function updateFind(render = true) {
  const p = APP.p, sol = APP.sol, f = APP.find;
  if (APP.tab !== "find" || !sol) { MAP.find = null; if (render && sol) renderMap(p, sol); return; }
  let X = null, label = "", targetId = null;
  const ents = entities(p);
  if (f.mode === "point" && f.id && sol.coords.has(f.id)) {
    X = sol.coords.get(f.id); targetId = f.id;
    const e = ents.get(f.id); label = `${e.name}${e.desc ? " — " + e.desc : ""}`;
  } else if (f.mode === "line" && f.line) {
    const l = p.lines.find((x) => x.id === f.line);
    const s = Number(f.s);
    const pa = l && Number.isFinite(s) ? pointAlong(sol, l, s) : null;
    if (pa) { X = pa.xy; label = `${l.name}, ${fmtLen(p, pa.s, 2)} from ${ents.get(l.pts[0])?.name || "start"}`; }
  } else if (f.mode === "coord") {
    const n = Number(f.n), e = Number(f.e);
    if (String(f.n).trim() && String(f.e).trim() && Number.isFinite(n) && Number.isFinite(e)) { X = [e, n]; label = `N ${n.toFixed(2)}, E ${e.toFixed(2)}`; }
  } else if (f.mode === "map" && f.target) { X = f.target; label = f.label; }
  f.result = X ? { X, label, targetId, opts: findOptions(p, sol, X, targetId) } : null;
  MAP.find = f.result ? { target: X, setups: f.result.opts.best || [] } : null;
  if (render) { renderMap(p, sol); renderFindResult(); }
}

function renderFindResult() {
  const box = $("#findOut");
  if (!box) return;
  const p = APP.p, f = APP.find, r = f.result;
  if (!r) { box.innerHTML = `<p class="empty">Choose a target.</p>`; return; }
  const ents = entities(p);
  const nm = (id) => esc(ents.get(id)?.name || "?");
  let s = findCardHtml(p, APP.sol, r.label, r.X, r.targetId).replace('class="card"', 'class="card" style="background:#fff"');
  s += `<div class="section">All setups (${r.opts.options.length})</div><table class="opts"><tr><th>Set up on</th><th>Sight</th><th>Turn to</th><th class="n">Distance</th><th>Line of sight</th></tr>`;
  for (const o of r.opts.options) {
    s += `<tr><td><b>${nm(o.station)}</b></td><td>${nm(o.backsight)}</td><td>${fmtDMS(o.reading)}</td><td class="n">${fmtLen(p, o.dist)}</td>` +
         `<td>${r.targetId ? (o.seen ? "sighted before" : "not checked") : "—"}</td></tr>`;
  }
  s += `</table><p class="hint" style="margin-top:8px">Readings assume the circle is set to 0°00'00" on the backsight and turned ${p.circle === "cw" ? "clockwise" : "counter-clockwise"}.</p>`;
  box.innerHTML = s;
}

function pickFindTarget(X) {
  const f = APP.find, p = APP.p, sol = APP.sol;
  let label = `N ${X[1].toFixed(2)}, E ${X[0].toFixed(2)}`;
  if (f.snap) {
    const near = nearestOnLines(p, sol, X);
    if (near && near.d * MAP.view.ppu < 14) {
      X = near.xy;
      label = `${near.line.name}, ${fmtLen(p, near.s, 2)} from ${entities(p).get(near.line.pts[0])?.name || "start"}`;
    }
  }
  f.target = X; f.label = label;
  updateFind();
}

function pickEntity(X, owner) {
  if (owner && entities(APP.p).has(owner)) selectEntity(owner);
}

function selectEntity(id) {
  const ent = entities(APP.p).get(id);
  if (!ent) return;
  APP.sel = id; MAP.selected = id;
  if (APP.tab === "find") { APP.find.mode = "point"; APP.find.id = id; }
  else APP.tab = ent.kind === "lm" ? "landmarks" : "points";
  renderPane();
  updateFind();
  renderMap(APP.p, APP.sol);
}

function deleteEntity(id) {
  const p = APP.p;
  const ent = entities(p).get(id);
  const uses = p.setups.reduce((n, s) => n + (s.station === id || s.backsight === id ? 1 : 0) + s.readings.filter((r) => r.target === id).length, 0);
  if (!confirm(`Delete ${ent.name || "this item"}?${uses ? ` Its ${uses} field-book entr${uses > 1 ? "ies" : "y"} will lose their target.` : ""}`)) return;
  p.landmarks = p.landmarks.filter((x) => x.id !== id);
  p.points = p.points.filter((x) => x.id !== id);
  for (const l of p.lines) l.pts = l.pts.filter((x) => x !== id);
  APP.p = normalizeProject(p);
  APP.store.projects[APP.store.cur] = APP.p;
  changed(true);
}

// ---------------------------------------------------------- import/export
function fileName(ext) { return `${(APP.p.name || "survey").replace(/[^A-Za-z0-9_-]+/g, "_")}.${ext}`; }
function downloadBlob(blob, name) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function printWith(html, pageCss) {
  $("#pageStyle").textContent = pageCss;
  $("#printArea").innerHTML = html;
  const prev = document.title;
  document.title = fileName("pdf").replace(/\.pdf$/, "");
  window.print();
  document.title = prev;
}
function printPlan() {
  const { sheet } = renderPlan(APP.p, APP.sol);
  printWith(sheetToSvg(sheet, { width: "17in", height: "11in" }).replace("<svg ", '<svg class="plan" '), "@page { size: 17in 11in; margin: 0; }");
}
function printReport() {
  printWith(reportHtml(APP.p, APP.sol), "@page { size: letter; margin: 0.55in; }");
}

function bindUi() {
  for (const b of $$("#tabs button")) {
    b.dataset.label = b.textContent;
    b.addEventListener("click", () => { APP.tab = b.dataset.tab; APP.hiRef = null; renderPane(); updateFind(); });
  }
  $("#projSelect").addEventListener("change", (e) => switchProject(+e.target.value));
  $("#btnNew").addEventListener("click", () => addProject(newProject(`Survey ${APP.store.projects.length + 1}`)));
  $("#btnExample").addEventListener("click", () => addProject(exampleProject()));
  $("#btnDup").addEventListener("click", () => { const c = normalizeProject(JSON.parse(JSON.stringify(APP.p))); c.id = sid("p"); c.name += " (copy)"; addProject(c); });
  $("#btnDel").addEventListener("click", () => {
    if (!confirm(`Delete the survey "${APP.p.name}"? This can't be undone (save a JSON copy first if unsure).`)) return;
    APP.store.projects.splice(APP.store.cur, 1);
    if (!APP.store.projects.length) APP.store.projects.push(newProject());
    switchProject(Math.min(APP.store.cur, APP.store.projects.length - 1));
  });
  $("#btnImport").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      for (const x of Array.isArray(d) ? d : [d]) APP.store.projects.push(normalizeProject({ ...x, id: sid("p") }));
      switchProject(APP.store.projects.length - 1);
    } catch (err) { alert("Could not read that file: " + err.message); }
  });
  $("#btnSave").addEventListener("click", () => downloadBlob(new Blob([JSON.stringify(APP.p, null, 1)], { type: "application/json" }), fileName("json")));
  const menu = $(".menu");
  $("#btnExport").addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("open"); });
  document.addEventListener("click", () => menu.classList.remove("open"));
  $("#btnCsv").addEventListener("click", () => downloadBlob(new Blob([coordinatesCsv(APP.p, APP.sol)], { type: "text/csv" }), fileName("csv")));
  $("#btnDxfPlan").addEventListener("click", () => downloadBlob(new Blob([sheetToDxf(renderPlan(APP.p, APP.sol).sheet)], { type: "application/dxf" }), fileName("dxf")));
  $("#btnDxfWorld").addEventListener("click", () => downloadBlob(new Blob([worldDxf(APP.p, APP.sol)], { type: "application/dxf" }), fileName("dxf").replace(".dxf", "_1to1.dxf")));
  $("#btnPrintPlan").addEventListener("click", printPlan);
  $("#btnPrintReport").addEventListener("click", printReport);
  for (const [id, k] of [["#optSights", "sights"], ["#optEll", "ellipses"], ["#optLabels", "labels"]]) {
    $(id).addEventListener("change", (e) => { MAP.opts[k] = e.target.checked; renderMap(APP.p, APP.sol); });
  }
  $("#btnFit").addEventListener("click", () => { mapFit(APP.sol); renderMap(APP.p, APP.sol); });
  window.addEventListener("resize", () => renderMap(APP.p, APP.sol));
  bindMap(() => ({ p: APP.p, sol: APP.sol }));
}

(async function init() {
  try { await loadEmbeddedFonts(); } catch (e) { console.error("font load failed", e); }
  loadStore();
  if (!APP.store.projects.length) APP.store.projects.push(exampleProject());
  bindUi();
  switchProject(APP.store.cur);
  window.SV = { APP, solveProject, normalizeProject, findOptions, renderPlan, sheetToSvg, sheetToDxf, worldDxf, coordinatesCsv, reportHtml, parseAngle, fmtDMS };
})();
