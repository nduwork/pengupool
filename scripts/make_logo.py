"""Draw the PenguPool logo: three penguins (a lead in front, two teammates behind).

    python3 scripts/make_logo.py

writes the one-colour glyph (currentColor; the Activity Bar icon and the site's small icons) to
extension/media/penguin.svg and docs/assets/penguin.svg, the full-colour tile to docs/assets/logo.svg,
renders the extension's marketplace icon extension/media/icon.png with rsvg-convert, and draws the
README banner docs/assets/pengupool.webp (rsvg-convert + ImageMagick)."""
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]

# one penguin in a 24x24 box (A's silhouette, rounder: egg body, soft flippers, two feet)
BODY = ('<path d="M12 2.6c3.5 0 5.6 3 5.6 7 0 1.1.1 2 .4 2.9 1.3 1.3 2.6 3.3 3 5 .2.8-.5 1.3-1.2.9'
        '-.7-.4-1.3-1-1.9-1.6-.3 2.2-1.8 3.8-3.9 4.4h-4c-2.1-.6-3.6-2.2-3.9-4.4-.6.6-1.2 1.2-1.9 1.6'
        '-.7.4-1.4-.1-1.2-.9.4-1.7 1.7-3.7 3-5 .3-.9.4-1.8.4-2.9 0-4 2.1-7 5.6-7Z"/>')
FEET = '<ellipse cx="9.6" cy="21.3" rx="2" ry=".95"/><ellipse cx="14.4" cy="21.3" rx="2" ry=".95"/>'
BELLY = '<path d="M12 10.4c-2.6 0-4 2.6-4 5.6 0 2.7 1.8 4.4 4 4.4s4-1.7 4-4.4c0-3-1.4-5.6-4-5.6Z"/>'
EYES = '<ellipse cx="9.9" cy="7.9" rx="1.15" ry="1.35"/><ellipse cx="14.1" cy="7.9" rx="1.15" ry="1.35"/>'
PUPILS = '<circle cx="10.15" cy="8.15" r=".6"/><circle cx="13.85" cy="8.15" r=".6"/>'
BEAK = '<path d="M10.7 10.2h2.6L12 11.9Z"/>'

# placement: (translate x, y, scale) in the 24 box; back pair first, lead last
SPOTS = [(-1.0, 1.2, .62), (9.9, 1.2, .62), (3.4, 4.6, .72)]


def T(x: float, y: float, s: float) -> str:
    return f'transform="translate({x} {y}) scale({s})"'


def glyph() -> str:
    parts = []
    for i, (x, y, s) in enumerate(SPOTS):
        if i == 2:  # a gap around the lead keeps every penguin's outline in one colour
            parts.append(f'<g {T(x, y, s)} fill="#000" stroke="#000" stroke-width="2.2" stroke-linejoin="round">{BODY}{FEET}</g>')
        parts.append(f'<g {T(x, y, s)}><g fill="#fff">{BODY}{FEET}</g><g fill="#000">{BELLY}{EYES}</g>'
                     f'<g fill="#fff">{PUPILS}{BEAK}</g></g>')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><mask id="m" maskUnits="userSpaceOnUse" '
            'x="0" y="0" width="24" height="24">' + "".join(parts) + '</mask>'
            '<rect width="24" height="24" fill="currentColor" mask="url(#m)"/></svg>\n')

def icon(tile: str = "#16324a") -> str:
    def peng(x: float, y: float, s: float, gap: bool) -> str:  # gap: a tile-coloured halo around the lead
        halo = f'<g {T(x, y, s)} fill="{tile}" stroke="{tile}" stroke-width="2.2" stroke-linejoin="round">{BODY}</g>'
        return ((halo if gap else '') + f'<g {T(x, y, s)}><g fill="#f3c880">{FEET}</g><g fill="#0b1320">{BODY}</g>'
                f'<g fill="#eef6f2">{BELLY}{EYES}</g><g fill="#0b1320">{PUPILS}</g><g fill="#f3c880">{BEAK}</g></g>')
    inner = "".join(peng(x, y, s, i == 2) for i, (x, y, s) in enumerate(SPOTS))
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">'
            f'<rect width="256" height="256" rx="56" fill="{tile}"/>'
            f'<g transform="translate(14 16) scale(9.5)">{inner}</g></svg>\n')



