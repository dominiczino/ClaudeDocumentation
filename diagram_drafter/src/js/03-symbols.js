/* =========================================================================
 * Symbol libraries.
 *
 * Each symbol is drawn in its canonical orientation, in inches, around its
 * insertion point:
 *   one-line ("ol"):  power flows DOWN  (line side N, load side S)
 *   P&ID     ("pid"): flow goes RIGHT   (inlet W, outlet E)
 * Ports: {id, x, y, dir: N|S|E|W, role: in|out|io}. Bus symbols have
 * `bus: true` ports that attach anywhere along the bus.
 * ========================================================================= */

const LIB_FLOW = { ol: [0, -1], pid: [1, 0] };
const SYMBOLS = {};
const PALETTE = { ol: [], pid: [] };

/**
 * def: {id, lib, name, cat, box(n) | box, ports(n) | ports, draw(g, n, doc),
 *       props: [{k, label, type, options, def}], spec(n) -> [lines],
 *       tag: auto-tag prefix, source, satellite, bus, inner (prop key drawn inside)}
 */
function defSym(def) {
  def.props = def.props || [];
  if (typeof def.box !== "function") { const b = def.box; def.box = () => b; }
  if (typeof def.ports !== "function") { const p = def.ports; def.ports = () => p; }
  def.spec = def.spec || (() => []);
  SYMBOLS[def.id] = def;
  return def;
}

/** Palette entry: a symbol with preset properties. */
function pal(lib, cat, sym, name, props = {}, extra = {}) {
  PALETTE[lib].push({ cat, sym, name, props, ...extra });
}

const P = (id, x, y, dir, role = "io", extra = {}) => ({ id, x, y, dir, role, ...extra });
const join = (...xs) => xs.filter((x) => x !== "" && x != null).join(" ");
const unit = (v, u) => (v === "" || v == null ? "" : `${v}${u}`);

// ----------------------------------------------------------- shared shapes
function leadV(g, y0, y1) { g.line(0, y0, 0, y1); }
function leadH(g, x0, x1) { g.line(x0, 0, x1, 0); }

function bowtie(g, w = 0.15, h = 0.09) {
  g.poly([[-w, h], [-w, -h], [w, h], [w, -h]], true);
}

function zigzag(g, x0, y0, x1, y1, n, amp) {
  // zigzag along the segment (x0,y0)-(x1,y1)
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const pts = [[x0, y0]];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n, s = i % 2 ? -1 : 1;
    pts.push([x0 + dx * t + nx * amp * s, y0 + dy * t + ny * amp * s]);
  }
  pts.push([x1, y1]);
  g.poly(pts);
}

function groundBars(g, y) {
  g.line(-0.125, y, 0.125, y);
  g.line(-0.08, y - 0.045, 0.08, y - 0.045);
  g.line(-0.035, y - 0.09, 0.035, y - 0.09);
}

function arrowHead(g, x, y, dx, dy, len = 0.09, half = 0.035) {
  const nx = -dy, ny = dx;
  g.fill([[x, y], [x - dx * len + nx * half, y - dy * len + ny * half], [x - dx * len - nx * half, y - dy * len - ny * half]]);
}

const AMPS = { k: "amps", label: "Rating (A)", type: "text", def: "" };
const POLES = { k: "poles", label: "Poles", type: "select", options: ["", "1P", "2P", "3P", "4P"], def: "2P" };
const VOLTS = { k: "volts", label: "Voltage", type: "text", def: "" };

// =================================================================== ONE-LINE
defSym({
  id: "ol-utility", lib: "ol", name: "Utility service", source: true, primary: true,
  box: [-0.4375, -0.25, 0.4375, 0.1875],
  ports: [P("S", 0, -0.25, "S", "out")],
  props: [{ k: "service", label: "Service", type: "text", def: "120/240V 1Φ 3W" },
          { k: "utility", label: "Utility / account", type: "text", def: "" }],
  spec: (n) => [n.props.utility, n.props.service],
  draw(g) {
    g.rect(-0.4375, -0.1875, 0.4375, 0.1875, 0.03);
    g.fitText("UTILITY", 0, 0, 0.75, 0.1, true);
    leadV(g, -0.1875, -0.25);
  },
});

defSym({
  id: "ol-meter", lib: "ol", name: "Meter",
  box: [-0.1875, -0.25, 0.1875, 0.25],
  ports: [P("N", 0, 0.25, "N", "in"), P("S", 0, -0.25, "S", "out")],
  props: [{ k: "mark", label: "Symbol text", type: "select", options: ["M", "kWh", "CT"], def: "M" }],
  draw(g, n) {
    g.circle(0, 0, 0.1875);
    g.fitText(n.props.mark || "M", 0, 0, 0.26, 0.11, true);
    leadV(g, 0.1875, 0.25); leadV(g, -0.1875, -0.25);
  },
});

const BREAKER_PROPS = [AMPS, POLES,
  { k: "type", label: "Type", type: "select", options: ["", "GFCI", "AFCI", "DF", "GFP", "LSI", "LSIG", "BACKFEED"], def: "" },
  { k: "frame", label: "Frame (AF)", type: "text", def: "" }];
const breakerSpec = (n) => [
  [unit(n.props.amps, "A"), n.props.poles].filter(Boolean).join("/"),
  join(n.props.frame ? `${n.props.frame}AF` : "", n.props.type),
];

defSym({
  id: "ol-breaker", lib: "ol", name: "Circuit breaker",
  box: [-0.03, -0.25, 0.1, 0.25],
  ports: [P("N", 0, 0.25, "N", "in"), P("S", 0, -0.25, "S", "out")],
  props: BREAKER_PROPS, spec: breakerSpec,
  draw(g) {
    leadV(g, 0.25, 0.125); leadV(g, -0.125, -0.25);
    g.poly([[0, 0.125, 0.6], [0, -0.125]]);
  },
});

defSym({
  id: "ol-cb-box", lib: "ol", name: "Power breaker (box)",
  box: [-0.125, -0.25, 0.125, 0.25],
  ports: [P("N", 0, 0.25, "N", "in"), P("S", 0, -0.25, "S", "out")],
  props: BREAKER_PROPS, spec: breakerSpec,
  draw(g) {
    g.rect(-0.125, -0.125, 0.125, 0.125);
    leadV(g, 0.25, 0.125); leadV(g, -0.125, -0.25);
  },
});

defSym({
  id: "ol-fuse", lib: "ol", name: "Fuse",
  box: [-0.0625, -0.25, 0.0625, 0.25],
  ports: [P("N", 0, 0.25, "N", "in"), P("S", 0, -0.25, "S", "out")],
  props: [AMPS, { k: "cls", label: "Class", type: "text", def: "" }],
  spec: (n) => [join(unit(n.props.amps, "A"), n.props.cls)],
  draw(g) {
    g.rect(-0.0625, -0.15, 0.0625, 0.15);
    g.line(0, 0.25, 0, -0.25);
  },
});

