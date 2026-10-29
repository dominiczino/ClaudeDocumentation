/* =========================================================================
 * Host services: in-page dialogs (used everywhere), file saving, and, when
 * the page runs as a hosted claude.ai artifact (APP_HOSTED), saving the
 * trees to the viewer's account and offering files through the host.
 *
 * A hosted page can't print, start downloads itself, or show alert/
 * confirm/prompt dialogs, so the sheet is offered as an SVG file to open
 * and print, and dialogs are drawn in the page.
 * ========================================================================= */

const HOSTED = typeof APP_HOSTED !== "undefined" && !!APP_HOSTED;

function hEl(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
}

(function hostCss() {
  const css = `
.dlg-back { position: fixed; inset: 0; background: rgba(15, 22, 30, .45); display: flex; align-items: center; justify-content: center; z-index: 1000;
  padding: max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px)); }
.dlg { background: #fff; color: #1d232b; border-radius: 10px; padding: 18px 20px 16px; width: min(440px, 100%); box-shadow: 0 12px 40px rgba(0,0,0,.25); font: 14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.dlg h4 { margin: 0 0 8px; font-size: 15px; }
.dlg p { margin: 0 0 12px; line-height: 1.45; }
.dlg .dlg-input { width: 100%; box-sizing: border-box; margin-bottom: 12px; font: inherit; padding: 5px 7px; border: 1px solid #c9cfd6; border-radius: 5px; }
.dlg-buttons { display: flex; justify-content: flex-end; gap: 8px; }
.dlg-buttons button { font: inherit; border: 1px solid #c9cfd6; background: #fff; color: #1d232b; border-radius: 5px; padding: 5px 12px; cursor: pointer; }
.dlg-buttons button.ok { background: #1f5fa8; border-color: #1f5fa8; color: #fff; font-weight: 600; }
.dlg-buttons button.ok.danger { background: #a3302a; border-color: #a3302a; }
.dlg-buttons button:focus-visible { outline: 2px solid #9cc0ea; outline-offset: 1px; }
.save-state { font-size: 11.5px; color: #aab6c3; white-space: nowrap; }
.save-state.error { color: #f0b36a; }
[hidden] { display: none !important; }`;
  document.head.append(hEl("style", {}, css));
})();

// ----------------------------------------------------------------- dialogs
/** Modal dialog: resolves true/false (confirm), the text or null (input), or undefined (alert). */
function ask({ title = "", message = "", input = null, okText = "OK", cancelText = "Cancel", danger = false, alertOnly = false }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const field = input !== null ? hEl("input", { type: "text", id: "dlgInput", class: "dlg-input" }) : null;
    if (field) field.value = input;
    let back = null;
    const done = (ok) => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(alertOnly ? undefined : field ? (ok ? field.value : null) : ok);
    };
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      else if (e.key === "Enter") { e.preventDefault(); done(true); }
    };
    const okBtn = hEl("button", { class: `ok${danger ? " danger" : ""}`, onclick: () => done(true) }, okText);
    back = hEl("div", { class: "dlg-back", onclick: (e) => { if (e.target === back) done(false); } },
      hEl("div", { class: "dlg", role: "dialog", "aria-modal": "true" },
        title ? hEl("h4", {}, title) : null,
        message ? hEl("p", {}, message) : null,
        field,
        hEl("div", { class: "dlg-buttons" }, alertOnly ? null : hEl("button", { onclick: () => done(false) }, cancelText), okBtn)));
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
  const put = (view, fields) => fields.forEach(([o, v, n]) => (n === 4 ? view.setUint32(o, v, true) : view.setUint16(o, v, true)));
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    put(head, [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4],
               [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]]);
    const cen = new DataView(new ArrayBuffer(46));
    put(cen, [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4],
              [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2],
              [38, 0, 4], [42, offset, 4]]);
    parts.push(new Uint8Array(head.buffer), name, data);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cenSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  put(end, [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, cenSize, 4], [16, offset, 4], [20, 0, 2]]);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

// ------------------------------------------------------------ file saving
// extensions the host lets a page offer; other formats (DXF) travel in a .zip
const HOST_EXTS = new Set("gif png jpg jpeg webp mp4 webm txt json md docx pptx epub csv ttf html svg pdf xlsx zip".split(" "));
const HOST = { col: null, uid: null, downloads: null, written: "", parts: 0, state: HOSTED ? "connecting" : "local", timer: null, busy: false };

