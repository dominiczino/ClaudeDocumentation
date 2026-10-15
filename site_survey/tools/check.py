"""Dev check for site-survey.html (needs playwright + ezdxf; not needed to use the app).

Loads the built page headless and checks, against the example's true coordinates
(tools/make_example.py):
  * every point is solved to within its stated 95% uncertainty (x1.5 slack),
  * a deliberately misread angle is flagged, and only readings that could be it,
  * missing scale, single sightings and bad entries produce the right advice,
  * "find" directions reproduce the stored point,
  * plan and 1:1 DXFs read back in ezdxf and pass audit; report and CSV build;
  * no JavaScript errors.
"""
import io
import json
import math
import os
import pathlib
import subprocess
import sys

import ezdxf
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
PAGE = (ROOT / "site-survey.html").as_uri()
CHROMIUM = os.environ.get("CHROMIUM", "/opt/pw-browsers/chromium")
TRUTH = json.loads(subprocess.check_output([sys.executable, str(ROOT / "tools" / "make_example.py"), "--truth"]))

JS = """(truth) => {
  const out = {};
  const ex = () => SV.normalizeProject(JSON.parse(document.getElementById('examples').textContent).example_property);
  const p = ex(), sol = SV.solveProject(p);
  out.messages = sol.messages.map((m) => m.msg);
  out.errors = [];
  for (const [id, t] of Object.entries(truth)) {
    const c = sol.coords.get(id), inf = sol.info.get(id);
    if (!c) { out.errors.push(id + ' not located'); continue; }
    const d = Math.hypot(c[0] - t[0], c[1] - t[1]);
    if (d > Math.max(0.01, 1.5 * inf.r95)) out.errors.push(`${id} off by ${d.toFixed(3)} (r95 ${inf.r95.toFixed(3)})`);
  }
  out.dof = sol.dof; out.sigma0 = sol.sigma0;
  // find: turning the given angles from the given stations must land on the point
  for (const id of ['W3', 'E1', 'DB']) {
    const X = sol.coords.get(id), f = SV.findOptions(p, sol, X, id);
    for (const o of f.best) {
      const S = sol.coords.get(o.station), B = sol.coords.get(o.backsight);
      const az = azimuth(S[0], S[1], B[0], B[1]) + o.angle;
      const Y = [S[0] + o.dist * Math.sin(az), S[1] + o.dist * Math.cos(az)];
      if (Math.hypot(Y[0] - X[0], Y[1] - X[1]) > 1e-6) out.errors.push('find mismatch for ' + id);
    }
  }
  // blunder in the best-controlled reading to a point: big enough to be detectable
  const best = sol.obs.filter((o) => o.kind === 'angle' && p.points.some((x) => x.id === o.fs))
    .sort((a, b) => b.rnum - a.rnum)[0];
  out.blunderTarget = best.at + '>' + best.fs;
  const pb = ex();
  const r = pb.setups.find((s) => s.id === best.ref.setup).readings.find((x) => x.id === best.ref.reading);
  const size = Math.max(300, 8 * best.sigma / Math.sqrt(best.rnum) / SEC);
  r.reading = SV.fmtDMS(SV.parseAngle(r.reading) + size * SEC).replace(/[°'"]/g, ' ');
  const sb = SV.solveProject(pb);
  out.blunder = sb.messages.filter((m) => /Suspect|One of these/.test(m.msg)).map((m) => m.msg);
  out.blunderFlags = sb.obs.filter((o) => o.flag).map((o) => o.at + '>' + o.fs);
  // no distances, a once-sighted point, a bad entry
  const pw = ex();
  pw.baselines = [];
  const w4 = pw.points.find((x) => x.name === 'W4').id;
  const keep = pw.setups.find((s) => s.readings.some((x) => x.target === w4));
  for (const s of pw.setups) if (s !== keep) s.readings = s.readings.filter((x) => x.target !== w4);
  out.keepName = pw.landmarks.find((l) => l.id === keep.station).name;
  pw.setups[0].readings[0].reading = '97 61 00';
  out.weak = SV.solveProject(pw).messages.map((m) => m.lvl + ': ' + m.msg);
  // outputs
  out.planDxf = SV.sheetToDxf(SV.renderPlan(p, sol).sheet);
  out.worldDxf = SV.worldDxf(p, sol);
  out.report = SV.reportHtml(p, sol).length;
  out.csv = SV.coordinatesCsv(p, sol).split('\\r\\n').length;
  return out;
}"""


def main():
    failures = []
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=CHROMIUM)
        pg = b.new_page(viewport={"width": 1500, "height": 950})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(PAGE)
        pg.wait_for_selector("#mapSvg g", timeout=20000)
        for tab in ["project", "landmarks", "book", "points", "lines", "find"]:
            pg.click(f"#tabs [data-tab={tab}]")
        r = pg.evaluate(JS, TRUTH)
        b.close()
    failures += r["errors"]
    if r["messages"]:
        failures.append(f"example should solve cleanly, got {r['messages']}")
    print(f"ok  example: {len(TRUTH)} points within their 95% radius; {r['dof']} redundant; fit {r['sigma0']:.2f}")
    if len(r["blunder"]) != 1:
        failures.append(f"blunder not isolated: {r['blunder']}")
    else:
        print(f"ok  misread angle flagged: {r['blunder'][0][:110]}...")
    if r["blunderTarget"] not in r["blunderFlags"]:
        failures.append(f"wrong reading not among flags {r['blunderFlags']}")
    want = ["No measured distance", f"W4 is sighted only from {r['keepName']}", "Can't read the angle"]
    for w in want:
        if not any(w in m for m in r["weak"]):
            failures.append(f"missing advice '{w}' in {r['weak']}")
    print(f"ok  advice: {len(r['weak'])} messages for a degraded survey")
    for name in ["planDxf", "worldDxf"]:
        doc = ezdxf.read(io.StringIO(r[name]))
        a = doc.audit()
        if a.has_errors:
            failures.append(f"{name} audit: {[str(e) for e in a.errors]}")
        print(f"ok  {name}: {len(doc.modelspace())} entities, $INSUNITS {doc.header['$INSUNITS']}")
    if r["report"] < 5000 or r["csv"] < len(TRUTH) + 1:
        failures.append("report/csv too small")
    if errs:
        failures.append(f"page errors {errs}")
    if failures:
        print("\nFAILED:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