const SWITCH_PROPS = [AMPS, POLES, { k: "fuse", label: "Fuse (A)", type: "text", def: "" },
  { k: "enc", label: "Enclosure", type: "text", def: "" }];
const switchSpec = (n) => [join(unit(n.props.amps, "A"), n.props.poles, n.props.fuse ? `FUSED ${n.props.fuse}A` : "NF"),
  n.props.enc];

defSym({
  id: "ol-switch", lib: "ol", name: "Disconnect switch",
  box: [-0.03, -0.25, 0.15, 0.25],
  ports: [P("N", 0, 0.25, "N", "in"), P("S", 0, -0.25, "S", "out")],
  props: SWITCH_PROPS, spec: switchSpec,
  draw(g) {
    leadV(g, 0.25, 0.11); leadV(g, -0.11, -0.25);
    g.circle(0, 0.11, 0.022);
    g.line(0, -0.11, 0.13, 0.09);
    g.dot(0, -0.11, 0.022);
  },
});

defSym({
  id: "ol-fused-switch", lib: "ol", name: "Fused disconnect",
  box: [-0.0625, -0.4375, 0.15, 0.4375],
  ports: [P("N", 0, 0.4375, "N", "in"), P("S", 0, -0.4375, "S", "out")],
  props: SWITCH_PROPS.map((p) => (p.k === "fuse" ? { ...p, def: "" } : p)), spec: switchSpec,
  draw(g) {
    leadV(g, 0.4375, 0.27); g.circle(0, 0.27, 0.022);
    g.line(0, 0.04, 0.13, 0.25); g.dot(0, 0.04, 0.022);
    leadV(g, 0.04, -0.4375);
    g.rect(-0.0625, -0.34, 0.0625, -0.08);
  },
});

defSym({
  id: "ol-transformer", lib: "ol", name: "Transformer", tag: "T",
  box: [-0.15, -0.375, 0.15, 0.375],
  ports: [P("N", 0, 0.375, "N", "in"), P("S", 0, -0.375, "S", "out")],
  props: [{ k: "kva", label: "kVA", type: "text", def: "" },
          { k: "pri", label: "Primary", type: "text", def: "" },
          { k: "sec", label: "Secondary", type: "text", def: "" },
          { k: "conn", label: "Connection", type: "text", def: "" }],
  spec: (n) => [unit(n.props.kva, " kVA"), [n.props.pri, n.props.sec].filter(Boolean).join(" - "), n.props.conn],
  draw(g) {
    g.circle(0, 0.12, 0.15); g.circle(0, -0.12, 0.15);
    leadV(g, 0.27, 0.375); leadV(g, -0.27, -0.375);
  },
});

defSym({
  id: "ol-generator", lib: "ol", name: "Generator", tag: "G", source: true,
  box: [-0.25, -0.375, 0.25, 0.25],
  ports: [P("S", 0, -0.375, "S", "out")],
  props: [{ k: "kw", label: "kW", type: "text", def: "" }, VOLTS,
          { k: "fuel", label: "Fuel", type: "text", def: "" }],
  spec: (n) => [unit(n.props.kw, " kW"), n.props.volts, n.props.fuel],
  draw(g) {
    g.circle(0, 0, 0.25);
    g.text("G", 0, 0, 0.16, "MC", true);
    leadV(g, -0.25, -0.375);
  },
});

defSym({
  id: "ol-pv", lib: "ol", name: "PV array", tag: "PV", source: true,
  box: [-0.3125, -0.3125, 0.3125, 0.25],
  ports: [P("S", 0, -0.3125, "S", "out")],
  props: [{ k: "kw", label: "kW DC", type: "text", def: "" },
          { k: "modules", label: "Modules", type: "text", def: "" }],
  spec: (n) => [unit(n.props.kw, " kW DC"), n.props.modules],
  draw(g) {
    g.rect(-0.3125, -0.1875, 0.3125, 0.1875);
    for (const x of [-0.104, 0.104]) g.line(x, -0.1875, x, 0.1875);
    g.line(-0.3125, 0, 0.3125, 0);
    g.line(-0.3125, 0.1875, -0.18, 0.25);
    leadV(g, -0.1875, -0.3125);
  },
});

defSym({
  id: "ol-inverter", lib: "ol", name: "Inverter", tag: "INV",
  box: [-0.2, -0.3125, 0.2, 0.3125],
  ports: [P("N", 0, 0.3125, "N", "in"), P("S", 0, -0.3125, "S", "out")],
  props: [{ k: "kw", label: "kW AC", type: "text", def: "" }, VOLTS,
          { k: "kind", label: "Type", type: "text", def: "" }],
  spec: (n) => [unit(n.props.kw, " kW"), n.props.volts, n.props.kind],
  draw(g) {
    g.rect(-0.2, -0.2, 0.2, 0.2);
    g.line(-0.2, -0.2, 0.2, 0.2);
    g.text("=", -0.09, 0.085, 0.09, "MC", true);
    g.text("~", 0.09, -0.085, 0.09, "MC", true);
    leadV(g, 0.2, 0.3125); leadV(g, -0.2, -0.3125);
  },
});

defSym({
  id: "ol-battery", lib: "ol", name: "Battery / ESS", tag: "ESS",
  box: [-0.15, -0.25, 0.15, 0.25],
  ports: [P("N", 0, 0.25, "N", "io"), P("S", 0, -0.25, "S", "io")],
  props: [{ k: "kwh", label: "kWh", type: "text", def: "" }, VOLTS],
  spec: (n) => [unit(n.props.kwh, " kWh"), n.props.volts],
  draw(g) {
    const ys = [0.09, 0.03, -0.03, -0.09];
    ys.forEach((y, i) => g.line(i % 2 ? -0.07 : -0.15, y, i % 2 ? 0.07 : 0.15, y));
    leadV(g, 0.09, 0.25); leadV(g, -0.09, -0.25);
  },
});

defSym({
  id: "ol-ats", lib: "ol", name: "Transfer switch", tag: "ATS",
  box: [-0.375, -0.375, 0.375, 0.375],
  ports: [P("N1", -0.25, 0.375, "N", "in"), P("N2", 0.25, 0.375, "N", "in"), P("S", 0, -0.375, "S", "out")],
  props: [AMPS, POLES, { k: "kind", label: "Type", type: "select", options: ["ATS", "MTS", "INTERLOCK"], def: "ATS" }],
  spec: (n) => [join(unit(n.props.amps, "A"), n.props.poles, n.props.kind)],
  draw(g) {
    g.rect(-0.375, -0.25, 0.375, 0.25, 0.03);
    leadV(g, -0.25, -0.375);
    for (const x of [-0.25, 0.25]) { g.line(x, 0.375, x, 0.08); g.circle(x, 0.08, 0.022); }
    g.line(0, -0.25, 0, -0.12); g.dot(0, -0.12, 0.022);
    g.line(0, -0.12, -0.23, 0.07);
    g.text("N", -0.25, 0.17, 0.065, "MC");
    g.text("E", 0.25, 0.17, 0.065, "MC");
  },
});

