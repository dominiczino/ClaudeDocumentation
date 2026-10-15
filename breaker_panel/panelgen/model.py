"""Panel data model: parsing, validation and slot geometry.

A panel is a two-column arrangement of breaker *spaces* (stabs). Each space
is addressed by its printed number. Two numbering schemes are supported:

* ``odd_even``   - odd numbers down the left column, even down the right
                   (standard for US residential load centers).
* ``sequential`` - 1..N/2 down the left, N/2+1..N down the right.

Breaker kinds and the number of vertically consecutive spaces they occupy:

* ``single`` (1)  - one-pole, optional ``tie_below`` handle tie to the
                    single-pole breaker directly below it.
* ``double`` (2)  - two-pole, common trip.
* ``triple`` (3)  - three-pole, common trip.
* ``tandem`` (1)  - two half-size one-pole breakers in one space (A/B).
* ``quad``   (2)  - quadplex: outer 2-pole + inner 2-pole in two spaces.
* ``blank``  (1)  - empty space / filler plate (the default).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

KIND_SPAN = {"single": 1, "double": 2, "triple": 3, "tandem": 1, "quad": 2, "blank": 1}
FEATURES = ("", "GFCI", "AFCI", "DF", "SPD")
FEATURE_TEXT = {"GFCI": "GFCI", "AFCI": "AFCI", "DF": "AFCI/GFCI", "SPD": "SURGE"}


class PanelError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


@dataclass
class Pole:
    """One switchable circuit (a full breaker, or half of a tandem/quad)."""
    amps: int | None = None
    label: str = ""
    feature: str = ""

    @classmethod
    def parse(cls, d: dict | None) -> "Pole":
        d = d or {}
        amps = d.get("amps")
        amps = int(amps) if amps not in (None, "") else None
        feat = str(d.get("feature") or "").upper()
        return cls(amps=amps, label=str(d.get("label") or "").strip(),
                   feature=feat if feat in FEATURES else "")


@dataclass
class Breaker:
    space: int
    kind: str
    main: Pole = field(default_factory=Pole)      # single/double/triple
    a: Pole = field(default_factory=Pole)         # tandem top / quad outer
    b: Pole = field(default_factory=Pole)         # tandem bottom / quad inner
    tie_below: bool = False

    @property
    def span(self) -> int:
        return KIND_SPAN[self.kind]


@dataclass
class Slot:
    """Geometric position of a space."""
    space: int
    col: int  # 0 = left, 1 = right
    row: int  # 0 = top


@dataclass
class Panel:
    name: str = "PANEL"
    location: str = ""
    manufacturer: str = ""
    model: str = ""
    voltage: str = "120/240V 1Φ 3W"
    phases: int = 1
    main_kind: str = "breaker"  # breaker | lugs
    main_amps: int | None = 200
    bus_amps: int | None = 200
    fed_from: str = ""
    spaces: int = 40
    numbering: str = "odd_even"
    breakers: list[Breaker] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    titleblock: dict[str, str] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    # ---- geometry -------------------------------------------------------
    @property
    def rows(self) -> int:
        return self.spaces // 2

    def slot(self, space: int) -> Slot:
        if self.numbering == "sequential":
            n = self.rows
            return Slot(space, 0 if space <= n else 1, (space - 1) % n)
        return Slot(space, (space - 1) % 2, (space - 1) // 2)

    def space_at(self, col: int, row: int) -> int:
        if self.numbering == "sequential":
            return row + 1 + col * self.rows
        return row * 2 + 1 + col

    def spaces_of(self, br: Breaker) -> list[int]:
        s = self.slot(br.space)
        return [self.space_at(s.col, s.row + i) for i in range(br.span)]

    def phase_of_row(self, row: int) -> str:
        return "ABC"[row % 3] if self.phases == 3 else "AB"[row % 2]

    # ---- summary --------------------------------------------------------
    def stats(self) -> dict[str, int]:
        used = sum(b.span for b in self.breakers if b.kind != "blank")
        circuits = 0
        for b in self.breakers:
            circuits += {"single": 1, "double": 1, "triple": 1, "tandem": 2,
                         "quad": 2}.get(b.kind, 0)
        return {"spaces": self.spaces, "used": used, "free": self.spaces - used,
                "circuits": circuits}

    # ---- parsing --------------------------------------------------------
    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Panel":
        errors: list[str] = []
        main = d.get("main") or {}

        def _int(v, default=None):
            try:
                return int(v) if v not in (None, "") else default
            except (TypeError, ValueError):
                errors.append(f"Not a number: {v!r}")
                return default

        p = cls(
            name=str(d.get("name") or "PANEL").strip(),
            location=str(d.get("location") or "").strip(),
            manufacturer=str(d.get("manufacturer") or "").strip(),
            model=str(d.get("model") or "").strip(),
            voltage=str(d.get("voltage") or "").strip(),
            phases=3 if _int(d.get("phases"), 1) == 3 else 1,
            main_kind="lugs" if main.get("kind") == "lugs" else "breaker",
            main_amps=_int(main.get("amps")),
            bus_amps=_int(d.get("bus_amps")),
            fed_from=str(d.get("fed_from") or "").strip(),
            spaces=_int(d.get("spaces"), 40),
            numbering="sequential" if d.get("numbering") == "sequential" else "odd_even",
            notes=[str(n).strip() for n in (d.get("notes") or []) if str(n).strip()],
            titleblock={k: str(v) for k, v in (d.get("titleblock") or {}).items()},
        )
        if p.spaces < 2 or p.spaces > 84 or p.spaces % 2:
            errors.append("Number of spaces must be an even number between 2 and 84.")
            raise PanelError(errors)

        occupied: dict[int, int] = {}
        for raw in d.get("breakers") or []:
            kind = raw.get("kind", "single")
            if kind not in KIND_SPAN:
                errors.append(f"Unknown breaker kind {kind!r}.")
                continue
            if kind == "blank":
                continue
            space = _int(raw.get("space"))
            if space is None or not 1 <= space <= p.spaces:
                errors.append(f"Space {space} is outside 1..{p.spaces}.")
                continue
            br = Breaker(space=space, kind=kind, tie_below=bool(raw.get("tie_below")))
            if kind in ("single", "double", "triple"):
                br.main = Pole.parse(raw)
            else:
                br.a = Pole.parse(raw.get("a") or raw.get("outer"))
                br.b = Pole.parse(raw.get("b") or raw.get("inner"))
            s = p.slot(space)
            if s.row + br.span > p.rows:
                errors.append(f"{kind} breaker at space {space} runs past the bottom of the panel.")
                continue
            clash = [sp for sp in p.spaces_of(br) if sp in occupied]
            if clash:
                errors.append(f"Breaker at space {space} overlaps breaker at space {occupied[clash[0]]}.")
                continue
            for sp in p.spaces_of(br):
                occupied[sp] = space
            p.breakers.append(br)

        # Handle ties: only between vertically adjacent single-pole breakers.
        by_space = {b.space: b for b in p.breakers}
        for br in p.breakers:
            if br.tie_below:
                s = p.slot(br.space)
                below = by_space.get(p.space_at(s.col, s.row + 1)) if s.row + 1 < p.rows else None
                if br.kind != "single" or below is None or below.kind != "single":
                    p.warnings.append(f"Handle tie at space {br.space} ignored: needs a 1-pole breaker directly below.")
                    br.tie_below = False
        if p.phases == 1:
            for br in p.breakers:
                if br.kind == "triple":
                    p.warnings.append(f"3-pole breaker at space {br.space} in a single-phase panel.")
        if errors:
            raise PanelError(errors)
        p.breakers.sort(key=lambda b: b.space)
        return p

    def breaker_at(self) -> dict[int, Breaker]:
        """Map every occupied space -> breaker occupying it."""
        out: dict[int, Breaker] = {}
        for b in self.breakers:
            for sp in self.spaces_of(b):
                out[sp] = b
        return out
