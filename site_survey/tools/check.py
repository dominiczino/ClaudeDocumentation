"""Dev check for site-survey.html (needs playwright + ezdxf; not needed to use the app).

Loads the built page headless and checks, against the example's true coordinates
(tools/make_example.py):
  * every point is solved to within its stated 95% uncertainty (x1.5 slack),
  * a deliberately misread angle is flagged, and only readings that could be it,
  * missing scale, single sightings and bad entries produce the right advice,
  * "find" directions reproduce the stored point and never use a line through
    a building; lines through the deck (low) are allowed,
  * the GPS georeference recovers the true grid rotation, the imagery tiles land
    where the fit says, and GPS sets the scale when nothing was taped,
  * drawing an obstacle and picking a landmark on the imagery work in the UI,
  * plan and 1:1 DXFs read back in ezdxf and pass audit; report, CSV and KML build;
  * no JavaScript errors.
Imagery tiles are served locally (the tile servers are never contacted).
"""
import base64
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

# a 256 x 256 grey PNG, served for every imagery tile request
TILE_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQMAAABmvDolAAAAA1BMVEWAgICQdD0xAAAAH0lEQVRoge3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAABmmDh1QAAAABJRU5ErkJggg==")

JS = """([truth, geoTruth]) => {
  const out = {};
  const ex = () => SV.normalizeProject(JSON.parse(document.getElementById('examples').textContent).example_property);
  const p = ex(), sol = SV.solveProject(p), G = SV.georeference(p, sol);
  out.messages = [...sol.messages, ...SV.geoMessages(p, G), ...SV.obstacleMessages(p, sol)].map((m) => m.msg);
  out.errors = [];
  const err = (cond, msg) => { if (!cond) out.errors.push(msg); };
  for (const [id, t] of Object.entries(truth)) {
    const c = sol.coords.get(id), inf = sol.info.get(id);
    if (!c) { out.errors.push(id + ' not located'); continue; }
    const d = Math.hypot(c[0] - t[0], c[1] - t[1]);
    if (d > Math.max(0.01, 1.5 * inf.r95)) out.errors.push(`${id} off by ${d.toFixed(3)} (r95 ${inf.r95.toFixed(3)})`);
  }
  out.dof = sol.dof; out.sigma0 = sol.sigma0;
  // find: turning the given angles from the given stations must land on the point,
  // and neither line may pass through a building
  const shapes = SV.blockingShapes(p, sol);
  for (const x of p.points) {
    const id = x.id, X = sol.coords.get(id), f = SV.findOptions(p, sol, X, id);
    err(f.best && f.best.length === 2, 'no two clear setups for ' + id);
    for (const o of f.best || []) {
      const S = sol.coords.get(o.station), B = sol.coords.get(o.backsight);
      const az = azimuth(S[0], S[1], B[0], B[1]) + o.angle;
      const Y = [S[0] + o.dist * Math.sin(az), S[1] + o.dist * Math.cos(az)];
      err(Math.hypot(Y[0] - X[0], Y[1] - X[1]) < 1e-6, 'find mismatch for ' + id);
      err(!SV.sightBlocker(shapes, S, X, 0.25) && !SV.sightBlocker(shapes, S, B, 0.25), `find uses a blocked line for ${id} from ${o.station}`);
    }
  }
  const fw = SV.findOptions(p, sol, sol.coords.get('WELL'), 'WELL');
  out.wellA = fw.options.find((o) => o.station === 'A').blocked?.name || null;
  err(!fw.best.some((o) => o.station === 'A'), 'find for WELL uses LM-A through the house');
  err(SV.findOptions(p, sol, [5088, 4947]).inside?.name === 'House', 'spot inside the house not reported');
  err(!SV.sightBlocker(shapes, [5090, 4970], [5115, 4970], 0.25), 'the low deck blocked a sight line');
  err(SV.sightBlocker(shapes, [5060, 4947], [5115, 4947], 0.25)?.name === 'House', 'line through the house not blocked');
  const pc = ex();
  pc.setups[0].readings.push({ id: 'Rx', target: 'E3', reading: '30 00 00', dist: '', note: '' });
  out.conflict = SV.obstacleMessages(pc, SV.solveProject(pc)).map((m) => m.msg);
  // georeference: rotation recovered, tiles placed where the fit says
  out.geo = { theta: G.theta / DEG, sig: G.sigTheta / DEG, n: G.n };
  err(Math.abs(G.theta / DEG - geoTruth.gridAz) < 2.5 * G.sigTheta / DEG, `grid rotation ${(G.theta / DEG).toFixed(2)} vs ${geoTruth.gridAz}`);
  const llA = SV.localToLL(G, sol.coords.get('A'));
  out.geo.offA = Math.hypot((llA[0] - geoTruth.lat0) * 111132, (llA[1] - geoTruth.lon0) * 111320 * Math.cos(geoTruth.lat0 * DEG));
  err(out.geo.offA < 5, `LM-A placed ${out.geo.offA.toFixed(1)} m from its true lat/lon`);
  const Xt = sol.coords.get('E2'), back = SV.llToLocal(G, ...SV.localToLL(G, Xt));
  err(Math.hypot(back[0] - Xt[0], back[1] - Xt[1]) < 1e-6, 'lat/lon round trip');
  const toT = (w) => [(w[0] - 5000) * 4, (5100 - w[1]) * 4], fromT = (q) => [q[0] / 4 + 5000, 5100 - q[1] / 4];
  const tiles = SV.imageryTiles(p, G, toT, fromT, [0, 0, 800, 600], 0.3048 / 4);
  out.geo.tiles = tiles.length;
  const ll = SV.localToLL(G, Xt);
  let hit = false;
  for (const t of tiles) {
    const [z, y, x] = t.href.match(/(\\d+)\\/(\\d+)\\/(\\d+)$/).slice(1).map(Number);
    const px = SV.llToPx(ll[0], ll[1], z), u = px[0] - x * 256, v = px[1] - y * 256;
    if (u < 0 || u > 256 || v < 0 || v > 256) continue;
    const m = t.m, q = [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]], want = toT(Xt);
    err(Math.hypot(q[0] - want[0], q[1] - want[1]) < 0.05, `tile places E2 ${Math.hypot(q[0] - want[0], q[1] - want[1]).toFixed(3)} px off`);
    hit = true;
  }
  err(hit, 'no tile covers E2');
  // exact lat/lon -> exact fit
  const pe = ex();
  for (const l of pe.landmarks) { const c = sol.coords.get(l.id); [l.lat, l.lon] = SV.localToLL(G, c).map((v) => v.toFixed(10)); }
  const Ge = SV.georeference(pe, SV.solveProject(pe));
  err(Math.abs(Ge.theta - G.theta) < 1e-7 && [...Ge.resid.values()].every((r) => r.d < 1e-3), 'exact lat/lon did not fit exactly');
  // no tape: GPS sets the scale
  const pu = ex(); pu.baselines = [];
  const su = SV.solveProject(pu), Gu = SV.georeference(pu, su);
  const ab = Math.hypot(...[0, 1].map((k) => su.coords.get('A')[k] - su.coords.get('B')[k])) * Gu.s * 0.3048;
  const abTrue = Math.hypot(truth.A[0] - truth.B[0], truth.A[1] - truth.B[1]) * 0.3048;
  out.geo.scaleErr = ab / abTrue - 1;
  err(Gu.fitScale && Math.abs(out.geo.scaleErr) < 0.1, `GPS scale off by ${(100 * out.geo.scaleErr).toFixed(1)}%`);
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
  out.planDxf = SV.sheetToDxf(SV.renderPlan(p, sol, { geo: G }).sheet);
  out.worldDxf = SV.worldDxf(p, sol);
  out.report = SV.reportHtml(p, sol, G).length;
  const csv = SV.coordinatesCsv(p, sol, G).split('\\r\\n');
  out.csv = csv.length;
  const tail = csv[1].split(',').slice(-2).map(Number);
  err(/Latitude/.test(csv[0]) && Math.abs(tail[0] - 40.77) < 0.01 && Math.abs(tail[1] + 73.97) < 0.01, 'CSV has no lat/lon');
  const kml = new DOMParser().parseFromString(SV.siteKml(p, sol, G), 'application/xml');
  err(!kml.querySelector('parsererror'), 'KML does not parse');
  out.kml = kml.getElementsByTagName('Placemark').length;
  return out;
}"""