defSym({
  id: "ol-bus", lib: "ol", name: "Panelboard / bus", bus: true, defLen: 2.0,
  box: (n) => { const L = n.len || 2; return [-L / 2, -0.04, L / 2, 0.04]; },
  ports: [P("line", 0, 0, "N", "in", { bus: true }), P("load", 0, 0, "S", "out", { bus: true })],
  props: [{ k: "kind", label: "Type", type: "select", options: ["PANELBOARD", "LOAD CENTER", "SWITCHBOARD", "MCC", "BUS"], def: "PANELBOARD" },
          { k: "amps", label: "Bus rating (A)", type: "text", def: "" },
          { k: "main", label: "Main", type: "text", def: "" },
          VOLTS,
          { k: "ckts", label: "Circuits / spaces", type: "text", def: "" }],
  spec: (n) => [join(unit(n.props.amps, "A"), n.props.main), n.props.volts, unit(n.props.ckts, " CKT")],
  draw(g, n) { const L = n.len || 2; g.line(-L / 2, 0, L / 2, 0, "BUS"); },
});

defSym({
  id: "ol-motor", lib: "ol", name: "Motor", tag: "M",
  box: [-0.1875, -0.1875, 0.1875, 0.25],
  ports: [P("N", 0, 0.25, "N", "in")],
  props: [{ k: "hp", label: "HP", type: "text", def: "" }, VOLTS],
  spec: (n) => [unit(n.props.hp, " HP"), n.props.volts],
  draw(g) {
    g.circle(0, 0, 0.1875);
    g.text("M", 0, 0, 0.12, "MC", true);
    leadV(g, 0.1875, 0.25);
  },
});

/** Width of bold symbol text in the drawing's font (palette previews use the default font). */
const symTextW = (t, h, doc) => textWidth(String(t || ""), h, true, doc ? docFont(doc) : FONTS[DEFAULT_FONT]);
const BOX_TEXT_H = 0.09;
const MIN_SYM_TEXT = 0.065; // smallest text inside symbols, on paper

/**
 * Box with text inside that grows to fit the text. ports: [{id, side, role, lead}].
 * base: minimum half width / half height of the box.
 */
const boxSym = (id, lib, name, inner, ports, base, extra = {}) => {
  // text stays at least MIN_SYM_TEXT tall on paper even when symbols are scaled down
  const hw = (n, doc) => {
    const s = doc ? doc.symScale : 1;
    const h = Math.max(BOX_TEXT_H, MIN_SYM_TEXT / s);
    return Math.max(base.hw, symTextW(n.props.name ?? inner, h, doc) / 2 + 0.09);
  };
  const portsOf = (n, doc) => {
    const w = hw(n, doc);
    return ports.map((p) => {
      const off = { N: [0, base.hh + p.lead], S: [0, -base.hh - p.lead], E: [w + p.lead, 0], W: [-w - p.lead, 0] }[p.side];
      return P(p.id, off[0], off[1], p.side, p.role);
    });
  };
  return defSym({
    id, lib, name, inner: "name",
    box: (n, doc) => { const w = hw(n, doc); return [-w, -base.hh, w, base.hh]; },
    ports: portsOf,
    props: [{ k: "name", label: "Text in box", type: "text", def: inner },
            { k: "rating", label: "Rating", type: "text", def: "" }, ...(extra.props || [])],
    spec: (n) => [n.props.rating],
    draw(g, n, doc) {
      const w = hw(n, doc);
      g.rect(-w, -base.hh, w, base.hh, 0.03);
      g.fitText(n.props.name ?? inner, 0, 0, 2 * w - 0.1, Math.max(BOX_TEXT_H, MIN_SYM_TEXT / g.s), true);
      for (const p of portsOf(n, doc)) {
        const bx = clamp(p.x, -w, w), by = clamp(p.y, -base.hh, base.hh);
        if (Math.hypot(p.x - bx, p.y - by) > 1e-6) g.line(bx, by, p.x, p.y);
      }
    },
    ...extra,
  });
};

boxSym("ol-load", "ol", "Load / equipment", "LOAD", [{ id: "N", side: "N", role: "in", lead: 0.0625 }],
  { hw: 0.375, hh: 0.1875 });
boxSym("ol-device", "ol", "Inline device", "VFD",
  [{ id: "N", side: "N", role: "in", lead: 0.125 }, { id: "S", side: "S", role: "out", lead: 0.125 }],
  { hw: 0.3125, hh: 0.1875 });

defSym({
  id: "ol-spd", lib: "ol", name: "Surge protector",
  box: [-0.15, -0.31, 0.15, 0.25],
  ports: [P("N", 0, 0.25, "N", "in")],
  props: [{ k: "kind", label: "Type", type: "text", def: "TYPE 2" }],
  spec: (n) => [n.props.kind],
  draw(g) {
    g.rect(-0.15, -0.09, 0.15, 0.09, 0.02);
    g.fitText("SPD", 0, 0, 0.24, 0.07, true);
    leadV(g, 0.09, 0.25); leadV(g, -0.09, -0.18);
    groundBars(g, -0.18);
  },
});

defSym({
  id: "ol-ground", lib: "ol", name: "Ground / electrode",
  box: [-0.125, -0.0975, 0.125, 0.1875],
  ports: [P("N", 0, 0.1875, "N", "in")],
  props: [{ k: "kind", label: "Electrode", type: "text", def: "" }],
  spec: (n) => [n.props.kind],
  draw(g) { leadV(g, 0.1875, 0); groundBars(g, 0); },
});

defSym({
  id: "ol-junction", lib: "ol", name: "Tap / junction", junction: true,
  box: [-0.035, -0.035, 0.035, 0.035],
  ports: [P("N", 0, 0, "N"), P("S", 0, 0, "S"), P("E", 0, 0, "E"), P("W", 0, 0, "W")],
  draw(g) { g.dot(0, 0, 0.035); },
});

defSym({
  id: "ol-offpage", lib: "ol", name: "Off-sheet connector",
  box: [-0.3125, -0.15, 0.3125, 0.25],
  ports: [P("N", 0, 0.25, "N", "in")],
  props: [{ k: "ref", label: "Reference", type: "text", def: "SEE E-102" }],
  draw(g, n) {
    g.poly([[-0.3125, 0.125], [0.3125, 0.125], [0.3125, -0.05], [0, -0.15], [-0.3125, -0.05]], true);
    g.fitText(n.props.ref || "", 0, 0.035, 0.55, 0.075, true);
    leadV(g, 0.125, 0.25);
  },
});

