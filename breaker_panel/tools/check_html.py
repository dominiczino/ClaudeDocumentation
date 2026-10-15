"""Dev check for panel-drafter.html (needs playwright + ezdxf; not needed to use the app).

Loads the page from file:// in headless Chromium, builds DXFs for a set of panel
configs, and checks each one with ezdxf: it must read back, pass ezdxf's validation
check and stay inside the sheet frame. Also checks the UI loads without JS errors.

    python tools/check_html.py [--out DIR]   # DIR: also write example .dxf/.png/.pdf
"""
import argparse
import io
import json
import os
import pathlib
import sys

import ezdxf
from ezdxf import bbox
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
PAGE = (ROOT / "panel-drafter.html").as_uri()
CHROMIUM = os.environ.get("CHROMIUM", "/opt/pw-browsers/chromium")

EXAMPLE = json.loads((ROOT / "examples" / "main_panel.json").read_text())
CASES = {
    "example": EXAMPLE,
    "two_space": {"spaces": 2, "breakers": [{"space": 1, "kind": "single", "amps": 20, "label": "x"}]},
    "mlo_quad": {"spaces": 12, "main": {"kind": "lugs", "amps": 100},
                 "breakers": [{"space": 1, "kind": "quad", "a": {"amps": 30}, "b": {"amps": 20}}]},
    "big_3ph": {"spaces": 84, "phases": 3, "voltage": "120/208V 3Φ 4W", "main": {"kind": "lugs"},
                "numbering": "sequential",
                "breakers": [{"space": i, "kind": "triple", "amps": 100, "label": "Long " * 30} for i in (1, 4, 43)]
                + [{"space": 7, "kind": "tandem", "a": {"amps": 15, "label": "A " * 40}, "b": {"amps": 15}}],
                "notes": ["n " * 200] * 3},
    "font_jost": {**EXAMPLE, "font": "jost"},
    "font_arial": {**EXAMPLE, "font": "arial"},
    "special_chars": {"spaces": 4, "name": "Shop <A> & \"B\" $& 100%%",
                      "breakers": [{"space": 1, "kind": "single", "amps": 20, "label": "$1 lamp %%c & <tag>"}]},
}
BAD = {
    "overlap": {"spaces": 20, "breakers": [{"space": 1, "kind": "double"}, {"space": 3, "kind": "single"}]},
    "off_bottom": {"spaces": 12, "breakers": [{"space": 11, "kind": "double"}]},
    "odd_spaces": {"spaces": 7},
}


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
        page.wait_for_selector("#sheet svg")
        if errors:
            failures.append(f"page errors: {errors}")
        for fam in ("PD B612", "PD Jost"):
            if not page.evaluate("f => document.fonts.check(`12px '${f}`) && document.fonts.check(`bold 12px '${f}`)", fam):
                failures.append(f"embedded font {fam} not loaded")

        for name, cfg in CASES.items():
            dxf = page.evaluate("cfg => PanelDrafter.sheetToDxf(PanelDrafter.buildSheet(cfg).sheet)", cfg)
            doc = ezdxf.read(io.StringIO(dxf))
            aud = doc.audit()
            if aud.has_errors:
                failures.append(f"{name}: audit errors {[str(e) for e in aud.errors]}")
            ext = bbox.extents(doc.modelspace())
            if not (ext.extmin.x >= 0.39 and ext.extmin.y >= 0.39 and ext.extmax.x <= 10.61 and ext.extmax.y <= 16.61):
                failures.append(f"{name}: content outside frame {ext}")
            if "ANSI B" not in doc.layouts:
                failures.append(f"{name}: no ANSI B layout")
            want = {"jost": "Jost-Regular.ttf", "arial": "arial.ttf"}.get(cfg.get("font"), "B612-Regular.ttf")
            if doc.styles.get("PANEL-STD").dxf.font != want:
                failures.append(f"{name}: text style font {doc.styles.get('PANEL-STD').dxf.font}, want {want}")
            n = len(doc.modelspace())
            print(f"ok  {name:14s} {n:5d} entities  handseed {doc.header['$HANDSEED']}")
            if a.out and name == "example":
                a.out.mkdir(parents=True, exist_ok=True)
                (a.out / "main_panel.dxf").write_text(dxf, encoding="utf-8")

        for name, cfg in BAD.items():
            errs = page.evaluate("""cfg => { try { PanelDrafter.buildSheet(cfg); return null; }
                                    catch (e) { return e.errors || [String(e)]; } }""", cfg)
            if not errs:
                failures.append(f"{name}: expected a validation error")
            else:
                print(f"ok  {name:14s} rejected: {errs[0]}")

        if a.out:
            page.screenshot(path=str(a.out / "ui.png"))
            page.evaluate("""() => { const r = PanelDrafter.buildSheet(JSON.parse(
                               document.getElementById('example-panel').textContent));
                             document.getElementById('printSheet').innerHTML =
                               PanelDrafter.sheetToSvg(r.sheet, {width: '11in', height: '17in'}); }""")
            page.emulate_media(media="print")
            page.pdf(path=str(a.out / "main_panel.pdf"), width="11in", height="17in",
                     print_background=True, prefer_css_page_size=True)
        browser.close()

    if failures:
        print("\nFAILED:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
