"""Make the claude.ai artifact version of panel-drafter.html.

    python tools/build_hosted.py OUT.html

The host supplies the document skeleton, so ours is dropped (title first),
and APP_HOSTED switches the page to the host's file saving and account
storage (see the host services at the top of the page's script).
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def hosted(page):
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


def main():
    out = pathlib.Path(sys.argv[1]).resolve()
    out.write_text(hosted((ROOT / "panel-drafter.html").read_text()))
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
