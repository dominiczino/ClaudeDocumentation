/* =========================================================================
 * Printable survey report (US Letter): datum, coordinates, field book with
 * residuals, and a "how to find it" card for every point.
 * ========================================================================= */

const h = (s) => esc(String(s ?? ""));

/** Site figure for the report, `wIn` x `hIn` inches. */
function reportFigure(p, sol, wIn = 7.3, hIn = 4.6) {
  const W = wIn * 96, H = hIn * 96;
  const ext = siteExtents(sol, p);
  if (!ext) return "";
  const ppu = Math.min((W - 110) / Math.max(R.w(ext), 1), (H - 70) / Math.max(R.h(ext), 1));
  const T = (w) => [(w[0] - R.cx(ext)) * ppu + W / 2, (w[1] - R.cy(ext)) * ppu + H / 2];
  const sh = new Sheet(FONTS[p.font] || FONTS[DEFAULT_FONT]);
  drawSite(sh, p, sol, T, { th: 7.5, sym: 13, sights: !!p.planSights, ellipses: 0, letterEvery: 130, k: ppu });
  const unit = niceStep(80 / ppu);
  return `<svg viewBox="0 0 ${W} ${H}" width="${wIn}in" height="${hIn}in" font-family="${sh.font.css.replace(/"/g, "'")}">` +
    `<rect width="${W}" height="${H}" fill="#fff" stroke="#999"/>${sheetToPxSvg(sh, H, { strokeScale: 0.8 })}` +
    `<path d="M${W - 26} 16l7 20l-7-5l-7 5z" fill="#333"/><text x="${W - 26}" y="13" text-anchor="middle" font-size="10" font-weight="bold">N</text>` +
    `<rect x="12" y="${H - 18}" width="${unit * ppu}" height="5" fill="#333"/><text x="12" y="${H - 23}" font-size="9">${+unit.toFixed(2)} ${unitAbbr(p)}</text></svg>`;
}

function findCardHtml(p, sol, name, X, targetId, G = null) {
  const ents = entities(p);
  const nm = (id) => ents.get(id)?.name || "?";
  const f = findOptions(p, sol, X, targetId);
  const dir = p.circle === "cw" ? "clockwise" : "counter-clockwise";
  const ll = G && G.ok ? localToLL(G, X) : null;
  let s = `<div class="card"><div class="card-h">${h(name)}<span>N ${X[1].toFixed(2)} &nbsp; E ${X[0].toFixed(2)}` +
          `${ll ? ` &nbsp;·&nbsp; ${ll[0].toFixed(6)}, ${ll[1].toFixed(6)}` : ""}</span></div>`;
  if (f.inside) s += `<div class="card-n"><b>This spot is inside ${h(f.inside.name || "an obstacle")}.</b> Lines into it are not checked against that outline.</div>`;
  const blk = f.nBlocked ? ` ${f.nBlocked} other setup${f.nBlocked > 1 ? "s are" : " is"} blocked by obstacles.` : "";
  if (f.best) {
    s += `<ol>`;
    for (const o of f.best) {
      s += `<li>Set up on <b>${h(nm(o.station))}</b>, sight <b>${h(nm(o.backsight))}</b> and set the circle to 0°00'00". ` +
           `Turn ${dir} to <b>${fmtDMS(o.reading)}</b>; the point is <b>${fmtLen(p, o.dist)}</b> out along that line.` +
           `${targetId && !o.seen ? ' <i>(line of sight not yet checked)</i>' : ""}</li>`;
    }
    s += f.best.length > 1 ? `</ol><div class="card-n">Where the two lines cross: expected within ±${fmtLen(p, f.sigma95, 2)} (95%).${blk}`
      : `</ol><div class="card-n"><b>Only one landmark has a clear line to this spot</b>, so use the distance along it and the tape check.${blk}`;
  } else s += `<div class="card-n">${f.nBlocked ? "Every setup's line to this spot is blocked by an obstacle." : "Not enough located landmarks to set up on."}`;
  if (f.tapes.length >= 2) {
    s += ` Tape check: ${f.tapes.slice(0, 2).map((t) => `${fmtLen(p, t.dist)} from ${h(nm(t.id))}`).join(" and ")}` +
         `${f.tapes.length > 2 ? `; ${fmtLen(p, f.tapes[2].dist)} from ${h(nm(f.tapes[2].id))}` : ""}.`;
  }
  return s + "</div></div>";
}

