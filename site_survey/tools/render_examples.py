"""Render the bundled example to examples/output/: plan (PDF, PNG, DXF),
report (PDF), 1:1 world DXF, coordinate CSV and KML. The plan is rendered
without imagery (the example's location is made up). Uses the built
site-survey.html, so run tools/build.py first."""

import pathlib
import subprocess

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "examples" / "output"
NAME = "example_property"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path="/opt/pw-browsers/chromium")
        pg = b.new_page(viewport={"width": 1400, "height": 900})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto((ROOT / "site-survey.html").as_uri())
        pg.wait_for_function("window.SV && window.SV.APP && window.SV.APP.sol")
        data = pg.evaluate("""() => {
          const ex = JSON.parse(document.querySelector('#examples').textContent).example_property;
          const p = SV.normalizeProject(JSON.parse(JSON.stringify(ex)));
          const sol = SV.solveProject(p), G = SV.georeference(p, sol);
          const plan = SV.renderPlan(p, sol, { geo: G }).sheet;
          return { planDxf: SV.sheetToDxf(plan), worldDxf: SV.worldDxf(p, sol), csv: SV.coordinatesCsv(p, sol, G), kml: SV.siteKml(p, sol, G),
                   planSvg: SV.sheetToSvg(plan, { width: '17in', height: '11in' }), report: SV.reportHtml(p, sol, G) };
        }""")
        (OUT / f"{NAME}_plan.dxf").write_text(data["planDxf"])
        (OUT / f"{NAME}_1to1.dxf").write_text(data["worldDxf"])
        (OUT / f"{NAME}.csv").write_text(data["csv"])
        (OUT / f"{NAME}.kml").write_text(data["kml"])

        def show(html, page_css):
            pg.evaluate("""([html, css]) => {
              document.querySelector('#pageStyle').textContent = css;
              document.querySelector('#printArea').innerHTML = html; }""", [html, page_css])
            pg.emulate_media(media="print")

        show(data["planSvg"].replace("<svg ", '<svg class="plan" '), "@page { size: 17in 11in; margin: 0; }")
        pg.pdf(path=str(OUT / f"{NAME}_plan.pdf"), prefer_css_page_size=True, print_background=True)
        pg.emulate_media(media="screen")

        show(data["report"], "@page { size: letter; margin: 0.55in; }")
        pg.pdf(path=str(OUT / f"{NAME}_report.pdf"), prefer_css_page_size=True, print_background=True)
        b.close()
    # PNG preview of the plan at 100 dpi
    subprocess.run(["pdftoppm", "-png", "-r", "100", "-singlefile", str(OUT / f"{NAME}_plan.pdf"),
                    str(OUT / f"{NAME}_plan")], check=True)
    if errs:
        raise SystemExit(f"page errors: {errs}")
    for f in sorted(OUT.iterdir()):
        print(f"wrote {f.relative_to(ROOT)} ({f.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