defSym({
  id: "ol-contactor", lib: "ol", name: "Contactor", tag: "C",
  box: [-0.1, -0.25, 0.1, 0.25],
  ports: [P("N", 0, 0.25, "N", "in"), P("S", 0, -0.25, "S", "out")],
  props: [AMPS, { k: "coil", label: "Coil", type: "text", def: "" }],
  spec: (n) => [unit(n.props.amps, "A"), n.props.coil ? `COIL ${n.props.coil}` : ""],
  draw(g) {
    leadV(g, 0.25, 0.06); leadV(g, -0.06, -0.25);
    g.line(-0.1, 0.06, 0.1, 0.06); g.line(-0.1, -0.06, 0.1, -0.06);
  },
});

defSym({
  id: "ol-ct", lib: "ol", name: "Current transformer",
  box: [-0.08, -0.1875, 0.08, 0.1875],
  ports: [P("N", 0, 0.1875, "N", "in"), P("S", 0, -0.1875, "S", "out")],
  props: [{ k: "ratio", label: "Ratio", type: "text", def: "" }],
  spec: (n) => [n.props.ratio],
  draw(g) { leadV(g, 0.1875, -0.1875); g.circle(0, 0, 0.08); },
});

// one-line palette
pal("ol", "Sources", "ol-utility", "Utility service");
pal("ol", "Sources", "ol-generator", "Generator");
pal("ol", "Sources", "ol-pv", "PV array");
pal("ol", "Sources", "ol-battery", "Battery / ESS");
pal("ol", "Distribution", "ol-meter", "Meter");
pal("ol", "Distribution", "ol-bus", "Panelboard / bus", { kind: "PANELBOARD" });
pal("ol", "Distribution", "ol-ats", "Transfer switch");
pal("ol", "Distribution", "ol-transformer", "Transformer");
pal("ol", "Distribution", "ol-inverter", "Inverter");
pal("ol", "Protection", "ol-breaker", "Circuit breaker");
pal("ol", "Protection", "ol-cb-box", "Power breaker (box)");
pal("ol", "Protection", "ol-fuse", "Fuse");
pal("ol", "Protection", "ol-switch", "Disconnect (non-fused)");
pal("ol", "Protection", "ol-fused-switch", "Fused disconnect");
pal("ol", "Protection", "ol-spd", "Surge protector");
pal("ol", "Protection", "ol-contactor", "Contactor");
pal("ol", "Protection", "ol-ct", "Current transformer");
for (const [name, inner] of [["Load (generic)", "LOAD"], ["EV charger", "EVSE"], ["A/C condenser", "A/C"],
  ["Heat pump", "HEAT PUMP"], ["Water heater", "WH"], ["Range", "RANGE"], ["Dryer", "DRYER"],
  ["Pool / spa", "SPA"], ["Well pump", "WELL PUMP"], ["Lighting", "LTG"], ["Receptacles", "RECEPT"]]) {
  pal("ol", "Loads", "ol-load", name, { name: inner });
}
pal("ol", "Loads", "ol-motor", "Motor");
for (const [name, inner] of [["VFD", "VFD"], ["UPS", "UPS"], ["Soft starter", "SOFT START"],
  ["PV combiner", "COMBINER"], ["Rapid shutdown", "RSD"], ["Microgrid interconnect", "MID"],
  ["Charge controller", "CHG CTRL"], ["Device (generic)", "DEVICE"]]) {
  pal("ol", "Inline devices", "ol-device", name, { name: inner });
}
pal("ol", "Other", "ol-ground", "Ground / electrode");
pal("ol", "Other", "ol-junction", "Tap / junction");
pal("ol", "Other", "ol-offpage", "Off-sheet connector");

// ======================================================================= P&ID
const VALVE_W = 0.25; // port offset of inline valves
const valvePorts = [P("W", -VALVE_W, 0, "W", "in"), P("E", VALVE_W, 0, "E", "out")];
const SIZE = { k: "size", label: "Size", type: "text", def: "" };
const valveSpec = (n) => [n.props.size, n.props.note];
const VALVE_PROPS = [SIZE, { k: "note", label: "Note", type: "text", def: "" }];

function valve(id, name, extraDraw, box = [-VALVE_W, -0.09, VALVE_W, 0.09], extra = {}) {
  return defSym({
    id, lib: "pid", name, box, ports: valvePorts, props: VALVE_PROPS, spec: valveSpec,
    draw(g, n) {
      leadH(g, -VALVE_W, -0.15); leadH(g, 0.15, VALVE_W);
      if (extraDraw) extraDraw(g, n);
    },
    ...extra,
  });
}

valve("pid-gate", "Gate valve", (g) => bowtie(g));
valve("pid-globe", "Globe valve", (g) => { bowtie(g); g.dot(0, 0, 0.035); });
valve("pid-ball", "Ball valve", (g) => { bowtie(g); g.circle(0, 0, 0.05); });
valve("pid-butterfly", "Butterfly valve", (g) => {
  leadH(g, -0.15, 0.15);
  g.line(-0.09, -0.1, -0.09, 0.1); g.line(0.09, -0.1, 0.09, 0.1);
  g.line(-0.06, -0.08, 0.06, 0.08); g.dot(0, 0, 0.025);
}, [-VALVE_W, -0.1, VALVE_W, 0.1]);
valve("pid-check", "Check valve", (g) => {
  g.poly([[-0.13, 0.09], [-0.13, -0.09], [0.07, 0]], true);
  g.line(0.07, 0.09, 0.07, -0.09);
  leadH(g, 0.07, 0.15);
});
valve("pid-balance", "Balancing valve", (g) => {
  bowtie(g);
  g.line(-0.12, -0.13, 0.1, 0.11);
  arrowHead(g, 0.12, 0.13, 0.707, 0.707, 0.07, 0.03);
}, [-VALVE_W, -0.13, VALVE_W, 0.13]);
valve("pid-control", "Control valve", (g, n) => {
  bowtie(g);
  g.line(0, 0, 0, 0.2);
  g.poly([[-0.12, 0.2, -1], [0.12, 0.2]]);
  g.line(-0.12, 0.2, 0.12, 0.2);
}, [-VALVE_W, -0.09, VALVE_W, 0.32]);
valve("pid-solenoid", "Solenoid valve", (g) => {
  bowtie(g); g.line(0, 0, 0, 0.15);
  g.rect(-0.08, 0.15, 0.08, 0.29); g.text("S", 0, 0.22, 0.07, "MC", true);
}, [-VALVE_W, -0.09, VALVE_W, 0.29]);
valve("pid-motorized", "Motorized valve", (g) => {
  bowtie(g); g.line(0, 0, 0, 0.15);
  g.circle(0, 0.23, 0.08); g.text("M", 0, 0.23, 0.07, "MC", true);
}, [-VALVE_W, -0.09, VALVE_W, 0.31]);
valve("pid-prv", "Pressure reducing valve", (g) => {
  bowtie(g); g.line(0, 0, 0, 0.2);
  g.poly([[-0.12, 0.2, -1], [0.12, 0.2]]); g.line(-0.12, 0.2, 0.12, 0.2);
  g.poly([[0.12, 0.2], [0.21, 0.2], [0.21, 0]]);
}, [-VALVE_W, -0.09, VALVE_W, 0.32], {
  props: [SIZE, { k: "set", label: "Set pressure", type: "text", def: "" }],
  spec: (n) => [n.props.size, n.props.set],
});

