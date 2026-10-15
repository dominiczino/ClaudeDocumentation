"""Dev check for diagram-drafter.html (needs playwright + ezdxf; not needed to use the app).

Loads the built page in headless Chromium, auto-arranges every example (in both
flow directions) plus a generated stress drawing, and checks that:
  * the page loads without JavaScript errors and the embedded fonts load,
  * every connection routes cleanly and the layout check finds no errors
    (overlaps, symbols outside the border or over the title block),
  * the DXF reads back in ezdxf, passes its audit, stays inside the sheet
    and has the ANSI B paper-space layout.

    python tools/check.py [--out DIR]   # DIR: also write example .dxf/.pdf/.png
"""
import argparse
import io
import os
import pathlib
import sys

import ezdxf
from ezdxf import bbox
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
PAGE = (ROOT / "diagram-drafter.html").as_uri()
CHROMIUM = os.environ.get("CHROMIUM", "/opt/pw-browsers/chromium")

ARRANGE = """async ([key, flow, stress]) => {
  await document.fonts.ready;
  let src;
  if (stress) {
    // a large one-line: service, main panel with sub-panels and many branches
    const N = (id, sym, props = {}, tag = "") => ({ id, sym, x: 0, y: 0, tag, props });
    const E = (a, ap, b, bp) => ({ from: { n: a, p: ap }, to: { n: b, p: bp } });
    const nodes = [N("U", "ol-utility"), N("M", "ol-meter"), N("MB", "ol-breaker", { amps: "400" }), N("P", "ol-bus", {}, "MDP")];
    const edges = [E("U", "S", "M", "N"), E("M", "S", "MB", "N"), E("MB", "S", "P", "line")];
    for (let i = 0; i < 4; i++) {
      nodes.push(N(`F${i}`, "ol-breaker", { amps: "100" }), N(`S${i}`, "ol-bus", {}, `PANEL ${i + 1}`));
      edges.push(E("P", "load", `F${i}`, "N"), E(`F${i}`, "S", `S${i}`, "line"));
      for (let j = 0; j < 4; j++) {
        nodes.push(N(`B${i}${j}`, "ol-breaker", { amps: "20" }), N(`L${i}${j}`, "ol-load", { name: "LOAD" }));
        edges.push(E(`S${i}`, "load", `B${i}${j}`, "N"), E(`B${i}${j}`, "S", `L${i}${j}`, "N"));
      }
    }
    src = { type: "oneline", name: "Stress", nodes, edges };
  } else {
    src = JSON.parse(document.getElementById("examples").textContent)[key];
  }
  const doc = DD.normalizeDoc(JSON.parse(JSON.stringify(src)));
  if (flow) doc.flow = flow;
  const t0 = performance.now();
  const rep = DD.autoArrange(doc);
  const ms = performance.now() - t0;
  const issues = DD.checkLayout(doc).filter((i) => i.lvl !== "info").map((i) => i.lvl + ": " + i.msg);
  const { sheet } = DD.renderDoc(doc);
  return { rep, ms, issues, nodes: doc.nodes.length, dxf: DD.sheetToDxf(sheet),
           svg: DD.sheetToSvg(sheet, { width: "17in", height: "11in" }), name: doc.name };
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=pathlib.Path)
    a = ap.parse_args()
    failures = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROMIUM)
        page = browser.new_page(viewport={"width": 1500, "height": 950})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(PAGE)
        page.wait_for_selector("#content g", timeout=20000)
        for fam in ("DD B612", "DD Jost"):
            if not page.evaluate("f => document.fonts.check(`12px '${f}'`)", fam):
                failures.append(f"embedded font {fam} not loaded")
        keys = page.evaluate("Object.keys(JSON.parse(document.getElementById('examples').textContent))")
        cases = [(k, None, False) for k in keys]
        cases += [(k, "right" if "one_line" in k else "down", False) for k in keys]
        cases += [("stress", None, True)]
        for key, flow, stress in cases:
            label = f"{key}{'/' + flow if flow else ''}"
            r = page.evaluate(ARRANGE, [key, flow, stress])
            doc = ezdxf.read(io.StringIO(r["dxf"]))
            aud = doc.audit()
            if aud.has_errors:
                failures.append(f"{label}: DXF audit errors {[str(e) for e in aud.errors]}")
            ext = bbox.extents(doc.modelspace())
            if not stress and not (ext.extmin.x >= 0.39 and ext.extmin.y >= 0.39 and ext.extmax.x <= 17.01 - 0.4 and ext.extmax.y <= 11.01 - 0.4):
                failures.append(f"{label}: DXF content outside the frame {ext}")
            if "ANSI B" not in doc.layouts:
                failures.append(f"{label}: no ANSI B layout")
            too_big = any("too large" in w for w in r["rep"]["warnings"])
            route_warn = [w for w in r["rep"]["warnings"] if "routed" in w]
            if stress:
                # deliberately more than one sheet holds: it must say so, not fail silently
                if not too_big and (route_warn or r["issues"]):
                    failures.append(f"{label}: problems without a 'too large' warning: {route_warn} {r['issues']}")
            else:
                if route_warn:
                    failures.append(f"{label}: {route_warn}")
                if r["issues"]:
                    failures.append(f"{label}: layout issues {r['issues']}")
            print(f"ok  {label:34s} {r['nodes']:3d} symbols  {r['ms']:6.0f} ms  scale {r['rep']['scale']:.2f}"
                  + (f"  ({'; '.join(r['rep']['warnings'])})" if r["rep"]["warnings"] else ""))
            if a.out and not flow and not stress:
                a.out.mkdir(parents=True, exist_ok=True)
                (a.out / f"{key}.dxf").write_text(r["dxf"], encoding="utf-8")
                page.evaluate("svg => { document.getElementById('printSheet').innerHTML = svg; }", r["svg"])
                page.emulate_media(media="print")
                page.pdf(path=str(a.out / f"{key}.pdf"), width="17in", height="11in",
                         print_background=True, prefer_css_page_size=True)
                page.emulate_media(media="screen")
        if errors:
            failures.append(f"page errors: {errors}")
        browser.close()
    if failures:
        print("\nFAILED:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
