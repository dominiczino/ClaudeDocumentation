/* =========================================================================
 * Host services: in-page dialogs (used everywhere), file saving, and, when
 * the page runs as a hosted claude.ai artifact (SV_HOSTED), saving surveys
 * to the viewer's account and offering files through the host.
 *
 * A hosted page can't print, start downloads itself, show alert/confirm/
 * prompt dialogs or load map tiles from other sites, so the plan and report
 * are offered as SVG and HTML files instead, and the imagery is turned off.
 * ========================================================================= */

const HOSTED = typeof SV_HOSTED !== "undefined" && !!SV_HOSTED;

// ----------------------------------------------------------------- dialogs
/**
 * Modal dialog. Resolves true/false (confirm), the entered text or null
 * (with `input`), or undefined (alert).
 */
function ask({ title = "", message = "", input = null, okText = "OK", cancelText = "Cancel", danger = false, alertOnly = false }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const field = input !== null ? el("input", { type: "text", id: "dlgInput", class: "dlg-input" }) : null;
    if (field) field.value = input;
    const done = (ok) => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(alertOnly ? undefined : field ? (ok ? field.value : null) : ok);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === "Enter" && (field ? document.activeElement === field : true)) { e.preventDefault(); done(true); }
    };
    const okBtn = el("button", { class: danger ? "danger-fill" : "primary", onclick: () => done(true) }, okText);
    const back = el("div", { class: "dlg-back", onclick: (e) => { if (e.target === back) done(false); } },
      el("div", { class: "dlg", role: "dialog", "aria-modal": "true", "aria-labelledby": "dlgTitle" },
        title ? el("h4", { id: "dlgTitle" }, title) : null,
        message ? el("p", {}, message) : null,
        field,
        el("div", { class: "dlg-buttons" }, alertOnly ? null : el("button", { onclick: () => done(false) }, cancelText), okBtn)));
    document.body.append(back);
    document.addEventListener("keydown", onKey, true);
    (field || okBtn).focus();
    if (field) field.select();
  });
}
const uiAlert = (message, title = "") => ask({ title, message, alertOnly: true });
const uiConfirm = (message, opts = {}) => ask({ message, ...opts });
const uiPrompt = (message, value = "", opts = {}) => ask({ message, input: String(value), ...opts });

// -------------------------------------------------------------------- zip
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A .zip (stored, no compression) of [{name, data: string}]. */
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4],
     [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]]
      .forEach(([o, v, n]) => (n === 4 ? head.setUint32(o, v, true) : head.setUint16(o, v, true)));
    const cen = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4],
     [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2],
     [38, 0, 4], [42, offset, 4]]
      .forEach(([o, v, n]) => (n === 4 ? cen.setUint32(o, v, true) : cen.setUint16(o, v, true)));
    parts.push(new Uint8Array(head.buffer), name, data);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cenSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, cenSize, 4], [16, offset, 4], [20, 0, 2]]
    .forEach(([o, v, n]) => (n === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true)));
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

// ------------------------------------------------------------ file saving
// extensions the host lets a page offer; other formats travel in a .zip
const HOST_EXTS = new Set("gif png jpg jpeg webp mp4 webm txt json md docx pptx epub csv ttf html svg pdf xlsx zip".split(" "));

const HOST = { db: null, col: null, downloads: null, written: new Map(), state: HOSTED ? "connecting" : "local", timer: null, busy: false };

/** Offer a file: a browser download, or through the host when hosted. `data` is a string or Blob. */
async function saveFile(name, data) {
  if (!HOSTED) {
    downloadBlob(data instanceof Blob ? data : new Blob([data]), name);
    return;
  }
  if (!HOST.downloads) {
    await uiAlert("Saving files isn't available where this page is open. Open the artifact in claude.ai to save files.", "Can't save files here");
    return;
  }
  const ext = name.split(".").pop().toLowerCase();
  let fname = name, payload = data;
  if (!HOST_EXTS.has(ext)) {
    payload = makeZip([{ name, data: data instanceof Blob ? await data.text() : data }]);
    fname = name + ".zip";
  }
  try {
    await HOST.downloads.save({ filename: fname, data: payload });
  } catch (e) {
    if (e && (e.code === "declined" || e.code === "rate_limited")) return;
    await uiAlert(`The file couldn't be saved (${(e && e.message) || e}).`, "Not saved");
  }
}