defSym({
  id: "pid-3way", lib: "pid", name: "3-way valve",
  box: [-VALVE_W, -VALVE_W, VALVE_W, 0.09],
  ports: [P("W", -VALVE_W, 0, "W", "in"), P("S", 0, -VALVE_W, "S", "in"), P("E", VALVE_W, 0, "E", "out")],
  props: [SIZE, { k: "fn", label: "Function", type: "text", def: "" }],
  spec: (n) => [n.props.fn, n.props.size],
  draw(g) {
    bowtie(g);
    g.poly([[-0.09, -0.15], [0.09, -0.15], [0, 0]], true);
    leadH(g, -VALVE_W, -0.15); leadH(g, 0.15, VALVE_W); leadV(g, -0.15, -VALVE_W);
  },
});

defSym({
  id: "pid-relief", lib: "pid", name: "Relief / safety valve",
  box: [-0.06, -VALVE_W, VALVE_W, 0.27],
  ports: [P("S", 0, -VALVE_W, "S", "in"), P("E", VALVE_W, 0, "E", "out")],
  props: [SIZE, { k: "set", label: "Set pressure / temp", type: "text", def: "" }],
  spec: (n) => [n.props.set, n.props.size],
  draw(g) {
    g.poly([[-0.09, -0.15], [0.09, -0.15], [0, 0]], true);
    g.poly([[0.15, 0.09], [0.15, -0.09], [0, 0]], true);
    leadV(g, -0.15, -VALVE_W); leadH(g, 0.15, VALVE_W);
    zigzag(g, 0, 0, 0, 0.27, 5, 0.05);
  },
});

defSym({
  id: "pid-backflow", lib: "pid", name: "Backflow preventer",
  box: [-0.375, -0.125, 0.375, 0.125],
  ports: [P("W", -0.375, 0, "W", "in"), P("E", 0.375, 0, "E", "out")],
  props: [SIZE, { k: "kind", label: "Type", type: "select", options: ["RPZ", "DCVA", "PVB", "AVB", "DUAL CHECK"], def: "RPZ" }],
  spec: (n) => [n.props.kind, n.props.size],
  draw(g) {
    g.rect(-0.25, -0.125, 0.25, 0.125, 0.02);
    leadH(g, -0.375, -0.25); leadH(g, 0.25, 0.375);
    for (const x0 of [-0.17, 0.03]) {
      g.poly([[x0, 0.06], [x0, -0.06], [x0 + 0.11, 0]], true);
      g.line(x0 + 0.11, 0.06, x0 + 0.11, -0.06);
    }
  },
});

defSym({
  id: "pid-strainer", lib: "pid", name: "Y-strainer",
  box: [-VALVE_W, -0.17, VALVE_W, 0.07],
  ports: valvePorts, props: VALVE_PROPS, spec: valveSpec,
  draw(g) {
    leadH(g, -VALVE_W, VALVE_W);
    // body and the angled screen leg
    g.poly([[-0.12, 0.07], [0.12, 0.07], [0.12, -0.07], [-0.12, -0.07]], true);
    g.poly([[-0.02, -0.07], [0.07, -0.17], [0.15, -0.11], [0.09, -0.07]]);
    g.line(0.025, -0.12, 0.11, -0.14);
  },
});

defSym({
  id: "pid-filter", lib: "pid", name: "Filter",
  box: [-VALVE_W, -0.15, VALVE_W, 0.15],
  ports: valvePorts, props: VALVE_PROPS, spec: valveSpec,
  draw(g) {
    g.rect(-0.15, -0.15, 0.15, 0.15);
    leadH(g, -VALVE_W, -0.15); leadH(g, 0.15, VALVE_W);
    for (let i = 0; i < 4; i++) {
      const t0 = i / 4 + 0.03, t1 = (i + 1) / 4 - 0.03;
      g.line(-0.15 + 0.3 * t0, -0.15 + 0.3 * t0, -0.15 + 0.3 * t1, -0.15 + 0.3 * t1);
    }
  },
});

defSym({
  id: "pid-meter", lib: "pid", name: "Meter",
  box: [-VALVE_W, -0.125, VALVE_W, 0.125],
  ports: valvePorts,
  props: [{ k: "mark", label: "Symbol text", type: "text", def: "WM" }, SIZE],
  spec: (n) => [n.props.size],
  draw(g, n) {
    g.circle(0, 0, 0.125);
    g.fitText(n.props.mark || "M", 0, 0, 0.18, 0.08, true);
    leadH(g, -VALVE_W, -0.125); leadH(g, 0.125, VALVE_W);
  },
});

defSym({
  id: "pid-union", lib: "pid", name: "Union / flange",
  box: [-0.125, -0.07, 0.125, 0.07],
  ports: [P("W", -0.125, 0, "W", "in"), P("E", 0.125, 0, "E", "out")],
  draw(g) {
    leadH(g, -0.125, 0.125);
    g.line(-0.03, -0.07, -0.03, 0.07); g.line(0.03, -0.07, 0.03, 0.07);
  },
});

defSym({
  id: "pid-reducer", lib: "pid", name: "Reducer",
  box: [-0.2, -0.09, 0.2, 0.09],
  ports: [P("W", -0.2, 0, "W", "in"), P("E", 0.2, 0, "E", "out")],
  props: [{ k: "sizes", label: "Sizes", type: "text", def: "" }],
  spec: (n) => [n.props.sizes],
  draw(g) {
    g.poly([[-0.1, 0.09], [0.1, 0.05], [0.1, -0.05], [-0.1, -0.09]], true);
    leadH(g, -0.2, -0.1); leadH(g, 0.1, 0.2);
  },
});

defSym({
  id: "pid-drain", lib: "pid", name: "Drain / hose bib",
  box: [-VALVE_W, -0.09, 0.22, 0.09],
  ports: [P("W", -VALVE_W, 0, "W", "in")],
  props: [{ k: "kind", label: "Type", type: "text", def: "DRAIN" }, SIZE],
  spec: (n) => [n.props.kind, n.props.size],
  draw(g) {
    leadH(g, -VALVE_W, -0.15); bowtie(g); leadH(g, 0.15, 0.22);
    g.line(0.22, -0.05, 0.22, 0.05);
  },
});

