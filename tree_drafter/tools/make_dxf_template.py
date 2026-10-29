"""Regenerate src/dxf_template.json (dev tool, needs ezdxf).

The template holds everything except the drawing entities: header, layers,
linetypes and text styles. The page splices its entities in at
%%ENTITIES%%, writes the next free handle at %%HANDSEED%%, and swaps the
style font files. Drawings are in inches at 1:1 with the page outline on
the non-plotting PAGE layer.

Layer names/colors/lineweights must match LAYERS in src/js/05-output.js.

    python tools/make_dxf_template.py      # then: python tools/build.py
"""
import io
import json
import pathlib

import ezdxf

LAYERS = {
    # name: (ACI color, lineweight 1/100 mm, linetype)
    "PAGE": (8, 13, "CONTINUOUS"), "TITLE": (7, 35, "CONTINUOUS"),
    "TEXT": (7, 25, "CONTINUOUS"), "TEXT-MINOR": (8, 18, "CONTINUOUS"), "LABEL": (7, 18, "CONTINUOUS"),
    "NODE": (7, 35, "CONTINUOUS"), "NODE-FILL": (7, 0, "CONTINUOUS"),
    "BRANCH": (7, 35, "CONTINUOUS"), "BRANCH-DASHED": (7, 35, "DASHED"),
    "LEADER": (8, 13, "DOT"), "SCALE": (7, 25, "CONTINUOUS"),
}


def main():
    doc = ezdxf.new("R2013", setup=False, units=ezdxf.units.IN)
    hdr = doc.header
    hdr["$MEASUREMENT"] = 0
    hdr["$LWDISPLAY"] = 1
    hdr["$LTSCALE"] = 0.1
    hdr["$PSLTSCALE"] = 0
    doc.linetypes.add("DASHED", pattern=[0.75, 0.5, -0.25], description="Dashed __ __ __ __")
    doc.linetypes.add("DOT", pattern=[0.25, 0.0, -0.25], description="Dot . . . . . . .")
    for name, (color, lw, lt) in LAYERS.items():
        layer = doc.layers.add(name, color=color, linetype=lt)
        layer.dxf.lineweight = lw
        if name == "PAGE":
            layer.dxf.plot = 0
    doc.styles.add("TD-STD", font="arial.ttf")
    doc.styles.add("TD-BOLD", font="arialbd.ttf")
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
