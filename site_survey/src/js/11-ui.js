/* =========================================================================
 * UI: tabs and forms, live solution, map wiring, storage, import/export.
 * ========================================================================= */

const APP = {
  store: { projects: [], cur: 0 },
  p: null, sol: null, geo: null, tab: "book", sel: null, hiRef: null,
  edit: null,   // obstacle being drawn on the map
  pick: null,   // landmark whose lat/lon is being picked on the imagery
  find: { mode: "point", id: "", line: "", s: "", n: "", e: "", lat: "", lon: "", snap: true, target: null, label: "" },
};
const STORE_KEY = "siteSurvey.v1";

// ------------------------------------------------------------- storage
let _saveT = null;
function save() {
  clearTimeout(_saveT);
  _saveT = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(APP.store)); } catch (_) { /* ignore */ } }, 200);
  hostSave(APP.store);
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
  try { localStorage.setItem(STORE_KEY + ".cur", APP.p.id); } catch (_) { /* ignore */ }
  APP.sel = null; APP.find.target = null; MAP.find = null; MAP.selected = null; MAP.view = null; APP.edit = null; APP.pick = null;
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
  APP.geo = georeference(APP.p, APP.sol);
  MAP.geo = APP.geo;
  APP.sol.messages.push(...geoMessages(APP.p, APP.geo), ...obstacleMessages(APP.p, APP.sol));
  if (fit) MAP.view = null;
  syncEdit();
  renderGeoTools();
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
    } else if (kind === "lat" || kind === "lon") {
      node.classList.toggle("bad", !!node.value.trim() && !Number.isFinite(parseLatLon(node.value, kind === "lon")));
    } else if (kind === "geo") {
      const l = p.landmarks.find((x) => x.id === id);
      const r = APP.geo && APP.geo.resid && APP.geo.resid.get(id);
      node.textContent = !l || (!l.lat.trim() && !l.lon.trim()) ? "" : r ? (APP.geo.n > 1 ? `${fmtLen(p, r.d, 1)} from survey` : "pins the imagery")
        : sol.coords.has(id) ? "can't read" : "not located yet";
      node.classList.toggle("flag", !!r && r.z > 3.5 && APP.geo.n >= 3);
    } else if (kind === "geofit") {
      node.innerHTML = geoSummary();
    }
  }
  if (APP.tab === "find") renderFindResult();
}