defSym({
  id: "pid-vent", lib: "pid", name: "Air vent", satellite: true,
  box: [-0.08, -0.25, 0.08, 0.18],
  ports: [P("S", 0, -0.25, "S", "in")],
  props: [{ k: "kind", label: "Type", type: "text", def: "AAV" }],
  spec: (n) => [n.props.kind],
  draw(g) {
    leadV(g, -0.25, -0.1);
    g.rect(-0.08, -0.1, 0.08, 0.05, 0.015);
    g.line(0, 0.05, 0, 0.13); arrowHead(g, 0, 0.18, 0, 1, 0.06, 0.03);
  },
});

const PUMP_PROPS = [{ k: "flow", label: "Flow (GPM)", type: "text", def: "" },
  { k: "head", label: "Head (ft)", type: "text", def: "" },
  { k: "power", label: "Power", type: "text", def: "" }];
defSym({
  id: "pid-pump", lib: "pid", name: "Pump", tag: "P",
  box: [-0.3125, -0.1875, 0.3125, 0.1875],
  ports: [P("W", -0.3125, 0, "W", "in"), P("E", 0.3125, 0, "E", "out")],
  props: PUMP_PROPS,
  spec: (n) => [join(unit(n.props.flow, " GPM"), n.props.head ? `@ ${n.props.head} FT` : ""), n.props.power],
  draw(g) {
    g.circle(0, 0, 0.1875);
    g.poly([[-0.094, 0.162], [-0.094, -0.162], [0.1875, 0]], true);
    leadH(g, -0.3125, -0.1875); leadH(g, 0.1875, 0.3125);
  },
});

defSym({
  id: "pid-compressor", lib: "pid", name: "Compressor / blower", tag: "C",
  box: [-0.3125, -0.1875, 0.3125, 0.1875],
  ports: [P("W", -0.3125, 0, "W", "in"), P("E", 0.3125, 0, "E", "out")],
  props: [{ k: "cap", label: "Capacity", type: "text", def: "" }, { k: "power", label: "Power", type: "text", def: "" }],
  spec: (n) => [n.props.cap, n.props.power],
  draw(g) {
    g.circle(0, 0, 0.1875);
    g.line(-0.13, 0.135, 0.15, 0.065); g.line(-0.13, -0.135, 0.15, -0.065);
    leadH(g, -0.3125, -0.1875); leadH(g, 0.1875, 0.3125);
  },
});

function vessel(g, hw, hh) {
  // vertical vessel with dished heads; straight shell from -hh+hw/2 .. hh-hw/2
  const s = hh - hw / 2;
  g.poly([[hw, -s], [hw, s, 0.5], [-hw, s], [-hw, -s, 0.5]], true);
}

const TANK_PROPS = [{ k: "name", label: "Text in vessel", type: "text", def: "" },
  { k: "cap", label: "Capacity", type: "text", def: "" },
  { k: "rating", label: "Rating", type: "text", def: "" }];
defSym({
  id: "pid-tank-v", lib: "pid", name: "Vertical tank / vessel", tag: "TK", inner: "name",
  box: [-0.4375, -0.5625, 0.4375, 0.5625],
  ports: [P("W", -0.4375, -0.15, "W", "in"), P("E", 0.4375, 0.15, "E", "out"),
          P("N", 0, 0.5625, "N", "io"), P("S", 0, -0.5625, "S", "io")],
  props: TANK_PROPS,
  spec: (n) => [n.props.cap, n.props.rating],
  draw(g, n) {
    vessel(g, 0.3, 0.45);
    if (n.props.name) g.fitText(n.props.name, 0, 0, 0.5, 0.1, true);
    g.line(-0.4375, -0.15, -0.3, -0.15); g.line(0.3, 0.15, 0.4375, 0.15);
    leadV(g, 0.45, 0.5625); leadV(g, -0.45, -0.5625);
  },
});

defSym({
  id: "pid-tank-h", lib: "pid", name: "Horizontal tank", tag: "TK", inner: "name",
  box: [-0.5625, -0.375, 0.5625, 0.375],
  ports: [P("W", -0.5625, 0, "W", "in"), P("E", 0.5625, 0, "E", "out"),
          P("N", 0, 0.375, "N", "io"), P("S", 0, -0.375, "S", "io")],
  props: TANK_PROPS,
  spec: (n) => [n.props.cap, n.props.rating],
  draw(g, n) {
    const s = 0.3;
    g.poly([[-s, -0.25], [s, -0.25, 0.5], [s, 0.25], [-s, 0.25, 0.5]], true);
    if (n.props.name) g.fitText(n.props.name, 0, 0, 0.6, 0.1, true);
    leadH(g, -0.5625, -0.425); leadH(g, 0.425, 0.5625);
    leadV(g, 0.25, 0.375); leadV(g, -0.25, -0.375);
  },
});

defSym({
  id: "pid-exptank", lib: "pid", name: "Expansion / pressure tank", tag: "ET", satellite: true,
  box: [-0.2, -0.45, 0.2, 0.3],
  ports: [P("S", 0, -0.45, "S", "io")],
  props: [{ k: "cap", label: "Capacity", type: "text", def: "" }, { k: "pre", label: "Pre-charge", type: "text", def: "" }],
  spec: (n) => [n.props.cap, n.props.pre],
  draw(g) {
    vessel(g, 0.2, 0.3);
    g.line(-0.2, 0, 0.2, 0);
    leadV(g, -0.3, -0.45);
  },
});

defSym({
  id: "pid-wh", lib: "pid", name: "Water heater", tag: "WH",
  box: [-0.4375, -0.5625, 0.4375, 0.5625],
  ports: [P("W", -0.4375, -0.25, "W", "in"), P("E", 0.4375, 0.25, "E", "out"), P("N", 0, 0.5625, "N", "io")],
  props: [{ k: "cap", label: "Capacity", type: "text", def: "" },
          { k: "fuel", label: "Fuel / input", type: "text", def: "" }],
  spec: (n) => [n.props.cap, n.props.fuel],
  draw(g) {
    vessel(g, 0.3, 0.45);
    g.text("WH", 0, 0.05, 0.11, "MC", true);
    zigzag(g, -0.15, -0.22, 0.15, -0.22, 6, 0.04);
    g.line(-0.4375, -0.25, -0.3, -0.25); g.line(0.3, 0.25, 0.4375, 0.25);
    leadV(g, 0.45, 0.5625);
  },
});

