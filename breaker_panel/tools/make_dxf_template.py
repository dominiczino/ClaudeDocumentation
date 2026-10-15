"""Regenerate the DXF template embedded in panel-drafter.html (dev tool, needs ezdxf).

The template holds everything except the drawing entities: header, layers,
linetypes, Arial text styles and the "ANSI B" paper-space layout with a 1:1
viewport. The page splices its entities in at ``%%ENTITIES%%`` and writes the
next free handle at ``%%HANDSEED%%``.

    python tools/make_dxf_template.py > /tmp/tpl.json
    then replace the contents of <script id="dxf-template"> with that JSON.
"""
import io
import json

import ezdxf

SHEET_W, SHEET_H = 11.0, 17.0
LAYERS = {
    "FRAME": (7, 60, "CONTINUOUS"), "FRAME-THIN": (7, 18, "CONTINUOUS"),
    "TITLE": (7, 35, "CONTINUOUS"), "TITLE-GRID": (7, 18, "CONTINUOUS"),
    "TEXT": (7, 25, "CONTINUOUS"), "TEXT-MINOR": (8, 18, "CONTINUOUS"),
    "ENCLOSURE": (7, 50, "CONTINUOUS"), "DEADFRONT": (7, 25, "CONTINUOUS"),
    "BUS": (7, 35, "CONTINUOUS"), "BREAKER": (7, 35, "CONTINUOUS"),
    "HANDLE": (7, 25, "CONTINUOUS"), "TIE": (7, 50, "CONTINUOUS"),
    "FILLER": (8, 18, "DASHED"), "HATCH": (8, 9, "CONTINUOUS"),
    "SHADE": (254, 0, "CONTINUOUS"), "TABLE": (7, 35, "CONTINUOUS"),
    "TABLE-GRID": (8, 13, "CONTINUOUS"),
}


def main():
    doc = ezdxf.new("R2013", setup=False, units=ezdxf.units.IN)
    hdr = doc.header
    hdr["$MEASUREMENT"] = 0
    hdr["$LWDISPLAY"] = 1
    hdr["$LTSCALE"] = 0.25
    hdr["$PSLTSCALE"] = 0
    hdr["$EXTMIN"] = (0, 0, 0)
    hdr["$EXTMAX"] = (SHEET_W, SHEET_H, 0)
    hdr["$LIMMAX"] = (SHEET_W, SHEET_H)
    doc.linetypes.add("DASHED", pattern=[0.75, 0.5, -0.25], description="Dashed __ __ __ __")
    for name, (color, lw, lt) in LAYERS.items():
        layer = doc.layers.add(name, color=color, linetype=lt)
        layer.dxf.lineweight = lw
    doc.styles.add("PANEL-STD", font="arial.ttf")
    doc.styles.add("PANEL-BOLD", font="arialbd.ttf")
    doc.layouts.rename("Layout1", "ANSI B")
    psp = doc.layouts.get("ANSI B")
    psp.page_setup(size=(SHEET_W, SHEET_H), margins=(0, 0, 0, 0), units="inch")
    psp.add_viewport(center=(SHEET_W / 2, SHEET_H / 2), size=(SHEET_W, SHEET_H),
                     view_center_point=(SHEET_W / 2, SHEET_H / 2), view_height=SHEET_H)
    doc.set_modelspace_vport(height=SHEET_H, center=(SHEET_W / 2, SHEET_H / 2))

    owner = doc.modelspace().block_record_handle
    s = io.StringIO()
    doc.write(s)
    txt = s.getvalue()
    seed = doc.header["$HANDSEED"]
    i = txt.index("\nENTITIES\n") + len("\nENTITIES\n")
    j = txt.index("  0\nENDSEC\n", i)
    txt = txt[:j] + "%%ENTITIES%%" + txt[j:]
    k = txt.index("$HANDSEED\n  5\n") + len("$HANDSEED\n  5\n")
    txt = txt[:k] + "%%HANDSEED%%" + txt[k + len(seed):]
    print(json.dumps({"owner": owner, "seed": seed, "dxf": txt}))


if __name__ == "__main__":
    main()
