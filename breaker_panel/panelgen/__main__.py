"""CLI: python -m panelgen panel.json [-o out.dxf|.pdf|.svg|.dwg]"""
import argparse
import json
import pathlib

from .render import export


def main():
    ap = argparse.ArgumentParser(description="Generate an ANSI B breaker panel directory drawing.")
    ap.add_argument("config", type=pathlib.Path)
    ap.add_argument("-o", "--output", type=pathlib.Path)
    a = ap.parse_args()
    out = a.output or a.config.with_suffix(".dxf")
    data, _ = export(json.loads(a.config.read_text()), out.suffix.lstrip(".").lower())
    out.write_bytes(data)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