defSym({
  id: "pid-boiler", lib: "pid", name: "Boiler", tag: "B",
  box: [-0.5, -0.3125, 0.5, 0.3125],
  ports: [P("W", -0.5, -0.15, "W", "in"), P("E", 0.5, 0.15, "E", "out")],
  props: [{ k: "cap", label: "Capacity", type: "text", def: "" }, { k: "fuel", label: "Fuel", type: "text", def: "" }],
  spec: (n) => [n.props.cap, n.props.fuel],
  draw(g) {
    g.rect(-0.375, -0.3125, 0.375, 0.3125, 0.03);
    g.text("BOILER", 0, 0.08, 0.08, "MC", true);
    zigzag(g, -0.18, -0.13, 0.18, -0.13, 8, 0.04);
    g.line(-0.5, -0.15, -0.375, -0.15); g.line(0.375, 0.15, 0.5, 0.15);
  },
});

defSym({
  id: "pid-hx", lib: "pid", name: "Heat exchanger", tag: "HX",
  box: [-0.375, -0.375, 0.375, 0.375],
  ports: [P("W", -0.375, 0, "W", "in"), P("E", 0.375, 0, "E", "out"),
          P("N", 0, 0.375, "N", "io"), P("S", 0, -0.375, "S", "io")],
  props: [{ k: "cap", label: "Capacity", type: "text", def: "" }],
  spec: (n) => [n.props.cap],
  draw(g) {
    g.circle(0, 0, 0.25);
    zigzag(g, -0.25, 0, 0.25, 0, 5, 0.09);
    leadH(g, -0.375, -0.25); leadH(g, 0.25, 0.375);
    leadV(g, 0.25, 0.375); leadV(g, -0.25, -0.375);
  },
});

defSym({
  id: "pid-coil", lib: "pid", name: "Coil", tag: "CC",
  box: [-0.3125, -0.25, 0.3125, 0.25],
  ports: [P("W", -0.3125, 0, "W", "in"), P("E", 0.3125, 0, "E", "out")],
  props: [{ k: "cap", label: "Capacity", type: "text", def: "" }],
  spec: (n) => [n.props.cap],
  draw(g) {
    g.rect(-0.1875, -0.25, 0.1875, 0.25);
    zigzag(g, -0.1875, -0.25, 0.1875, 0.25, 5, 0.06);
    leadH(g, -0.3125, -0.1875); leadH(g, 0.1875, 0.3125);
  },
});

defSym({
  id: "pid-radiator", lib: "pid", name: "Baseboard / radiator",
  box: [-0.4375, -0.1, 0.4375, 0.1],
  ports: [P("W", -0.4375, 0, "W", "in"), P("E", 0.4375, 0, "E", "out")],
  props: [{ k: "len", label: "Length / output", type: "text", def: "" }],
  spec: (n) => [n.props.len],
  draw(g) {
    g.rect(-0.3125, -0.1, 0.3125, 0.1);
    for (let x = -0.25; x <= 0.2501; x += 0.0625) g.line(x, -0.1, x, 0.1);
    leadH(g, -0.4375, -0.3125); leadH(g, 0.3125, 0.4375);
  },
});

boxSym("pid-equip", "pid", "Equipment (generic)", "AHU",
  [{ id: "W", side: "W", role: "in", lead: 0.125 }, { id: "E", side: "E", role: "out", lead: 0.125 }],
  { hw: 0.375, hh: 0.25 }, { tag: "EQ" });
boxSym("pid-fixture", "pid", "Fixtures / load", "FIXTURES",
  [{ id: "W", side: "W", role: "in", lead: 0.125 }],
  { hw: 0.375, hh: 0.1875 });

/** Arrow-shaped connector sized to its text; points along the flow. */
function connector(id, name, extra) {
  const th = (doc) => Math.max(0.075, MIN_SYM_TEXT / (doc ? doc.symScale : 1));
  const half = (n, doc) => Math.max(0.375, symTextW(n.props.name, th(doc), doc) / 2 + 0.16);
  const isSource = !!extra.source;
  return defSym({
    id, lib: "pid", name,
    box: (n, doc) => { const L = half(n, doc); return [-L, -0.125, L, 0.125]; },
    ports: (n, doc) => {
      const L = half(n, doc);
      return isSource ? [P("E", L + 0.125, 0, "E", "out")] : [P("W", -L - 0.125, 0, "W", "in")];
    },
    draw(g, n, doc) {
      const L = half(n, doc);
      g.poly([[-L, 0.125], [L - 0.125, 0.125], [L, 0], [L - 0.125, -0.125], [-L, -0.125]], true);
      g.fitText(n.props.name || "", -0.0625, 0, 2 * L - 0.25, th(doc), true);
      if (isSource) leadH(g, L, L + 0.125); else leadH(g, -L - 0.125, -L);
    },
    ...extra,
  });
}
connector("pid-source", "Supply / from", {
  source: true, primary: true,
  props: [{ k: "name", label: "Text", type: "text", def: "CITY WATER" }, SIZE],
  spec: (n) => [n.props.size],
});
connector("pid-offpage", "To / off-sheet", {
  props: [{ k: "name", label: "Text", type: "text", def: "TO DRAIN" }],
});

defSym({
  id: "pid-inst", lib: "pid", name: "Instrument", satellite: true, instrument: true,
  box: [-0.21875, -0.21875, 0.21875, 0.21875],
  ports: [P("S", 0, -0.21875, "S"), P("N", 0, 0.21875, "N"), P("W", -0.21875, 0, "W"), P("E", 0.21875, 0, "E")],
  props: [{ k: "fn", label: "Function letters", type: "text", def: "PI" },
          { k: "loop", label: "Loop number", type: "text", def: "" },
          { k: "loc", label: "Location", type: "select", options: ["FIELD", "PANEL", "AUX PANEL", "DCS", "PLC"], def: "FIELD" }],
  draw(g, n) {
    const r = 0.21875, loc = n.props.loc || "FIELD";
    if (loc === "PLC") {
      g.poly([[-r, 0], [-r / 2, r * 0.87], [r / 2, r * 0.87], [r, 0], [r / 2, -r * 0.87], [-r / 2, -r * 0.87]], true);
    } else {
      g.circle(0, 0, r);
      if (loc === "DCS") g.rect(-r, -r, r, r);
    }
    if (loc === "PANEL" || loc === "DCS") g.line(-r, 0, r, 0);
    if (loc === "AUX PANEL") { g.line(-r, 0.012, r, 0.012); g.line(-r, -0.012, r, -0.012); }
    const fn = n.props.fn || "", loop = n.props.loop || "";
    if (loop) {
      g.fitText(fn, 0, 0.075, 0.3, 0.085, true);
      g.fitText(loop, 0, -0.08, 0.3, 0.07);
    } else {
      g.fitText(fn, 0, 0, 0.32, 0.1, true);
    }
  },
});

defSym({
  id: "pid-junction", lib: "pid", name: "Tee / tap point", junction: true,
  box: [-0.02, -0.02, 0.02, 0.02],
  ports: [P("W", 0, 0, "W"), P("E", 0, 0, "E"), P("N", 0, 0, "N"), P("S", 0, 0, "S")],
  draw() {},
});