/** Offer a file: a browser download, or through the host when hosted. `data` is a string or Blob. */
async function saveFile(name, data) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  if (!HOSTED) {
    const a = hEl("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return true;
  }
  if (!HOST.downloads) {
    await uiAlert("Saving files isn't available where this page is open. Open the artifact in claude.ai to save files.", "Can't save files here");
    return false;
  }
  const ext = name.split(".").pop().toLowerCase();
  let fname = name, payload = blob;
  if (!HOST_EXTS.has(ext)) { payload = makeZip([{ name, data: await blob.text() }]); fname = name + ".zip"; }
  try {
    await HOST.downloads.save({ filename: fname, data: payload });
    return true;
  } catch (e) {
    if (e && (e.code === "declined" || e.code === "rate_limited")) return false;
    await uiAlert(`The file couldn't be saved (${(e && e.message) || e}).`, "Not saved");
    return false;
  }
}

/** @font-face CSS for an embedded font (font = an entry of FONTS), for files that leave the page. */
function fontFaceCss(font) {
  const fam = font && font.css.match(/^'([^']+)'/);
  if (!fam) return "";
  const data = JSON.parse(document.getElementById("font-data").textContent);
  return font.files.map((f, i) => `@font-face{font-family:'${fam[1]}';font-weight:${i ? 700 : 400};src:url(data:font/ttf;base64,${data[f]}) format('truetype')}`).join("");
}

/** A sheet SVG that stands on its own (fonts embedded), to open and print. */
function standaloneSvg(svg, font) {
  return svg.replace(/<svg [^>]*>/, (m) => `${m}<style>${fontFaceCss(font)}</style>`);
}

// ----------------------------------------------- the store in the account
// The whole store is kept as JSON text split over documents
// data/users/<id>/store-<n> (each well under the 256 KiB document limit).
const CHUNK = 180000;

/** Hosted only: connect file saving and the account store. `onLoad(store)` gets the saved store. */
async function connectHost(onLoad) {
  if (!HOSTED || !window.claude || !window.claude.use) { setSaveState("local"); return; }
  try { HOST.downloads = await window.claude.use("downloads"); } catch (_) { HOST.downloads = null; }
  try {
    const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
    const uid = db && user ? await user.id() : null;
    if (!uid) { setSaveState("local"); return; }
    HOST.col = db.collection("data/users/" + uid);
    const snap = await HOST.col.get();
    const parts = snap.docs.filter((d) => /^store-\d+$/.test(d.id)).map((d) => d.data())
      .sort((a, b) => a.part - b.part);
    const rev = parts.length ? parts[0].rev : null;
    const ok = parts.length && parts.length === parts[0].of && parts.every((x, i) => x.part === i && x.rev === rev);
    setSaveState("account");
    if (ok) {
      const text = parts.map((x) => x.text).join("");
      HOST.written = text; HOST.parts = parts.length;
      onLoad(JSON.parse(text));
    } else HOST.parts = parts.length;
  } catch (_) {
    HOST.col = null;
    setSaveState("local");
  }
}

function setSaveState(s) {
  HOST.state = s;
  const n = document.getElementById("saveState");
  if (!n) return;
  n.textContent = { local: HOSTED ? "Saved in this browser only" : "", connecting: "Connecting…", account: "Saved to your account",
                    saving: "Saving…", error: "Not saved to your account" }[s];
  n.className = `save-state ${s}`;
  n.title = s === "error" ? "The last change couldn't be saved to your account. It is kept in this browser; use Save JSON for a backup." :
            s === "local" && HOSTED ? "Your work is kept in this browser. Use Save JSON for a backup." : "";
}

/** Save the store to the account after a pause (one write at a time). `text` is its JSON. */
function hostSave(text) {
  if (!HOST.col) return;
  HOST.pending = text;
  clearTimeout(HOST.timer);
  HOST.timer = setTimeout(flushHost, 1200);
}
async function flushHost() {
  if (HOST.busy) { HOST.timer = setTimeout(flushHost, 600); return; }
  const text = HOST.pending;
  if (text == null || text === HOST.written) return;
  HOST.busy = true;
  setSaveState("saving");
  try {
    const rev = Date.now().toString(36);
    const n = Math.max(1, Math.ceil(text.length / CHUNK));
    for (let i = 0; i < n; i++) await HOST.col.doc(`store-${i}`).set({ part: i, of: n, rev, text: text.slice(i * CHUNK, (i + 1) * CHUNK) });
    for (let i = n; i < HOST.parts; i++) await HOST.col.doc(`store-${i}`).delete();
    HOST.written = text; HOST.parts = n;
    setSaveState("account");
  } catch (_) {
    setSaveState("error");
  } finally {
    HOST.busy = false;
  }
}