function renderTabCounts() {
  const p = APP.p;
  const counts = { landmarks: p.landmarks.length, book: p.setups.length, points: p.points.length, lines: p.lines.length, obstacles: p.obstacles.length };
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
  const fn = { project: paneProject, landmarks: paneLandmarks, book: paneBook, points: panePoints, lines: paneLines,
               obstacles: paneObstacles, find: paneFind }[APP.tab];
  if (APP.tab !== "obstacles") APP.edit = null;
  if (APP.tab !== "landmarks") APP.pick = null;
  const scroll = pane.scrollTop;
  pane.replaceChildren(...fn());
  pane.scrollTop = scroll;
  renderTabCounts();
  refreshComputed();
  syncEdit();
  const pickName = APP.pick && APP.p.landmarks.find((l) => l.id === APP.pick)?.name;
  MAP.banner = APP.pick ? `Zoom in, then click exactly where ${pickName} is on the imagery. Esc cancels.`
    : APP.edit ? "Click corners on the map (or a landmark/point to use its position). Drag squares to adjust. Esc when done." : "";
  MAP.onPick = APP.pick ? pickGeo : APP.edit ? pickObstacleVertex : APP.tab === "find" && APP.find.mode === "map" ? pickFindTarget : pickEntity;
  if (APP.sol) renderMap(APP.p, APP.sol);
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

  out.push(el("div", { class: "section" }, HOSTED ? "Georeference" : "Imagery & georeference"));
  if (HOSTED) {
    out.push(el("p", { class: "hint" }, "Give landmarks a latitude/longitude (Landmarks tab) to place the survey on the globe: grid north vs. true north, " +
      "lat/lon in the report and CSV, Google Earth export, and finding a spot by lat/lon. The survey keeps its own shape and scale. " +
      "Satellite imagery isn't available here, because a hosted page can't load map tiles from other sites. The standalone site-survey.html file shows it."),
      el("div", { class: "parsed", "data-calc": "geofit" }));
  } else {
    out.push(el("p", { class: "hint" }, "Give landmarks a latitude/longitude (Landmarks tab) to lay satellite imagery under the map. " +
      "The survey is shifted and rotated onto them by least squares, keeping its own shape and scale, since your angles and tape are far more precise than GPS. " +
      "Once imagery shows, landmarks you can see on it can be picked directly. Imagery needs an internet connection; everything else works offline."));
    out.push(el("div", { class: "parsed", "data-calc": "geofit", style: "margin-bottom:8px" }));
    const op = el("input", { type: "range", min: "10", max: "100", step: "5", value: String(Math.round(p.geo.opacity * 100)) });
    op.addEventListener("input", () => { p.geo.opacity = op.value / 100; save(); renderGeoTools(); renderMap(p, APP.sol); });
    out.push(el("div", { class: "grid2" },
      field("Imagery source", sel(p.geo.source, Object.entries(IMAGERY).map(([k, v]) => [k, v.name]), (v) => { p.geo.source = v; changed(true); })),
      field("Opacity", op)));
    if (p.geo.source === "custom") {
      out.push(field("Tile URL template, e.g. https://example.com/tiles/{z}/{x}/{y}.png", inp(p.geo.custom, (v) => { p.geo.custom = v; })));
    }
    out.push(el("label", { class: "row", style: "margin-bottom:6px" }, checkbox(p.geo.show, (v) => { p.geo.show = v; save(); renderGeoTools(); renderMap(p, APP.sol); }), "Show imagery on the map"),
      el("label", { class: "row" }, checkbox(p.geo.print, (v) => { p.geo.print = v; save(); }), "Include imagery on the printed plan (not in DXF)"));
  }

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
    const links = f.files.map((name) => { const a = el("a", { href: "#" }, name); a.onclick = (e) => { e.preventDefault(); saveFile(name, fontFileBlob(name)); }; return a; });
    out.push(el("p", { class: "hint" }, "For DXF text to fit in CAD, install ", links[0], " and ", links[1], " on that computer."));
  }
  return out;
}

function paneLandmarks() {
  const p = APP.p;
  const out = [el("h3", {}, "Landmarks"),
    el("p", { class: "hint" }, "Permanent marks you can set the transit over: rebar with caps, chiseled marks in concrete, etc. Describe each well enough to find it again. Each needs sightings from two located landmarks (or a setup on it sighting two), and at least one distance between two landmarks must be taped."),
    el("p", { class: "hint" }, (HOSTED ? "Latitude/longitude is optional and only georeferences the survey (Project tab)" : "Latitude/longitude is optional and only places the satellite imagery") +
      ": stand on the mark with a phone GPS app, or paste \"lat, lon\" copied from a map app." +
      (HOSTED ? "" : " Once imagery shows, \"Pick\" a mark you can see on it (fence corners, slab corners) for a better fit."))];
  if (!p.landmarks.length) out.push(el("div", { class: "empty" }, "No landmarks yet."));
  for (const l of p.landmarks) {
    out.push(el("div", { class: `card${APP.sel === l.id ? " sel" : ""}`, "data-id": l.id },
      el("div", { class: "row" },
        inp(l.name, (v) => { l.name = v; }, { style: "width:110px; font-weight:600", placeholder: "Name" }),
        el("div", { class: "calc grow", "data-calc": `pt:${l.id}` }),
        btn("Find", () => { APP.find = { ...APP.find, mode: "point", id: l.id }; APP.tab = "find"; renderPane(); }, "small"),
        btn("✕", () => deleteEntity(l.id), "small danger")),
      el("div", { style: "margin-top:6px" }, area(l.desc, (v) => { l.desc = v; }, 2, { placeholder: "Description: what it is and how to find it" })),
      geoRow(l)));
  }
  out.push(btn("+ Add landmark", () => {
    p.landmarks.push({ id: sid("L"), name: nextName(p.landmarks, "LM-"), desc: "" });
    if (!p.datum.origin) p.datum.origin = p.landmarks[0].id;
    if (!p.datum.orient && p.landmarks.length > 1) p.datum.orient = p.landmarks[1].id;
    changed(true);
  }));
  return out;
}

