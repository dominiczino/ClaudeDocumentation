"""Build diagram-drafter.html: one self-contained file from src/.

    python tools/build.py                    # diagram-drafter.html
    python tools/build.py --hosted OUT.html  # variant for a claude.ai artifact

Inlines src/style.css, src/js/*.js (in name order), the embedded fonts,
the DXF template (src/dxf_template.json) and the example drawings.
No dependencies beyond the Python standard library.
"""
import base64
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
FONTS = ["B612-Regular.ttf", "B612-Bold.ttf", "Jost-Regular.ttf", "Jost-Bold.ttf"]


def main():
    page = (SRC / "page.html").read_text()
    css = (SRC / "style.css").read_text()
    js = "\n".join(p.read_text() for p in sorted((SRC / "js").glob("*.js")))
    fonts = {f: base64.b64encode((ROOT / "fonts" / f).read_bytes()).decode() for f in FONTS}
    template = (SRC / "dxf_template.json").read_text().strip()
    examples = {p.stem: json.loads(p.read_text()) for p in sorted((ROOT / "examples").glob("*.json"))}

    blobs = {"@@FONTS@@": json.dumps(fonts), "@@TEMPLATE@@": template,
             "@@EXAMPLES@@": json.dumps(examples, ensure_ascii=False)}
    for marker, text in blobs.items():
        assert "</script" not in text.lower(), marker
    for marker, text in {"/*@@CSS@@*/": css, "//@@JS@@": js, **blobs}.items():
        assert page.count(marker) == 1, marker
        page = page.replace(marker, text)
    out = ROOT / "diagram-drafter.html"
    if "--hosted" in sys.argv:
        out = pathlib.Path(sys.argv[sys.argv.index("--hosted") + 1]).resolve()
        page = hosted(page)
    out.write_text(page)
    print(f"wrote {out} ({len(page) // 1024} KB)")


def hosted(page):
    """The page as content for a claude.ai artifact: the host supplies the
    document skeleton, so drop ours (title first), and set APP_HOSTED."""
    title = re.search(r"<title>.*?</title>", page).group(0)
    page = re.sub(r"<!doctype html>\s*<!--.*?-->\s*<html[^>]*>\s*<head>\s*<meta charset=\"utf-8\">\s*"
                  r"<meta name=\"viewport\"[^>]*>\s*<title>.*?</title>\s*", "", page, count=1, flags=re.S)
    assert page.lstrip().startswith("<style>"), page[:80]
    page = page.replace("</head>", "", 1).replace("<body>", "", 1)    # the first: structure, before any script
    i = page.rindex("</body>")
    assert page[i:].split() == ["</body>", "</html>"], page[i:]
    page = page[:i]
    i = page.rindex("<script>\n")
    page = page[:i] + "<script>var APP_HOSTED = true;</script>\n" + page[i:]
    return title + "\n" + page


if __name__ == "__main__":
    main()
