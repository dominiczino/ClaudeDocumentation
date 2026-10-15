"""Regenerate src/dxf_template.json (dev tool, needs ezdxf).

The template holds everything except the drawing entities: header, layers,
linetypes, text styles and the "ANSI B" paper-space layout (17 x 11 landscape)
with a 1:1 viewport. The page splices its entities in at %%ENTITIES%%, writes
the next free handle at %%HANDSEED%%, and swaps the style font files.

Layer names/colors/lineweights must match LAYERS in src/js/02-sheet.js.

    python tools/make_dxf_template.py      # then: python tools/build.py
"""
import io
import json
import pathlib

import ezdxf

SHEET_W, SHEET_H = 17.0, 11.0
LAYERS = {
    # name: (ACI color, lineweight 1/100 mm, linetype)
    "FRAME": (7, 60, "CONTINUOUS"), "FRAME-THIN": (7, 18, "CONTINUOUS"),
    "TITLE": (7, 35, "CONTINUOUS"), "TITLE-GRID": (7, 18, "CONTINUOUS"),
    "TEXT": (7, 25, "CONTINUOUS"), "TEXT-MINOR": (8, 18, "CONTINUOUS"),
    "LABEL": (7, 18, "CONTINUOUS"),
    "MAP-FRAME": (7, 35, "CONTINUOUS"), "GRID": (8, 13, "CONTINUOUS"), "NORTH": (7, 25, "CONTINUOUS"),
    "SYMBOL-FILL": (7, 0, "CONTINUOUS"),
    "CONTROL": (7, 35, "CONTINUOUS"), "POINT": (7, 25, "CONTINUOUS"),
    "SIGHT": (8, 13, "DASHED"), "ELLIPSE": (8, 13, "CONTINUOUS"),
    "UT-ELEC": (1, 50, "CONTINUOUS"), "UT-GAS": (40, 50, "CONTINUOUS"), "UT-COMM": (30, 50, "CONTINUOUS"),
    "UT-WATER": (5, 50, "CONTINUOUS"), "UT-SEWER": (3, 50, "CONTINUOUS"), "UT-STORM": (94, 50, "CONTINUOUS"),
    "UT-IRRIG": (6, 50, "CONTINUOUS"), "UT-OTHER": (7, 50, "CONTINUOUS"),
    "FEATURE": (7, 35, "CONTINUOUS"), "PROPERTY": (7, 50, "DASHED"),
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
    doc.styles.add("SV-STD", font="arial.ttf")
    doc.styles.add("SV-BOLD", font="arialbd.ttf")
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
    out = pathlib.Path(__file__).resolve().parents[1] / "src" / "dxf_template.json"
    out.write_text(json.dumps({"owner": owner, "seed": seed, "dxf": txt}))
    print(f"wrote {out} ({len(txt)} chars)")


if __name__ == "__main__":
    main()