# UI: map imagery, print with imagery, drawing an obstacle, picking a landmark on the imagery
UI_JS = """async () => {
  const out = { errors: [] };
  const err = (c, m) => { if (!c) out.errors.push(m); };
  const A = SV.APP;
  out.images = document.querySelectorAll('#mapSvg .imagery image').length;
  A.p.geo.print = true;
  const svg = await SV.planPrintSvg(A.p, A.sol, A.geo, { interactive: false });
  err(/clip-path="url\\(#mapclip\\)"/.test(svg) && /<image /.test(svg), 'printed plan has no imagery');
  A.p.geo.print = false;
  return out;
}"""


def screen_of(pg, X):
    """Page coordinates of survey point X on the map."""
    return pg.evaluate("""(X) => {
      const v = SV.MAP.view, r = document.querySelector('#mapSvg').getBoundingClientRect();
      return [r.left + r.width / 2 + (X[0] - v.cx) * v.ppu, r.top + r.height / 2 - (X[1] - v.cy) * v.ppu];
    }""", X)


def ui_checks(pg, failures):
    r = pg.evaluate(UI_JS)
    failures += r["errors"]
    if not r["images"]:
        failures.append("no imagery on the map")
    # draw a triangle obstacle, then drag its first corner
    pg.click("#tabs [data-tab=obstacles]")
    n0 = pg.evaluate("SV.APP.p.obstacles.length")
    pg.click("text=+ Add obstacle")
    for X in ([5020, 4950], [5035, 4950], [5028, 4962]):
        pg.mouse.click(*screen_of(pg, X))
        pg.wait_for_timeout(150)
    ob = pg.evaluate("SV.APP.p.obstacles[SV.APP.p.obstacles.length - 1]")
    if pg.evaluate("SV.APP.p.obstacles.length") != n0 + 1 or len(ob["pts"]) != 3 or abs(ob["pts"][0][0] - 5020) > 0.5:
        failures.append(f"drawing an obstacle gave {ob}")
    x, y = screen_of(pg, [5020, 4950])
    pg.mouse.move(x, y); pg.mouse.down(); pg.mouse.move(x - 20, y, steps=4); pg.mouse.up()
    pg.wait_for_timeout(150)
    moved = pg.evaluate("SV.APP.p.obstacles[SV.APP.p.obstacles.length - 1].pts[0]")
    if not (moved[0] < 5018 and abs(moved[1] - 4950) < 0.5):
        failures.append(f"dragging a corner gave {moved}")
    pg.keyboard.press("Escape")
    if pg.evaluate("SV.APP.edit"):
        failures.append("Escape did not end drawing")
    print(f"ok  obstacle drawn by clicking (3 corners) and a corner dragged to E {moved[0]:.1f}")
    # pick LM-M (no lat/lon in the example) on the imagery
    pg.click("#tabs [data-tab=landmarks]")
    before = pg.evaluate("SV.localToLL(SV.APP.geo, SV.APP.sol.coords.get('M'))")
    pg.locator(".card[data-id=M] button", has_text="Pick").click()
    pg.mouse.click(*screen_of(pg, pg.evaluate("SV.APP.sol.coords.get('M')")))
    pg.wait_for_timeout(200)
    m = pg.evaluate("(() => { const l = SV.APP.p.landmarks.find((x) => x.id === 'M'); return [+l.lat, +l.lon, l.gsrc, SV.APP.geo.n]; })()")
    d = math.hypot((m[0] - before[0]) * 111132, (m[1] - before[1]) * 84000)
    if m[2] != "image" or m[3] != 5 or d > 0.3:
        failures.append(f"picking LM-M on the imagery gave {m} ({d:.2f} m from the click)")
    print(f"ok  imagery: {r['images']} tiles on the map; LM-M picked on it ({d:.2f} m), fit now uses {m[3]} landmarks")