function geoRow(l) {
  let lonIn = null;
  const latIn = inp(l.lat, (v) => {
    const two = splitLatLon(v);
    if (two) { l.lat = String(two[0]); l.lon = String(two[1]); latIn.value = l.lat; lonIn.value = l.lon; } else l.lat = v;
  }, { placeholder: "Latitude", "data-calc": "lat", style: "width:120px", title: "e.g. 40.771612, 40 46 17.8 N, or paste \"lat, lon\"" });
  lonIn = inp(l.lon, (v) => { l.lon = v; }, { placeholder: "Longitude", "data-calc": "lon", style: "width:120px", title: "e.g. -73.974812 or 73 58 29.3 W" });
  const picking = APP.pick === l.id;
  return el("div", { class: "row", style: "margin-top:6px" },
    el("span", { class: "calc", style: "flex:none" }, "Lat/lon"), latIn, lonIn,
    sel(l.gsrc, Object.entries(GPS_SOURCES).map(([k, v]) => [k, `${v.name} (±${fmtLen(APP.p, v.sigma / M_PER_UNIT[APP.p.units], v.sigma < 0.5 ? 2 : 0)})`]),
      (v) => { l.gsrc = v; changed(); }, { style: "width:150px", title: "Where the latitude/longitude came from; sets its weight in the fit" }),
    HOSTED ? null : btn(picking ? "Cancel" : "Pick", () => { APP.pick = picking ? null : l.id; if (APP.pick && !APP.geo.ok) { APP.pick = null; uiAlert("Imagery appears once at least one landmark has a latitude/longitude. Enter one from a phone or map app first."); return; } if (APP.pick) { APP.p.geo.show = true; save(); renderGeoTools(); } renderPane(); },
      `small${picking ? " primary" : ""}`),
    el("span", { class: "calc grow res", "data-calc": `geo:${l.id}` }));
}

function geoSummary() {
  const p = APP.p, G = APP.geo;
  if (!G || !G.ok) {
    return G && G.entered ? `${G.entered} landmark${G.entered > 1 ? "s have" : " has"} a latitude/longitude but none is located yet.`
      : "No landmark has a latitude/longitude yet, so there is no imagery.";
  }
  const ents = entities(p);
  const ll = localToLL(G, [p.datum.originE, p.datum.originN]);
  if (G.single) return `Placed by one landmark, with grid north taken as true north. Add a second for the rotation. ${esc(ents.get(p.datum.origin)?.name || "Origin")} ≈ ${fmtLat(ll[0])}, ${fmtLon(ll[1])}.`;
  return `Fit to <b>${G.n}</b> landmarks: grid north is <b>${gridNorthText(G.theta)}</b> (±${fmtDMS(2 * G.sigTheta).replace(/^0°/, "")} at 95%). ` +
    `${G.dof > 0 ? `RMS misfit ${fmtLen(p, rmsGeo(G), 1)}. ` : "Two landmarks fit exactly, so there is no check on them. "}` +
    `${G.fitScale ? "<b>Scale taken from GPS</b> (no taped distance yet). " : "Scale from your survey. "}` +
    `${esc(ents.get(p.datum.origin)?.name || "Origin")} ≈ ${fmtLat(ll[0])}, ${fmtLon(ll[1])}.`;
}

function renderGeoTools() {
  const p = APP.p, ok = !!(APP.geo && APP.geo.ok);
  const lab = $("#imgTool");
  lab.hidden = HOSTED; $("#optImgOp").hidden = HOSTED;
  lab.classList.toggle("disabled", !ok);
  lab.title = ok ? "Satellite imagery under the map" : "Give a landmark a latitude/longitude (Landmarks tab) to show imagery";
  $("#optImg").checked = p.geo.show;
  $("#optImg").disabled = !ok;
  $("#optImgOp").value = String(Math.round(p.geo.opacity * 100));
  $("#optImgOp").disabled = !ok || !p.geo.show;
}

