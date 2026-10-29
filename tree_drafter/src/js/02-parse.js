/* =========================================================================
 * The outline: one node per line, indentation makes children.
 *
 *   [edge label] Label | detail text {options}
 *
 *   [Yes]        label on the branch coming into this node
 *   | detail     a second, smaller line in the box
 *   {options}    a number (branch length), a colour name or #hex (colours
 *                this branch and everything below it), a shape (round,
 *                box, pill, plain), dashed, bold, italic
 *   _Label_      italic label (species names)
 *   \n           line break inside a label
 *   // ...       comment line
 *
 * Also: Newick import and export, for phylogenetic trees.
 * ========================================================================= */

const PALETTE = {
  red: "#c62828", orange: "#e8710a", gold: "#b28704", green: "#2e7d32", teal: "#00838f",
  blue: "#1f5fa8", navy: "#1a3a6b", purple: "#6a3d9a", pink: "#c2185b", brown: "#795548",
  gray: "#6b7280", grey: "#6b7280", black: "#000000",
};
const SHAPES = ["round", "box", "pill", "plain"];

/**
 * Parse outline text. Returns {roots, nodes, messages}; each node is
 * {id, line, depth, label, detail, edge, len, color, shape, dashed, bold,
 *  italic, parent, children}. `line` is the 0-based source line.
 */
function parseOutline(text) {
  const nodes = [], roots = [], messages = [];
  const stack = [];   // [{indent, node}]
  const lines = String(text ?? "").split("\n");
  lines.forEach((raw, li) => {
    const line = raw.replace(/\t/g, "    ").replace(/\s+$/, "");
    let content = line.trim();
    if (!content || content.startsWith("//")) return;
    const indent = line.length - line.trimStart().length;
    const n = { id: "n" + nodes.length, line: li, label: "", detail: "", edge: "", len: null, color: null, shape: null,
                dashed: false, bold: false, italic: false, parent: null, children: [] };
    const em = /^\[([^\]]*)\]\s*/.exec(content);
    if (em) { n.edge = em[1].trim(); content = content.slice(em[0].length); }
    const am = /\s*\{([^{}]*)\}\s*$/.exec(content);
    if (am) {
      content = content.slice(0, am.index);
      for (const tok of am[1].split(/[\s,;]+/).filter(Boolean)) {
        const t = tok.toLowerCase();
        if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(t)) {
          n.len = Number(t);
          if (n.len < 0) messages.push({ lvl: "warn", line: li, msg: `Line ${li + 1}: negative branch length ${tok} is drawn as 0.` });
        } else if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(t)) n.color = t.length === 4 ? "#" + [...t.slice(1)].map((c) => c + c).join("") : t;
        else if (t in PALETTE) n.color = PALETTE[t];
        else if (SHAPES.includes(t)) n.shape = t;
        else if (t === "dashed" || t === "bold" || t === "italic") n[t] = true;
        else messages.push({ lvl: "warn", line: li, msg: `Line ${li + 1}: unknown option "${tok}". Options are a number (branch length), a colour, ${SHAPES.join(", ")}, dashed, bold or italic.` });
      }
    }
    const bar = content.indexOf("|");
    if (bar >= 0) { n.detail = content.slice(bar + 1).trim(); content = content.slice(0, bar); }
    let label = content.trim();
    const it = /^_(.+)_$/.exec(label);
    if (it) { label = it[1]; n.italic = true; }
    n.label = label.replace(/\\n/g, "\n");
    n.detail = n.detail.replace(/\\n/g, "\n");
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].node : null;
    n.parent = parent;
    n.depth = parent ? parent.depth + 1 : 0;
    if (parent) parent.children.push(n); else roots.push(n);
    stack.push({ indent, node: n });
    nodes.push(n);
  });
  return { roots, nodes, messages };
}

// ------------------------------------------------------------------ Newick
/** Parse Newick text into plain trees [{label, len, children}] (one per ';'). */
function parseNewick(text) {
  const s = String(text ?? "");
  let i = 0;
  const fail = (what) => { throw new Error(`${what} at character ${i + 1}`); };
  const ws = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] !== "[") return;
      const j = s.indexOf("]", i);   // [comment]
      if (j < 0) fail("Unclosed [comment]");
      i = j + 1;
    }
  };
  const label = () => {
    ws();
    if (s[i] === "'") {
      let out = "";
      i++;
      for (;;) {
        if (i >= s.length) fail("Unclosed quote");
        if (s[i] === "'" && s[i + 1] === "'") { out += "'"; i += 2; continue; }
        if (s[i] === "'") { i++; break; }
        out += s[i++];
      }
      return out;
    }
    const start = i;
    while (i < s.length && !/[,():;[\]]/.test(s[i])) i++;
    return s.slice(start, i).trim().replace(/_/g, " ");
  };
  const node = (depth) => {
    if (depth > 2000) fail("Tree too deep");
    ws();
    const n = { label: "", len: null, children: [] };
    if (s[i] === "(") {
      i++;
      for (;;) {
        n.children.push(node(depth + 1));
        ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === ")") { i++; break; }
        fail("Expected , or )");
      }
    }
    n.label = label();
    ws();
    if (s[i] === ":") {
      i++;
      ws();
      const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
      if (!m) fail("Expected a branch length");
      n.len = Number(m[0]);
      i += m[0].length;
    }
    return n;
  };
  const trees = [];
  ws();
  while (i < s.length) {
    trees.push(node(0));
    ws();
    if (s[i] === ";") i++;
    else if (i < s.length) fail("Expected ;");
    ws();
  }
  if (!trees.length) throw new Error("No tree found");
  return trees;
}

/** Plain trees (from Newick) -> outline text. */
function treesToOutline(trees) {
  const out = [];
  const clean = (t) => String(t).replace(/[|{}]/g, (c) => ({ "|": "/", "{": "(", "}": ")" })[c]).replace(/^\[/, "(").replace(/\n/g, "\\n");
  const walk = (n, d) => {
    const opts = n.len != null ? `{${+n.len.toPrecision(6)}}` : "";
    const label = clean(n.label || "");
    out.push("  ".repeat(d) + (label ? label + (opts ? " " + opts : "") : opts || "{}"));
    n.children.forEach((c) => walk(c, d + 1));
  };
  trees.forEach((t) => walk(t, 0));
  return out.join("\n") + "\n";
}

/** Parsed outline -> Newick (one tree per root). */
function toNewick(roots) {
  const q = (t) => {
    if (!t) return "";
    return /^[^\s,():;[\]'_]+$/.test(t) ? t : /^[^,():;[\]'_]+$/.test(t) ? t.replace(/ /g, "_") : `'${t.replace(/'/g, "''")}'`;
  };
  const walk = (n) => (n.children.length ? `(${n.children.map(walk).join(",")})` : "") +
    q(n.label.replace(/\n/g, " ")) + (n.len != null ? `:${+n.len.toPrecision(8)}` : "");
  return roots.map((r) => walk(r) + ";").join("\n") + "\n";
}