def coach_gear() -> str:
    """Cap, whistle on a lanyard and a clipboard, in the penguin's 24-unit box."""
    return ('<path d="M6.2 5.9C6.4 1.9 17.6 1.9 17.8 5.9Z" fill="#8ce5c5"/>'
            '<ellipse cx="16.2" cy="5.9" rx="4.2" ry=".85" fill="#5fcfae"/>'
            '<path d="M9.4 10.4Q12 14.6 14.6 10.4" fill="none" stroke="#f3c880" stroke-width=".45"/>'
            '<rect x="11.2" y="12.9" width="1.6" height="1.4" rx=".4" fill="#f3c880"/>'
            '<g transform="rotate(14 19.2 15.6)"><rect x="17.3" y="12.8" width="3.8" height="5" rx=".45" '
            'fill="#eef6f2" stroke="#0b1320" stroke-width=".35"/><rect x="18.4" y="12.4" width="1.6" height=".9" '
            'rx=".3" fill="#0b1320"/><path d="M18 14.6h2.4M18 15.7h2.4M18 16.8h1.6" stroke="#8b9aa3" stroke-width=".3"/></g>')


def penguin(x: float, y: float, s: float, extra: str = "") -> str:
    return (f'<g {T(x, y, s)}><g fill="#f3c880">{FEET}</g><g fill="#0b1320">{BODY}</g>'
            f'<g fill="#eef6f2">{BELLY}{EYES}</g><g fill="#0b1320">{PUPILS}</g><g fill="#f3c880">{BEAK}</g>{extra}</g>')


def banner() -> str:
    """The README banner, 2240x1120: PenguPool is the coach; the agents swim their own lanes."""
    agents = [(1060, "api"), (1460, "web"), (1860, "deploy")]
    msgs = "".join(f'<path d="M600 590C{(600 + x) / 2} 430 {x - 60} 520 {x} 650" fill="none" stroke="#0b1320" '
                   f'stroke-width="7" stroke-dasharray="4 18" stroke-linecap="round" opacity=".45"/>' for x, _ in agents)
    swimmers = "".join(penguin(x - 150, 610, 12.5) for x, _ in agents)
    lanes = "".join(f'<path d="M{x} 800V1120" stroke="#eef6f2" stroke-width="10" stroke-dasharray="26 22" opacity=".8"/>'
                    for x in (860, 1260, 1660, 2060))
    chips = "".join(f'<rect x="{x - 95}" y="930" width="190" height="64" rx="32" fill="#eef6f2"/>'
                    f'<text x="{x}" y="974" text-anchor="middle" font-size="38" font-weight="700" fill="#0b1320">{n}</text>'
                    for x, n in agents)
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2240 1120" font-family="Inter, Helvetica, Arial, sans-serif">'
            '<rect width="2240" height="1120" fill="#e6f7f0"/>'
            '<rect y="720" width="2240" height="70" fill="#cdeee2"/>'                      # pool deck
            f'{msgs}{penguin(170, 238, 22, coach_gear())}{swimmers}'
            '<path d="M0 800Q140 770 280 800T560 800T840 800T1120 800T1400 800T1680 800T1960 800T2240 800V1120H0Z" '
            'fill="#8ce5c5"/>'                                                              # the pool, over the swimmers
            f'{lanes}{chips}'
            '<text x="1060" y="250" font-size="150" font-weight="800" fill="#0b1320" letter-spacing="-4">PenguPool</text>'
            '<text x="1064" y="350" font-size="56" font-weight="600" fill="#2b4a5c">the coach for your agent harnesses</text>'
            '</svg>\n')


if __name__ == "__main__":
    for path in ("extension/media/penguin.svg", "docs/assets/penguin.svg"):
        (ROOT / path).write_text(glyph())
    (ROOT / "docs/assets/logo.svg").write_text(icon())
    subprocess.run(["rsvg-convert", "-w", "256", str(ROOT / "docs/assets/logo.svg"),
                    "-o", str(ROOT / "extension/media/icon.png")], check=True)
    png = ROOT / "docs/assets/pengupool.png"
    png.write_bytes(subprocess.run(["rsvg-convert", "-w", "2240"], input=banner().encode(), capture_output=True,
                                   check=True).stdout)
    subprocess.run(["magick", str(png), "-quality", "90", str(ROOT / "docs/assets/pengupool.webp")], check=True)
    png.unlink()
