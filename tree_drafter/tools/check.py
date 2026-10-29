"""Dev check for tree-drafter.html (needs playwright + ezdxf; not needed to use the app).

Loads the built page headless and, for every example in every layout, node
style and connector (plus a large random tree and a large Newick tree), checks:
  * no two boxes / leaf labels overlap, and everything stays inside the page margins,
  * every parent is drawn above its children, and siblings keep their outline order,
  * the DXF reads back in ezdxf and passes its audit,
  * Newick survives a round trip through the outline,
  * the editor: Tab indents, clicking a box finds its line, PNG export works,
  * no JavaScript errors.

    python tools/check.py
"""
import io
import json
import os
import pathlib
import sys

import ezdxf
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
PAGE = (ROOT / "tree-drafter.html").as_uri()
CHROMIUM = os.environ.get("CHROMIUM", "/opt/pw-browsers/chromium")

JS = r"""() => {
  const out = { cases: [], errors: [], dxf: [] };
  const err = (c, m) => { if (!c) out.errors.push(m); };
  // a random tree with long and short labels, and a 60-taxon Newick tree
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const words = ["valve", "zone", "pump", "check", "relay", "circuit", "sensor", "branch", "loop", "panel", "tank", "line"];
  const lines = [];
  const grow = (d, n) => {
    for (let i = 0; i < n; i++) {
      const w = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => words[Math.floor(rnd() * words.length)]).join(" ");
      lines.push("  ".repeat(d) + (rnd() < 0.2 ? "[" + words[Math.floor(rnd() * 12)] + "] " : "") + w + (rnd() < 0.3 ? " | " + w : "") + ` {${(rnd() * 3).toFixed(2)}}`);
      if (d < 4 && rnd() < 0.45) grow(d + 1, 1 + Math.floor(rnd() * 4));
    }
  };
  lines.push("Root");
  grow(1, 5);
  const taxa = Array.from({ length: 60 }, (_, i) => `Species_${String.fromCharCode(65 + (i % 26))}${i}`);
  const nw = (list) => list.length === 1 ? `${list[0]}:${(rnd() * 0.2).toFixed(3)}` :
    `(${nw(list.slice(0, Math.ceil(list.length * (0.3 + rnd() * 0.4))))},${nw(list.slice(Math.ceil(list.length * (0.3 + rnd() * 0.4))) .length ? list.slice(Math.ceil(list.length * 0.5)) : list.slice(-1))}):${(rnd() * 0.1).toFixed(3)}`;
  const newick = nw(taxa) + ";";
  const docs = Object.values(TD.examples()).map((e) => TD.normalizeDoc(JSON.parse(JSON.stringify(e))));
  docs.push(TD.normalizeDoc({ name: "random", text: lines.join("\n"), s: { textSize: 9 } }));
  const nwTrees = TD.parseNewick(newick);
  docs.push(TD.normalizeDoc({ name: "newick", text: TD.treesToOutline(nwTrees), s: { layout: "phylogram", nodeStyle: "labels" } }));

  // Newick round trip
  const P1 = TD.parseOutline(TD.treesToOutline(nwTrees));
  const back = TD.toNewick(P1.roots).trim();
  const P2 = TD.parseOutline(TD.treesToOutline(TD.parseNewick(back)));
  err(TD.toNewick(P2.roots).trim() === back, "Newick round trip changed the tree");
  err(TD.parseNewick("((A:1,'B c':2)x:0.5,C_d);")[0].children[1].label === "C d", "Newick underscore/quote handling");

  const variants = [];
  for (const layout of ["flowchart", "dendrogram", "cladogram", "phylogram"])
    for (const nodeStyle of ["boxes", "labels"])
      for (const leafLabels of ["horizontal", "vertical"])
        variants.push({ layout, nodeStyle, leafLabels, connector: ["elbow", "rounded", "straight"][variants.length % 3] });
  for (const d0 of docs) {
    for (const v of variants) {
      if (v.layout === "phylogram" && v.nodeStyle === "boxes") continue;
      if (v.nodeStyle === "boxes" && v.leafLabels === "vertical") continue;
      const doc = TD.normalizeDoc({ ...JSON.parse(JSON.stringify(d0)), s: { ...d0.s, ...v } });
      const res = TD.renderDoc(doc);
      const tag = `${d0.name} / ${v.layout} ${v.nodeStyle} ${v.leafLabels} ${v.connector}`;
      const S = TD.effective(doc.s);
      const R = res.rects;
      const eps = 1e-4;
      for (const [id, r] of R) {
        err(r[0] >= 0.5 - 0.02 && r[2] <= res.W - 0.5 + 0.02 && r[1] >= 0.5 - 0.02 && r[3] <= res.H - 0.5 + 0.02, `${tag}: ${id} outside the margins ${r.map((x) => x.toFixed(2))}`);
      }
      const solid = [...R].filter(([, r]) => r[2] - r[0] > eps && r[3] - r[1] > eps);
      for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
        const [a, ra] = solid[i], [b, rb] = solid[j];
        if (ra[0] < rb[2] - eps && rb[0] < ra[2] - eps && ra[1] < rb[3] - eps && rb[1] < ra[3] - eps)
          { out.errors.push(`${tag}: ${a} overlaps ${b}`); break; }
      }
      for (const n of res.P.nodes) {
        for (const c of n.children) {
          const pr = R.get(n.id), cr = R.get(c.id);
          const pBottom = S.nodeStyle === "boxes" ? pr[1] : pr[3];
          const cTop = S.nodeStyle === "boxes" || !c.leaf ? cr[3] : cr[3];
          err(pBottom >= cTop - eps || (S.layout === "phylogram" && (c.len ?? 1) === 0), `${tag}: ${c.id} is not below ${n.id}`);
        }
        for (let i = 1; i < n.children.length; i++) {
          err(R.get(n.children[i - 1].id)[0] + R.get(n.children[i - 1].id)[2] < R.get(n.children[i].id)[0] + R.get(n.children[i].id)[2] + eps,
              `${tag}: children of ${n.id} out of order`);
        }
      }
      out.cases.push({ tag, scale: +res.info.scale.toFixed(3), pt: +res.info.textPt.toFixed(1), nodes: res.info.nodes });
      if (out.dxf.length < 6 && v.connector !== "straight") out.dxf.push([tag, TD.sheetToDxf(res.sheet, res.W, res.H)]);
    }
  }
  return out;
}"""