defSym({
  id: "pid-header", lib: "pid", name: "Header / manifold", bus: true, defLen: 1.5,
  box: (n) => { const L = n.len || 1.5; return [-0.05, -L / 2, 0.05, L / 2]; },
  ports: [P("line", 0, 0, "W", "in", { bus: true }), P("load", 0, 0, "E", "out", { bus: true })],
  props: [SIZE, { k: "service", label: "Service", type: "text", def: "" }],
  spec: (n) => [n.props.size, n.props.service],
  draw(g, n) {
    const L = n.len || 1.5;
    g.line(0, -L / 2, 0, L / 2, "PIPE-MAJOR");
    g.line(-0.05, -L / 2, 0.05, -L / 2); g.line(-0.05, L / 2, 0.05, L / 2);
  },
});

// P&ID palette
pal("pid", "Valves", "pid-gate", "Gate valve");
pal("pid", "Valves", "pid-ball", "Ball valve");
pal("pid", "Valves", "pid-globe", "Globe valve");
pal("pid", "Valves", "pid-butterfly", "Butterfly valve");
pal("pid", "Valves", "pid-check", "Check valve");
pal("pid", "Valves", "pid-balance", "Balancing valve");
pal("pid", "Valves", "pid-3way", "3-way valve");
pal("pid", "Valves", "pid-3way", "Thermostatic mixing valve", { fn: "TMV" });
pal("pid", "Valves", "pid-control", "Control valve");
pal("pid", "Valves", "pid-solenoid", "Solenoid valve");
pal("pid", "Valves", "pid-motorized", "Motorized / zone valve");
pal("pid", "Valves", "pid-prv", "Pressure reducing valve");
pal("pid", "Valves", "pid-relief", "Relief valve");
pal("pid", "Valves", "pid-relief", "T&P relief valve", { set: "T&P" });
pal("pid", "Valves", "pid-backflow", "Backflow preventer");
pal("pid", "Valves", "pid-drain", "Drain valve");
pal("pid", "Valves", "pid-drain", "Hose bib", { kind: "HOSE BIB" });
pal("pid", "Equipment", "pid-pump", "Pump / circulator");
pal("pid", "Equipment", "pid-tank-v", "Vertical tank");
pal("pid", "Equipment", "pid-tank-v", "Water softener", { name: "SOFTENER" }, { tag: "WS" });
pal("pid", "Equipment", "pid-tank-v", "Air separator", { name: "AIR SEP" }, { tag: "AS" });
pal("pid", "Equipment", "pid-tank-v", "Buffer tank", { name: "BUFFER" });
pal("pid", "Equipment", "pid-tank-h", "Horizontal tank");
pal("pid", "Equipment", "pid-exptank", "Expansion / pressure tank");
pal("pid", "Equipment", "pid-wh", "Water heater");
pal("pid", "Equipment", "pid-boiler", "Boiler");
pal("pid", "Equipment", "pid-hx", "Heat exchanger");
pal("pid", "Equipment", "pid-coil", "Coil");
pal("pid", "Equipment", "pid-radiator", "Baseboard / radiator");
pal("pid", "Equipment", "pid-compressor", "Compressor / blower");
for (const [name, inner] of [["Air handler", "AHU"], ["Fan coil", "FCU"], ["Chiller", "CHILLER"],
  ["UV disinfection", "UV"], ["Reverse osmosis", "RO"], ["Water treatment", "TREATMENT"],
  ["Equipment (generic)", "EQUIP"]]) {
  pal("pid", "Equipment", "pid-equip", name, { name: inner });
}
pal("pid", "Inline", "pid-strainer", "Y-strainer");
pal("pid", "Inline", "pid-filter", "Filter");
pal("pid", "Inline", "pid-meter", "Water / flow meter");
pal("pid", "Inline", "pid-union", "Union / flange");
pal("pid", "Inline", "pid-reducer", "Reducer");
pal("pid", "Instruments", "pid-inst", "Pressure gauge", { fn: "PI" });
pal("pid", "Instruments", "pid-inst", "Thermometer", { fn: "TI" });
pal("pid", "Instruments", "pid-inst", "Pressure switch", { fn: "PS" });
pal("pid", "Instruments", "pid-inst", "Temperature sensor", { fn: "TE" });
pal("pid", "Instruments", "pid-inst", "Flow switch", { fn: "FS" });
pal("pid", "Instruments", "pid-inst", "Controller", { fn: "TIC", loc: "PANEL" });
pal("pid", "Instruments", "pid-inst", "Instrument (generic)", { fn: "XX" });
pal("pid", "Instruments", "pid-vent", "Air vent");
pal("pid", "Lines", "pid-source", "Supply / from");
pal("pid", "Lines", "pid-source", "Well", { name: "WELL" });
pal("pid", "Lines", "pid-offpage", "To / off-sheet");
pal("pid", "Lines", "pid-header", "Header / manifold");
pal("pid", "Lines", "pid-junction", "Tee / tap point");
for (const [name, inner] of [["Fixtures", "FIXTURES"], ["Hot water fixtures", "HW FIXTURES"],
  ["Heating zone", "ZONE"], ["Irrigation", "IRRIGATION"], ["Load (generic)", "LOAD"]]) {
  pal("pid", "Loads", "pid-fixture", name, { name: inner });
}

// ------------------------------------------------------------- edge styles
const EDGE_STYLES = {
  power: { lib: "ol", name: "Power conductor", layer: "WIRE" },
  "power-ug": { lib: "ol", name: "Power, underground", layer: "WIRE-UG" },
  control: { lib: "ol", name: "Control / signal", layer: "WIRE-CTRL", minor: true },
  ground: { lib: "ol", name: "Grounding conductor", layer: "WIRE-GND", minor: true },
  pipe: { lib: "pid", name: "Process pipe (major)", layer: "PIPE-MAJOR" },
  "pipe-minor": { lib: "pid", name: "Process pipe (minor)", layer: "PIPE-MINOR" },
  "pipe-ug": { lib: "pid", name: "Pipe, underground / buried", layer: "PIPE-UG" },
  "inst-conn": { lib: "pid", name: "Instrument process connection", layer: "SIGNAL", minor: true },
  "sig-elec": { lib: "pid", name: "Electric signal", layer: "SIGNAL-ELEC", minor: true },
  "sig-pneu": { lib: "pid", name: "Pneumatic signal", layer: "SIGNAL", deco: "slash", minor: true },
  "sig-cap": { lib: "pid", name: "Capillary", layer: "SIGNAL", deco: "x", minor: true },
  "sig-data": { lib: "pid", name: "Data link", layer: "SIGNAL", deco: "o", minor: true },
};
const LINE_WEIGHT_RANK = (style) => (EDGE_STYLES[style]?.minor ? 0 : 1);
