import json
import pathlib

import ezdxf
import pytest

from panelgen.drawing import build
from panelgen.model import Panel, PanelError
from panelgen.render import to_dxf_bytes, to_svg

EX = json.loads((pathlib.Path(__file__).parents[1] / "examples" / "main_panel.json").read_text())


def _roundtrip(doc):
    import io
    d2 = ezdxf.read(io.StringIO(to_dxf_bytes(doc).decode()))
    auditor = d2.audit()
    assert not auditor.has_errors, [str(e) for e in auditor.errors]
    return d2


def test_example_builds_and_audits():
    doc = build(Panel.from_dict(EX))
    d2 = _roundtrip(doc)
    assert "ANSI B" in d2.layouts
    assert d2.units == ezdxf.units.IN
    texts = [e.dxf.text for e in d2.modelspace().query("TEXT")]
    assert "RANGE / OVEN" in texts and "10A" in texts and "14A" in texts


def test_all_content_inside_frame():
    from ezdxf import bbox
    doc = build(Panel.from_dict(EX))
    ext = bbox.extents(doc.modelspace())
    assert ext.extmin.x >= 0.39 and ext.extmin.y >= 0.39
    assert ext.extmax.x <= 10.61 and ext.extmax.y <= 16.61


def test_sequential_numbering_geometry():
    p = Panel.from_dict({"spaces": 20, "numbering": "sequential", "breakers": []})
    assert p.slot(1).col == 0 and p.slot(10).row == 9 and p.slot(11).col == 1 and p.slot(11).row == 0
    assert p.space_at(1, 0) == 11


def test_overlap_rejected():
    with pytest.raises(PanelError):
        Panel.from_dict({"spaces": 20, "breakers": [
            {"space": 1, "kind": "double", "amps": 30}, {"space": 3, "kind": "single", "amps": 20}]})


def test_runs_off_bottom_rejected():
    with pytest.raises(PanelError):
        Panel.from_dict({"spaces": 12, "breakers": [{"space": 11, "kind": "double"}]})


def test_bad_tie_is_warning():
    p = Panel.from_dict({"spaces": 12, "breakers": [{"space": 1, "kind": "single", "tie_below": True}]})
    assert p.warnings and not p.breakers[0].tie_below


@pytest.mark.parametrize("cfg", [
    {"spaces": 2, "breakers": [{"space": 1, "kind": "single", "amps": 20, "label": "x"}]},
    {"spaces": 12, "main": {"kind": "lugs", "amps": 100}, "breakers": [
        {"space": 1, "kind": "quad", "a": {"amps": 30}, "b": {"amps": 20}}]},
    {"spaces": 84, "phases": 3, "voltage": "120/208V 3Φ 4W", "main": {"kind": "lugs"},
     "numbering": "sequential",
     "breakers": [{"space": i, "kind": "triple", "amps": 100, "label": "Long " * 30} for i in (1, 4, 43)]
     + [{"space": 7, "kind": "tandem", "a": {"amps": 15, "label": "A " * 40}, "b": {"amps": 15}}],
     "notes": ["n " * 200]},
])
def test_variants_build(cfg):
    doc = build(Panel.from_dict(cfg))
    _roundtrip(doc)
    assert to_svg(doc).startswith("<?xml") or "<svg" in to_svg(doc)[:500]


def test_notes_block_beside_title_block():
    from panelgen.drawing import IY0, TB_H, Sheet, draw_notes
    few = Panel.from_dict({"spaces": 12, "notes": ["one", "two"]})
    assert draw_notes(Sheet(), few) == pytest.approx(IY0 + TB_H)
    many = Panel.from_dict({"spaces": 12, "notes": ["long note " * 20] * 6})
    assert draw_notes(Sheet(), many) > IY0 + TB_H