/** The embedded font faces as CSS, for files that leave the page. */
function fontFaceCss(fontKey) {
  const font = FONTS[fontKey];
  const fam = font && font.css.match(/^'([^']+)'/);
  if (!fam) return "";
  const data = JSON.parse(document.getElementById("font-data").textContent);
  return font.files.map((f, i) => `@font-face{font-family:'${fam[1]}';font-weight:${i ? 700 : 400};src:url(data:font/ttf;base64,${data[f]}) format('truetype')}`).join("");
}

/** A plan sheet SVG that stands on its own (fonts embedded). */
function standaloneSvg(svg, fontKey) {
  return svg.replace(/<svg [^>]*>/, (m) => `${m}<style>${fontFaceCss(fontKey)}</style>`);
}

/** The report as a complete HTML document, ready to open and print. */
function standaloneReport(p, html) {
  const css = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (_) { continue; }
    for (const r of rules) if (r.selectorText && /(^|,\s*)\.rep\b/.test(r.selectorText)) css.push(r.cssText);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(p.name)} — survey report</title><style>${fontFaceCss(p.font)}` +
    `@page{size:letter;margin:0.55in}body{margin:0;background:#fff}.rep{max-width:7.4in;margin:0 auto;padding:0.3in 0}` +
    `@media print{.rep{padding:0}}${css.join("\n")}</style></head><body>${html}</body></html>`;
}

// ------------------------------------------------- surveys in the account
/** Connect to the host (hosted only): file saving and the account store. `onProjects(list)` gets saved surveys. */
async function connectHost(onProjects) {
  if (!HOSTED || !window.claude || !window.claude.use) { setSaveState("local"); return; }
  try { HOST.downloads = await window.claude.use("downloads"); } catch (_) { HOST.downloads = null; }
  try {
    const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
    const uid = db && user ? await user.id() : null;
    if (!uid) { setSaveState("local"); return; }
    HOST.db = db;
    HOST.col = db.collection("data/users/" + uid);
    const snap = await HOST.col.get();
    const list = [];
    for (const d of snap.docs) {
      const body = d.data();
      try { list.push({ order: Number(body.order) || 0, p: JSON.parse(body.json) }); HOST.written.set(d.id, body.json); } catch (_) { /* skip a bad row */ }
    }
    list.sort((a, b) => a.order - b.order);
    setSaveState("account");
    if (list.length) onProjects(list.map((x) => x.p));
  } catch (e) {
    HOST.col = null;
    setSaveState("local");
  }
}

function setSaveState(s) {
  HOST.state = s;
  const n = document.getElementById("saveState");
  if (!n) return;
  const txt = { local: HOSTED ? "Saved in this browser only" : "", connecting: "Connecting…", account: "Saved to your account",
                saving: "Saving…", error: "Not saved to your account" }[s];
  n.textContent = txt;
  n.className = `save-state ${s}`;
  n.title = s === "local" && HOSTED ? "Your surveys are kept in this browser. Use Save JSON for a backup." :
            s === "error" ? "The last change couldn't be saved to your account. It is kept in this browser; use Save JSON for a backup." : "";
}

/** Write changed surveys to the account (debounced; one write at a time). */
function hostSave(store) {
  if (!HOST.col) return;
  clearTimeout(HOST.timer);
  HOST.timer = setTimeout(() => flushHost(store), 1200);
}
async function flushHost(store) {
  if (HOST.busy) { hostSave(store); return; }
  HOST.busy = true;
  try {
    let wrote = false;
    for (const [i, p] of store.projects.entries()) {
      const json = JSON.stringify(p);
      if (HOST.written.get(p.id) === json) continue;
      if (!wrote) { setSaveState("saving"); wrote = true; }
      await HOST.col.doc(p.id).set({ order: i, updated: new Date().toISOString(), json });
      HOST.written.set(p.id, json);
    }
    const ids = new Set(store.projects.map((p) => p.id));
    for (const id of [...HOST.written.keys()]) {
      if (ids.has(id)) continue;
      await HOST.col.doc(id).delete();
      HOST.written.delete(id);
    }
    setSaveState("account");
  } catch (e) {
    setSaveState("error");
  } finally {
    HOST.busy = false;
  }
}
