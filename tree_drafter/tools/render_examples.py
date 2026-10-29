"""Render every bundled example to examples/output/ as PNG (150 dpi), SVG and DXF.
Uses the built tree-drafter.html, so run tools/build.py first (needs playwright)."""
import base64
import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "examples" / "output"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path="/opt/pw-browsers/chromium")
        pg = b.new_page()
        pg.goto((ROOT / "tree-drafter.html").as_uri())
        pg.wait_for_function("window.TD && TD.APP.res")
        data = pg.evaluate("""async () => {
          const out = {};
          for (const [k, ex] of Object.entries(TD.examples())) {
            const r = TD.renderDoc(TD.normalizeDoc(JSON.parse(JSON.stringify(ex))));
            const png = await TD.sheetToPng(r.sheet, r.W, r.H, 150);
            const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(png); });
            out[k] = { png: b64, svg: TD.sheetToSvg(r.sheet, r.W, r.H, { fonts: fontFaceCss(r.sheet.font) }), dxf: TD.sheetToDxf(r.sheet, r.W, r.H) };
          }
          return out;
        }""")
        b.close()
    for k, d in data.items():
        (OUT / f"{k}.png").write_bytes(base64.b64decode(d["png"]))
        (OUT / f"{k}.svg").write_text(d["svg"])
        (OUT / f"{k}.dxf").write_text(d["dxf"])
    for f in sorted(OUT.iterdir()):
        print(f"wrote {f.relative_to(ROOT)} ({f.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