function pickGeo(X) {
  const l = APP.p.landmarks.find((x) => x.id === APP.pick);
  APP.pick = null;
  if (l && APP.geo && APP.geo.ok) {
    const [la, lo] = localToLL(APP.geo, X);
    l.lat = la.toFixed(7); l.lon = lo.toFixed(7); l.gsrc = "image";
  }
  changed(true);
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
  out.push(el("div", { class: "table-scroll" }, tb), btn("+ Taped distance", () => {
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
    btn("✕", async () => { if (await uiConfirm("Delete this setup and its readings?", { okText: "Delete", danger: true })) { APP.p.setups = APP.p.setups.filter((x) => x !== s); changed(true); } }, "small danger")));
  const t = el("table", { class: "book" }, el("tr", {}, ...["Target", "Circle reading", "Angle right", "Dist.", "Resid.", "Ign.", "Note", ""].map((x) => el("th", {}, x))));
  s.readings.forEach((r, ri) => {
    const hi = APP.hiRef && APP.hiRef.reading === r.id;
    const tsel = sel(r.target, targetOptions(s.station), async (v) => {
      if (v === "__new__") {
        const name = await uiPrompt("Name of the new point:", nextName(p.points, "P"), { okText: "Add point" });
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
  card.append(el("div", { class: "table-scroll" }, t), el("div", { class: "row", style: "margin-top:6px" },
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

// ------------------------------------------------------------- obstacles
const round2 = (v) => Math.round(v * 100) / 100;

function paneObstacles() {
  const p = APP.p, ents = entities(p);
  const out = [el("h3", {}, "Obstacles"),
    el("p", { class: "hint" }, "Buildings, sheds, hedges and solid walls. They are drawn on the map and plan, and the Find tool won't send you to a setup whose line to the spot, or to its backsight, passes through one that blocks sight. " +
      "Click Draw, then click the corners on the map (over the imagery, if you have it). Clicking a landmark or point uses its surveyed position as a corner. Drag the square handles to adjust.")];
  if (!p.obstacles.length) out.push(el("div", { class: "empty" }, "No obstacles yet."));
  for (const o of p.obstacles) {
    const editing = APP.edit === o.id;
    const chips = el("div", { class: "chips" }, ...o.pts.map((v, i) => el("span", { class: "chip" },
      typeof v === "string" ? (ents.get(v)?.name || "?")
        : el("button", { class: "link", title: "Edit coordinates", onclick: () => editVertex(o, i) }, `N ${v[1].toFixed(1)} E ${v[0].toFixed(1)}`),
      el("button", { title: "Remove", onclick: () => { o.pts.splice(i, 1); changed(true); } }, "×"))),
      sel("", [["", "+ corner at…"], { group: "Points", items: p.points.map((x) => [x.id, x.name]) }, { group: "Landmarks", items: lmOptions() }],
        (v) => { if (v) { o.pts.push(v); changed(true); } }, { style: "width:120px" }));
    out.push(el("div", { class: `card${editing ? " sel" : ""}` },
      el("div", { class: "row" },
        inp(o.name, (v) => { o.name = v; }, { style: "width:130px; font-weight:600", placeholder: "Name" }),
        sel(o.kind, Object.entries(OBSTACLE_KINDS).map(([k, t]) => [k, t.name]), (v) => { o.kind = v; o.closed = OBSTACLE_KINDS[v].closed; changed(true); }, { style: "width:150px" }),
        el("label", { class: "row calc", title: "Untick for outlines you can see over (a patio, a low deck)" }, checkbox(o.blocks, (v) => { o.blocks = v; changed(true); }), "Blocks sight"),
        el("label", { class: "row calc" }, checkbox(o.closed, (v) => { o.closed = v; changed(true); }), "Closed"),
        el("span", { class: "grow" }),
        btn(editing ? "Done" : "Draw", () => { APP.edit = editing ? null : o.id; renderPane(); }, editing ? "small primary" : "small"),
        btn("✕", () => { p.obstacles = p.obstacles.filter((x) => x !== o); if (APP.edit === o.id) APP.edit = null; changed(true); }, "small danger")),
      el("div", { style: "margin:6px 0" }, chips),
      inp(o.desc, (v) => { o.desc = v; }, { placeholder: "Description (height, material, when built…)", style: "width:100%" })));
  }
  out.push(btn("+ Add obstacle", () => {
    const o = { id: sid("O"), name: nextName(p.obstacles, "Building "), kind: "building", closed: true, blocks: true, pts: [], desc: "" };
    p.obstacles.push(o);
    APP.edit = o.id;
    changed(true);
  }));
  return out;
}

async function editVertex(o, i) {
  const v = o.pts[i];
  const t = await uiPrompt(`Corner ${i + 1}: northing, easting (${unitAbbr(APP.p)})`, `${v[1].toFixed(2)}, ${v[0].toFixed(2)}`);
  if (t === null) return;
  const m = /^\s*(-?[\d.]+)\s*[,;\s]\s*(-?[\d.]+)\s*$/.exec(t);
  if (!m || !Number.isFinite(+m[1]) || !Number.isFinite(+m[2])) { uiAlert("Enter the northing and easting separated by a comma."); return; }
  o.pts[i] = [+m[2], +m[1]];
  changed(true);
}

/** Mirror the obstacle being drawn into the map overlay. */
function syncEdit() {
  const o = APP.edit && APP.p.obstacles.find((x) => x.id === APP.edit);
  if (!o) { APP.edit = null; MAP.edit = null; MAP.onVertexDrag = null; return; }
  MAP.edit = { pts: o.pts.map((v) => (typeof v === "string" ? (APP.sol && APP.sol.coords.get(v)) || null : v)),
               free: o.pts.map((v) => typeof v !== "string"), closed: o.closed && o.pts.length >= 3 };
  MAP.onVertexDrag = (i, X, done) => {
    if (typeof o.pts[i] === "string") return;
    o.pts[i] = [round2(X[0]), round2(X[1])];
    if (done) changed(true);
    else { syncEdit(); renderMap(APP.p, APP.sol); }
  };
}

function pickObstacleVertex(X, owner) {
  const o = APP.p.obstacles.find((x) => x.id === APP.edit);
  if (!o) return;
  if (owner && entities(APP.p).has(owner) && APP.sol.coords.has(owner)) o.pts.push(owner);
  else o.pts.push([round2(X[0]), round2(X[1])]);
  changed(true);
}

// ------------------------------------------------------------------ find
function paneFind() {
  const p = APP.p, f = APP.find;
  const out = [el("h3", {}, "Find a point"),
    el("p", { class: "hint" }, "Pick what to find. The best two setups are chosen so their sight lines cross squarely, preferring setups you have already sighted from (known line of sight). Mark both lines on the ground; the point is where they cross. The tape distances give an independent check.")];
  const modes = [["point", "A point or landmark"], ["line", "Along a line"], ["coord", "Coordinates"],
    ...(APP.geo && APP.geo.ok ? [["ll", "Latitude / longitude"]] : []), ["map", "Click on the map"]];
  if (f.mode === "ll" && !(APP.geo && APP.geo.ok)) f.mode = "point";
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
  } else if (f.mode === "ll") {
    out.push(el("div", { class: "grid2" },
      field("Latitude", inp(f.lat, (v) => { const two = splitLatLon(v); if (two) { f.lat = String(two[0]); f.lon = String(two[1]); } else f.lat = v; updateFind(); }, { "data-calc": "lat" })),
      field("Longitude", inp(f.lon, (v) => { f.lon = v; updateFind(); }, { "data-calc": "lon" }))),
      el("p", { class: "hint" }, "Only as good as the georeference (a few feet with phone GPS): fine for a utility locate ticket or a spot picked on a map, not for exact work."));
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
  } else if (f.mode === "ll" && APP.geo && APP.geo.ok) {
    const la = parseLatLon(f.lat, false), lo = parseLatLon(f.lon, true);
    if (Number.isFinite(la) && Number.isFinite(lo)) { X = llToLocal(APP.geo, la, lo); label = `${fmtLat(la)}, ${fmtLon(lo)}`; }
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
  const nmO = (o) => esc(o.name || "an obstacle");
  let s = findCardHtml(p, APP.sol, r.label, r.X, r.targetId, APP.geo).replace('class="card"', 'class="card" style="background:#fff"');
  s += `<div class="section">All setups (${r.opts.options.length})</div><table class="opts"><tr><th>Set up on</th><th>Sight</th><th>Turn to</th><th class="n">Distance</th><th>Line of sight</th></tr>`;
  for (const o of r.opts.options) {
    s += `<tr><td><b>${nm(o.station)}</b></td><td>${nm(o.backsight)}</td><td>${fmtDMS(o.reading)}</td><td class="n">${fmtLen(p, o.dist)}</td>` +
         `<td>${o.blocked ? `<span class="blk">blocked by ${nmO(o.blocked)}</span>` : o.bsBlocked ? `<span class="blk">backsight blocked by ${nmO(o.bsBlocked)}</span>`
           : r.targetId ? (o.seen ? "sighted before" : "not checked") : p.obstacles.length ? "clear" : "—"}</td></tr>`;
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

async function deleteEntity(id) {
  const p = APP.p;
  const ent = entities(p).get(id);
  const uses = p.setups.reduce((n, s) => n + (s.station === id || s.backsight === id ? 1 : 0) + s.readings.filter((r) => r.target === id).length, 0);
  if (!await uiConfirm(`Delete ${ent.name || "this item"}?${uses ? ` Its ${uses} field-book entr${uses > 1 ? "ies" : "y"} will lose their target.` : ""}`, { okText: "Delete", danger: true })) return;
  p.landmarks = p.landmarks.filter((x) => x.id !== id);
  p.points = p.points.filter((x) => x.id !== id);
  for (const l of p.lines) l.pts = l.pts.filter((x) => x !== id);
  for (const o of p.obstacles) {
    o.pts = o.pts.map((v) => (v !== id ? v : APP.sol.coords.has(id) ? APP.sol.coords.get(id).map(round2) : null)).filter((v) => v !== null);
  }
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
/** Load images (so they are in the cache before printing). Resolves to the number that loaded. */
function preloadImages(urls, timeout = 20000) {
  return new Promise((resolve) => {
    let left = urls.length, ok = 0;
    if (!left) { resolve(0); return; }
    const t = setTimeout(() => resolve(ok), timeout);
    for (const u of urls) {
      const im = new Image();
      im.onload = () => { ok++; if (--left === 0) { clearTimeout(t); resolve(ok); } };
      im.onerror = () => { if (--left === 0) { clearTimeout(t); resolve(ok); } };
      im.src = u;
    }
  });
}

/** Plan sheet SVG for printing, with imagery when asked for. */
async function planPrintSvg(p, sol, G, { interactive = true } = {}) {
  const plan = renderPlan(p, sol, { geo: G });
  let svg = sheetToSvg(plan.sheet, { width: "17in", height: "11in" }).replace("<svg ", '<svg class="plan" ');
  if (p.geo.print && G && G.ok) {
    const im = planImagery(p, G, plan);
    const ok = await preloadImages(im.tiles.map((t) => t.href));
    if (interactive && ok < im.tiles.length &&
        !await uiConfirm(`${im.tiles.length - ok} of ${im.tiles.length} imagery tiles didn't load (offline?). Print anyway?`, { okText: "Print" })) return null;
    svg = svg.replace(/(<rect width="[^"]+" height="[^"]+" fill="#fff"\/>)/, (m) => m + im.svg);
  }
  return svg;
}
async function printPlan() {
  const svg = await planPrintSvg(APP.p, APP.sol, APP.geo);
  if (svg) printWith(svg, "@page { size: 17in 11in; margin: 0; }");
}
function printReport() {
  printWith(reportHtml(APP.p, APP.sol, APP.geo), "@page { size: letter; margin: 0.55in; }");
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
  $("#btnDel").addEventListener("click", async () => {
    if (!await uiConfirm(`Delete the survey "${APP.p.name}"? This can't be undone (save a JSON copy first if unsure).`, { okText: "Delete survey", danger: true })) return;
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
    } catch (err) { uiAlert("Could not read that file: " + err.message); }
  });
  $("#btnSave").addEventListener("click", () => saveFile(fileName("json"), JSON.stringify(APP.p, null, 1)));
  const menu = $(".menu");
  $("#btnExport").addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("open"); });
  document.addEventListener("click", () => menu.classList.remove("open"));
  $("#btnCsv").addEventListener("click", () => saveFile(fileName("csv"), coordinatesCsv(APP.p, APP.sol, APP.geo)));
  $("#btnKml").addEventListener("click", () => {
    if (!APP.geo || !APP.geo.ok) { uiAlert("Give at least one landmark a latitude/longitude first (Landmarks tab)."); return; }
    saveFile(fileName("kml"), siteKml(APP.p, APP.sol, APP.geo));
  });
  $("#btnDxfPlan").addEventListener("click", () => saveFile(fileName("dxf"), sheetToDxf(renderPlan(APP.p, APP.sol, { geo: APP.geo }).sheet)));
  $("#btnDxfWorld").addEventListener("click", () => saveFile(fileName("dxf").replace(".dxf", "_1to1.dxf"), worldDxf(APP.p, APP.sol)));
  if (HOSTED) {
    // a hosted page can't print: offer the plan and report as files to open and print
    $("#btnPrintPlan").textContent = "Plan (SVG)";
    $("#btnPrintPlan").title = "ANSI B plan sheet as an SVG file: open it in a browser and print at 11×17";
    $("#btnPrintReport").textContent = "Report (HTML)";
    $("#btnPrintReport").title = "Letter-size report as an HTML file: open it in a browser and print";
    $("#btnPrintPlan").addEventListener("click", () => {
      const svg = sheetToSvg(renderPlan(APP.p, APP.sol, { geo: APP.geo }).sheet, { width: "17in", height: "11in" });
      saveFile(fileName("svg").replace(".svg", "_plan.svg"), standaloneSvg(svg, APP.p.font));
    });
    $("#btnPrintReport").addEventListener("click", () =>
      saveFile(fileName("html").replace(".html", "_report.html"), standaloneReport(APP.p, reportHtml(APP.p, APP.sol, APP.geo))));
  } else {
    $("#btnPrintPlan").addEventListener("click", printPlan);
    $("#btnPrintReport").addEventListener("click", printReport);
  }
  for (const [id, k] of [["#optSights", "sights"], ["#optEll", "ellipses"], ["#optLabels", "labels"]]) {
    $(id).addEventListener("change", (e) => { MAP.opts[k] = e.target.checked; renderMap(APP.p, APP.sol); });
  }
  $("#optImg").addEventListener("change", (e) => { APP.p.geo.show = e.target.checked; save(); renderGeoTools(); renderMap(APP.p, APP.sol); });
  $("#optImgOp").addEventListener("input", (e) => { APP.p.geo.opacity = e.target.value / 100; save(); renderMap(APP.p, APP.sol); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (APP.pick || APP.edit)) { APP.pick = null; APP.edit = null; renderPane(); }
  });
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
  connectHost((list) => {
    // surveys saved in the account replace this browser's copy
    let curId = null;
    try { curId = localStorage.getItem(STORE_KEY + ".cur"); } catch (_) { /* ignore */ }
    APP.store.projects = list.map(normalizeProject);
    const i = APP.store.projects.findIndex((p) => p.id === curId);
    switchProject(i >= 0 ? i : 0);
  });
  window.SV = { APP, MAP, HOST, ask, makeZip, standaloneReport, standaloneSvg, solveProject, normalizeProject, findOptions, renderPlan, sheetToSvg, sheetToDxf, worldDxf, coordinatesCsv, reportHtml,
                parseAngle, fmtDMS, georeference, localToLL, llToLocal, parseLatLon, imageryTiles, llToPx, pxToLl, planImagery, planPrintSvg,
                siteKml, blockingShapes, sightBlocker, obstacleMessages, geoMessages, renderMap, renderPane };
})();