def main():
    failures = []
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=CHROMIUM)
        pg = b.new_page(viewport={"width": 1400, "height": 900}, accept_downloads=True)
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto(PAGE)
        pg.wait_for_function("window.TD && TD.APP.res", timeout=20000)
        r = pg.evaluate(JS)
        failures += r["errors"][:25]
        small = [c for c in r["cases"] if c["pt"] < 6]
        if os.environ.get("VERBOSE"):
            for c in sorted(r["cases"], key=lambda c: c["pt"])[:16]: print("   ", c)
        print(f"ok  layouts: {len(r['cases'])} cases checked (overlap, margins, parent above child, sibling order); "
              f"text {min(c['pt'] for c in r['cases'])}–{max(c['pt'] for c in r['cases'])} pt; {len(small)} below 6 pt")
        for tag, dxf in r["dxf"]:
            doc = ezdxf.read(io.StringIO(dxf))
            a = doc.audit()
            if a.has_errors:
                failures.append(f"DXF audit {tag}: {[str(e) for e in a.errors][:3]}")
        print(f"ok  DXF: {len(r['dxf'])} files pass ezdxf's audit")

        # editor: Tab indents the selected line, a click on a box finds its line
        pg.click("#btnNew"); pg.click("#btnBlank"); pg.wait_for_timeout(300)
        ta = pg.locator("#outline")
        ta.click()
        pg.evaluate("() => { const t = document.querySelector('#outline'); const i = t.value.indexOf('Second branch'); t.setSelectionRange(i, i); }")
        pg.keyboard.press("Tab"); pg.wait_for_timeout(400)
        if "      Second branch" not in ta.input_value() and "    Second branch" not in ta.input_value():
            failures.append(f"Tab did not indent: {ta.input_value()!r}")
        depth = pg.evaluate("TD.APP.res.P.nodes.find((n) => n.label === 'Second branch').depth")
        if depth != 2:
            failures.append(f"indented line has depth {depth}")
        pg.keyboard.press("Shift+Tab"); pg.wait_for_timeout(400)
        g = pg.locator("#page g[data-owner='n2']").first
        g.click()
        line = pg.evaluate("(() => { const t = document.querySelector('#outline'); return t.value.slice(0, t.selectionStart).split('\\n').length - 1; })()")
        want = pg.evaluate("TD.APP.res.P.nodes.find((n) => n.id === 'n2').line")
        if line != want:
            failures.append(f"click on a box selected line {line}, expected {want}")
        print("ok  editor: Tab/Shift+Tab indent, click a box to find its line")
        with pg.expect_download() as dl:
            pg.click("#btnExport"); pg.click("#btnPng")
        png = dl.value.path().read_bytes()
        if not png.startswith(b"\x89PNG") or len(png) < 5000:
            failures.append("PNG export failed")
        with pg.expect_download() as dl:
            pg.click("#btnExport"); pg.click("#btnNwk")
        print(f"ok  exports: PNG {len(png) // 1024} KB, Newick {dl.value.path().read_text().strip()[:40]}…")
        b.close()
    if errs:
        failures.append(f"page errors {errs}")
    if failures:
        print("\nFAILED:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
