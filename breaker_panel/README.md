# Panel Directory Drafter

A single HTML file for drawing household breaker panel directories on **ANSI B (11×17 in) portrait**
sheets. The drawing shows the breakers that are actually in the box (1-pole, 2-pole, 3-pole,
handle-tied, tandem, quadplex, open spaces / fillers, GFCI/AFCI/dual-function/surge), with a circuit
directory lined up next to each column. The output is a DXF made for plotting.

![example](examples/main_panel.png)

## Run

Open **`panel-drafter.html`** in a browser (Chrome, Edge, Firefox, Safari). That's all: no server, no
install, and no network access needed. You can copy the file anywhere, e.g. a USB stick or a shared
drive.

## Using it

* **Panel information**: name, location, service, main breaker or main lugs, bus rating, number of
  spaces, and numbering scheme (*odd left / even right*, or *down the left then down the right*).
* **Breakers**: the editor is laid out like the panel itself. Set each space's type, and a 2-pole,
  3-pole or quad takes the spaces below it. A **tie ↓** checkbox shows up on a 1-pole breaker when
  the breaker below it is also a 1-pole (e.g. a multi-wire branch circuit).
* **Notes / Title block**: notes print in the block left of the title block. The text shrinks to
  fit, and the block grows upward only if there are a lot of notes. The title block holds project,
  drawn by, date, dwg no., rev and sheet.
* **Download DXF** writes the CAD file. **Print / PDF** prints the sheet at full size on 11×17.
  To get a PDF, choose "Save as PDF" in the print dialog with paper size 11×17 / Tabloid and
  margins set to none.
* Panels are saved automatically in the browser (localStorage, per browser and per file location).
  Use **Save JSON / Import JSON** for real backups and for moving panels between machines.

## The DXF

* AutoCAD 2013 format, inches, drawn 1:1 in model space and sized to the 11×17 sheet. A paper-space
  layout named **"ANSI B"** has an 11×17 page setup and a 1:1 viewport, so plotting it gives
  full-scale output. From model space, plot "Extents" or "Window" at 1:1.
* Layers are split by function (`FRAME`, `TITLE`, `ENCLOSURE`, `BREAKER`, `HANDLE`, `TIE`,
  `TABLE`, `TABLE-GRID`, `HATCH`, `TEXT`, ...). Each layer sets its own lineweight. Turn on
  lineweight display and plot with `monochrome.ctb` for a black-and-white print.
* Text uses Arial (`arial.ttf` / `arialbd.ttf`). The page measures text with the browser's Arial
  (or Liberation Sans, which has the same metrics), so labels fit their cells in CAD too. Labels that
  are too long shrink, then wrap, then get truncated with "…".
* DWG isn't written directly; any CAD program can open the DXF and save it as DWG. The free
  [ODA File Converter](https://www.opendesign.com/guestfiles/oda_file_converter) also converts it.

## Config format

See `examples/main_panel.json` (import it with **Import JSON**). Each breaker is listed by the first
(top) space it occupies:

| kind     | spaces | fields                                                     |
|----------|--------|------------------------------------------------------------|
| `single` | 1      | `amps`, `label`, `feature`, `tie_below`                    |
| `double` | 2      | `amps`, `label`, `feature`                                 |
| `triple` | 3      | `amps`, `label`, `feature`                                 |
| `tandem` | 1      | `a` / `b`: `{amps, label, feature}`                        |
| `quad`   | 2      | `a` = outer 2-pole, `b` = inner 2-pole: `{amps, label}`    |

`feature` is one of `""`, `GFCI`, `AFCI`, `DF` (dual function), `SPD`. Any space not listed is drawn
as an open space / filler.

## Development

Everything lives in `panel-drafter.html`. The two scripts in `tools/` are only for maintenance and
need Python with `ezdxf` and `playwright`:

* `tools/make_dxf_template.py` regenerates the DXF template embedded in the page (header, layers,
  linetypes, text styles, ANSI B layout). Run it after changing layers or styles, then paste its
  output into `<script id="dxf-template">`. Layer colors and lineweights are also listed in
  `LAYERS` in the page script for the preview, so keep the two lists in sync.
* `tools/check_html.py` loads the page in headless Chromium, generates DXFs for a set of configs,
  and checks each one with ezdxf: it must read back, pass ezdxf's validation check, and stay inside
  the sheet frame. It also checks that bad configs are rejected.
  `--out DIR` also writes the example DXF and PDF.
