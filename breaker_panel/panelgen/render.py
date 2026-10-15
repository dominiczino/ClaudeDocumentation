"""Export the drawing to DXF / DWG / SVG / PDF."""
from __future__ import annotations

import io
import os
import shutil
import tempfile

import ezdxf
from ezdxf.addons.drawing import Frontend, RenderContext, config, layout, svg

from .drawing import FRAME, SHEET_H, SHEET_W, build
from .model import Panel

_PAGE = layout.Page(SHEET_W * 25.4, SHEET_H * 25.4, layout.Units.mm,
                    margins=layout.Margins.all(FRAME * 25.4))
_CFG = config.Configuration(
    background_policy=config.BackgroundPolicy.WHITE,
    color_policy=config.ColorPolicy.COLOR,
    lineweight_policy=config.LineweightPolicy.ABSOLUTE,
    lineweight_scaling=1.0,
    hatch_policy=config.HatchPolicy.NORMAL,
)


def to_dxf_bytes(doc: ezdxf.document.Drawing) -> bytes:
    s = io.StringIO()
    doc.write(s)
    return s.getvalue().encode("utf-8")


def _render(doc, backend):
    Frontend(RenderContext(doc), backend, config=_CFG).draw_layout(doc.modelspace())


def to_svg(doc) -> str:
    backend = svg.SVGBackend()
    _render(doc, backend)
    return backend.get_string(_PAGE, settings=layout.Settings(fit_page=True))


def to_pdf(doc) -> bytes:
    from ezdxf.addons.drawing import pymupdf  # optional dependency
    backend = pymupdf.PyMuPdfBackend()
    _render(doc, backend)
    return backend.get_pdf_bytes(_PAGE, settings=layout.Settings(fit_page=True))


def dwg_available() -> bool:
    from ezdxf.addons import odafc
    try:
        return odafc.is_installed()
    except Exception:
        return False


def to_dwg(doc) -> bytes:
    """Requires the free ODA File Converter on PATH (ezdxf.addons.odafc)."""
    from ezdxf.addons import odafc
    tmp = tempfile.mkdtemp()
    try:
        path = os.path.join(tmp, "panel.dwg")
        odafc.export_dwg(doc, path, version="R2013", replace=True)
        with open(path, "rb") as f:
            return f.read()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def export(data: dict, fmt: str) -> tuple[bytes, str]:
    panel = Panel.from_dict(data)
    doc = build(panel)
    if fmt == "dxf":
        return to_dxf_bytes(doc), "application/dxf"
    if fmt == "dwg":
        return to_dwg(doc), "application/acad"
    if fmt == "pdf":
        return to_pdf(doc), "application/pdf"
    if fmt == "svg":
        return to_svg(doc).encode("utf-8"), "image/svg+xml"
    raise ValueError(f"unknown format {fmt}")