def main():
    failures = []
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=CHROMIUM)
        pg = b.new_page(viewport={"width": 1500, "height": 950})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        tiles = []
        pg.route("**/tile/**", lambda route: (tiles.append(route.request.url), route.fulfill(body=TILE_PNG, content_type="image/png")))
        pg.goto(PAGE)
        pg.wait_for_selector("#mapSvg g", timeout=20000)
        for tab in ["project", "landmarks", "book", "points", "lines", "obstacles", "find"]:
            pg.click(f"#tabs [data-tab={tab}]")
        r = pg.evaluate(JS, [TRUTH["coords"], TRUTH])
        ui_checks(pg, failures)
        b.close()
        if not tiles or any("arcgisonline.com" not in t for t in tiles):
            failures.append(f"unexpected tile requests {tiles[:3]}")
    failures += r["errors"]
    if r["messages"]:
        failures.append(f"example should solve cleanly, got {r['messages']}")
    print(f"ok  example: {len(TRUTH['coords'])} points within their 95% radius; {r['dof']} redundant; fit {r['sigma0']:.2f}")
    g = r["geo"]
    print(f"ok  georeference: grid north {g['theta']:+.2f} deg (true {TRUTH['gridAz']:+.2f}, sigma {g['sig']:.2f}); "
          f"LM-A within {g['offA']:.1f} m; {g['tiles']} tiles; GPS-only scale {100 * g['scaleErr']:+.1f}%")
    if r["wellA"] != "House":
        failures.append(f"LM-A -> WELL should be blocked by the house, got {r['wellA']}")
    if not any("passes through House" in m for m in r["conflict"]):
        failures.append(f"sighting through the house not reported: {r['conflict']}")
    print(f"ok  obstacles: find avoids the house (LM-A -> WELL blocked by {r['wellA']}); sighting through it reported")
    if r["kml"] != len(TRUTH["coords"]) + 4 + 3:
        failures.append(f"KML has {r['kml']} placemarks")
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
    if r["report"] < 5000 or r["csv"] < len(TRUTH["coords"]) + 1:
        failures.append("report/csv too small")
    if errs:
        failures.append(f"page errors {errs}")
    if failures:
        print("\nFAILED:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
