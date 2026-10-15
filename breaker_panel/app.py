"""Breaker panel directory drawing generator - web app.

Run:  python app.py   then open http://127.0.0.1:5000
"""
from __future__ import annotations

import json
import pathlib
import re

from flask import Flask, Response, jsonify, request, send_from_directory

from panelgen.drawing import build
from panelgen.model import Panel, PanelError
from panelgen.render import dwg_available, export, to_svg

ROOT = pathlib.Path(__file__).parent
app = Flask(__name__, static_folder=str(ROOT / "static"), static_url_path="/static")


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/capabilities")
def capabilities():
    return jsonify(dwg=dwg_available())


@app.get("/api/example")
def example():
    return jsonify(json.loads((ROOT / "examples" / "main_panel.json").read_text()))


@app.post("/api/preview")
def preview():
    try:
        panel = Panel.from_dict(request.get_json(force=True))
    except PanelError as e:
        return jsonify(errors=e.errors), 400
    svg = to_svg(build(panel))
    return jsonify(svg=svg, warnings=panel.warnings, stats=panel.stats())


@app.post("/api/export/<fmt>")
def export_file(fmt: str):
    if fmt not in ("dxf", "dwg", "pdf", "svg"):
        return jsonify(errors=[f"Unsupported format {fmt}"]), 400
    if fmt == "dwg" and not dwg_available():
        return jsonify(errors=["DWG export needs the free ODA File Converter installed on the server. "
                               "Use DXF instead - every CAD program opens it."]), 501
    data = request.get_json(force=True)
    try:
        blob, mime = export(data, fmt)
    except PanelError as e:
        return jsonify(errors=e.errors), 400
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", str(data.get("name") or "panel")).strip("_") or "panel"
    return Response(blob, mimetype=mime,
                    headers={"Content-Disposition": f'attachment; filename="{name}.{fmt}"'})


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5000)
    a = ap.parse_args()
    app.run(host=a.host, port=a.port, debug=False)