function reportHtml(p, sol, G = null) {
  const ents = entities(p);
  const nm = (id) => ents.get(id)?.name || "?";
  const u = unitAbbr(p);
  const nA = sol.obs.filter((o) => o.kind === "angle").length, nD = sol.obs.filter((o) => o.kind === "dist").length;
  const located = [...ents.keys()].filter((id) => sol.coords.has(id)).length;
  let s = `<div class="rep"><header><h1>${h(p.name)}</h1><div>${h(p.location)}</div>` +
          `<div class="meta">Surveyed by ${h(p.surveyor || "—")} · Report printed ${isoToday()}</div></header>`;
  s += `<div class="fig">${reportFigure(p, sol)}</div>`;

  // datum and quality
  const msgs = sol.messages.filter((m) => m.lvl !== "info");
  s += `<h2>Datum and solution</h2><table class="kv">` +
       `<tr><th>Coordinates</th><td>Local, in ${UNITS[p.units].name}. ${h(nm(p.datum.origin))} held at N ${p.datum.originN.toFixed(2)}, E ${p.datum.originE.toFixed(2)}.</td></tr>` +
       `<tr><th>Basis of bearings</th><td>${h(nm(p.datum.origin))} to ${h(nm(p.datum.orient))} = ${fmtBearing(parseBearing(p.datum.bearing))} (grid north).</td></tr>` +
       `<tr><th>Measurements</th><td>${nA} angles, ${nD} distances. Reading precision assumed ${p.angleSigma}" (one pointing); distances ±(${p.distSigma.fixed} ${u} + 1:${p.distSigma.ratio}).</td></tr>` +
       `<tr><th>Solution</th><td>${located} of ${ents.size} located. ${sol.dof} redundant measurements` +
       `${sol.sigma0 ? `; readings fit at ${sol.sigma0.toFixed(2)}× the assumed precision` : ""}.` +
       `${sol.unscaled ? " <b>No measured distance: arbitrary scale.</b>" : ""}</td></tr>` +
       `${G && G.ok && !G.single ? `<tr><th>Georeference</th><td>Grid north is ${gridNorthText(G.theta)} (±${fmtDMS(2 * G.sigTheta).replace(/^0°/, "")}, 95%), ` +
         `from a fit to the latitude/longitude of ${G.n} landmarks${G.sigma0 !== null ? `; they agree with the survey to ${fmtLen(p, rmsGeo(G), 1)} RMS` : ""}.` +
         `${G.fitScale ? " Scale taken from GPS." : ""} Latitudes/longitudes below are good to a few ${p.units === "m" ? "metres" : "feet"}, enough to walk to a spot with a phone.</td></tr>` : ""}` +
       `${msgs.length ? `<tr><th>Open items</th><td><ul>${msgs.map((m) => `<li>${h(m.msg)}</li>`).join("")}</ul></td></tr>` : ""}</table>`;

  // landmarks
  const geo = G && G.ok;
  s += `<h2>Landmarks (control)</h2><table class="grid"><tr><th>Name</th><th>Northing</th><th>Easting</th><th>±95%</th>` +
       `${geo ? "<th>Latitude, longitude</th>" : ""}<th>Description / how to find it</th></tr>`;
  for (const l of p.landmarks) {
    const c = sol.coords.get(l.id), inf = sol.info.get(l.id);
    const ll = geo && c ? localToLL(G, c) : null;
    s += `<tr><td><b>${h(l.name)}</b></td><td class="n">${c ? c[1].toFixed(2) : "—"}</td><td class="n">${c ? c[0].toFixed(2) : "—"}</td>` +
         `<td class="n">${inf ? inf.r95.toFixed(2) : "—"}</td>${geo ? `<td class="n">${ll ? `${ll[0].toFixed(6)}, ${ll[1].toFixed(6)}` : "—"}</td>` : ""}<td>${h(l.desc)}</td></tr>`;
  }
  s += `</table>`;

  // points
  s += `<h2>Points</h2><table class="grid"><tr><th>Name</th><th>Type</th><th>Northing</th><th>Easting</th><th>±95%</th><th>Check</th><th>Depth</th><th>Description</th></tr>`;
  for (const x of p.points) {
    const c = sol.coords.get(x.id), inf = sol.info.get(x.id);
    s += `<tr><td><b>${h(x.name)}</b></td><td>${h((TYPES[x.type] || TYPES[""]).name)}</td><td class="n">${c ? c[1].toFixed(2) : "—"}</td>` +
         `<td class="n">${c ? c[0].toFixed(2) : "—"}</td><td class="n">${inf ? inf.r95.toFixed(2) : "—"}</td>` +
         `<td>${inf ? (inf.checked ? "yes" : "no") : "—"}</td><td>${h(x.depth)}</td><td>${h(x.desc)}</td></tr>`;
  }
  s += `</table><p class="small">“Check” = the point is seen from enough different directions that a misread angle would have shown up as a flagged reading.</p>`;

  // lines
  if (p.lines.length) {
    s += `<h2>Lines</h2><table class="grid"><tr><th>Name</th><th>Type</th><th>Route</th><th>Length</th><th>Depth</th><th>Description</th></tr>`;
    for (const l of p.lines) {
      s += `<tr><td><b>${h(l.name)}</b></td><td>${h((TYPES[l.type] || TYPES[""]).name)}</td><td>${l.pts.map((id) => h(nm(id))).join(" → ")}</td>` +
           `<td class="n">${fmtLen(p, lineLength(sol, l), 1)}</td><td>${h(l.depth)}</td><td>${h(l.desc)}</td></tr>`;
    }
    s += `</table>`;
  }

  if (p.obstacles.length) {
    s += `<h2>Obstacles</h2><table class="grid"><tr><th>Name</th><th>Kind</th><th>Blocks sight</th><th>Corners</th><th>Description</th></tr>`;
    for (const o of p.obstacles) {
      s += `<tr><td><b>${h(o.name)}</b></td><td>${h(OBSTACLE_KINDS[o.kind].name)}</td><td>${o.blocks ? "yes" : "no"}</td>` +
           `<td class="n">${obstacleCoords(sol, o).length}</td><td>${h(o.desc)}</td></tr>`;
    }
    s += `</table>`;
  }

  // field book
  s += `<h2>Field book</h2><table class="grid fb"><tr><th>Date</th><th>Station</th><th>Backsight</th><th>Target</th><th>Reading</th><th>Angle right</th><th>Distance</th><th>Residual</th><th>Note</th></tr>`;
  for (const st of p.setups) {
    st.readings.forEach((r, i) => {
      const oa = sol.obs.find((o) => o.kind === "angle" && o.ref?.reading === r.id);
      const od = sol.obs.find((o) => o.kind === "dist" && o.ref?.reading === r.id);
      const resid = [oa && oa.v !== undefined ? fmtSec(oa.v) : "", od && od.v !== undefined ? fmtLen(p, od.v, 3) : ""].filter(Boolean).join(" / ");
      const flag = (oa && oa.flag) || (od && od.flag);
      s += `<tr class="${flag ? "flag" : ""}${r.off ? " off" : ""}"><td>${i ? "" : h(st.date)}</td><td>${i ? "" : `<b>${h(nm(st.station))}</b>`}</td>` +
           `<td>${i ? "" : `${h(nm(st.backsight))} @ ${h(st.bsReading || "0")}`}</td><td>${h(nm(r.target))}</td><td>${h(r.reading)}</td>` +
           `<td>${oa ? fmtDMS(oa.value) : ""}</td><td class="n">${h(r.dist)}</td><td class="n">${resid}${flag ? " ⚠" : ""}</td>` +
           `<td>${r.off ? "IGNORED. " : ""}${h(r.note)}</td></tr>`;
    });
  }
  for (const b of p.baselines) {
    const od = sol.obs.find((o) => o.kind === "dist" && o.ref?.baseline === b.id);
    s += `<tr class="${od && od.flag ? "flag" : ""}${b.off ? " off" : ""}"><td></td><td colspan="3">Taped: ${h(nm(b.a))} – ${h(nm(b.b))}</td><td></td><td></td>` +
         `<td class="n">${h(b.dist)}</td><td class="n">${od && od.v !== undefined ? fmtLen(p, od.v, 3) : ""}</td><td>${b.off ? "IGNORED. " : ""}${h(b.note)}</td></tr>`;
  }
  s += `</table>`;

  // finding cards
  s += `<h2 class="break">How to find each point</h2><div class="cards">`;
  for (const x of p.points) {
    const c = sol.coords.get(x.id);
    if (c) s += findCardHtml(p, sol, `${x.name}${x.desc ? " — " + x.desc : ""}`, c, x.id, G);
  }
  s += `</div>`;
  if (p.notes.some((n) => n.trim())) s += `<h2>Notes</h2><ol>${p.notes.filter((n) => n.trim()).map((n) => `<li>${h(n)}</li>`).join("")}</ol>`;
  return s + "</div>";
}
