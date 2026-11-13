#!/usr/bin/env python3
"""Build docs/holsti-tutorial.html from docs/src/*.txt.

Nothing in the text is typed twice. Numbers are {{...}} expressions that are
evaluated against bench/results/*.json, listings are cut from the real source
files, and section numbers, term links and quiz answers are generated. A
missing result, a listing line over 76 columns, an unknown term or a dangling
section reference stops the build, so the document cannot drift away from the
package without this script noticing.

    python3 docs/build_tutorial.py                  the standalone file
    python3 docs/build_tutorial.py --page out.html  also a page fragment
    python3 docs/build_tutorial.py --release v1.0.1 the page of a release

The version is the project's own, read from ts/package.json and checked
against the Rust workspace. A plain build is labelled with that version
plus the first eight hex digits of a SHA-256 of the page itself, written as
SemVer build metadata (1.0.0+3f9a2c1d), so two different pages never carry
the same label and rebuilding unchanged sources gives a byte-identical file.
A --release build must name the tag that matches the version; it carries
the plain version and the date of the tag. The committed page is always a
plain build: .github/workflows/tutorial.yml rebuilds it on every push and
fails if it differs, and on a version tag builds the release page and
attaches it to the GitHub release.

Source syntax, one construct per line start:

    ## id | Title               chapter (add "| appendix" for A, B, C)
    ### id | Title              section
    @code path :: start :: end  listing from `start` (substring) to the first
                                later line matching `end` (regex); "$" = EOF
    @pre ... @end               literal block (commands, program output)
    @py ... @end                Python; emit(html) writes into the page
    @quiz ... @end              "? question", "+ right :: why", "- wrong :: why"
    @if expr ... @else ... @endif

Inline: {{expr|format}} for a number, [[term|text]] for a background note,
((id)) for a linked section number.
"""

import base64
import datetime
import hashlib
import html
import json
import pathlib
import re
import statistics
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "src"
RES = ROOT / "bench" / "results"
OUT = ROOT / "docs" / "holsti-tutorial.html"
FONTS = ROOT / "docs" / "fonts"
IMAGES = ROOT / "docs" / "images"
TITLE = "Holsti"
TAGLINE = "Reflex and reason for 24x7 operations"
MAXCOL = 76
errors = []


def fail(message):
    errors.append(message)


# ---------------------------------------------------------------- results


class Obj(dict):
    """A JSON object whose keys read as attributes."""

    def __getattr__(self, key):
        if key not in self:
            raise AttributeError(key)
        return wrap(self[key])


def wrap(value):
    if isinstance(value, dict):
        return Obj(value)
    if isinstance(value, list):
        return [wrap(v) for v in value]
    return value


def load(name, required=True):
    path = RES / name
    if not path.exists():
        if required:
            fail(f"missing result file bench/results/{name}")
        return None
    return wrap(json.loads(path.read_text()))


FILES = [
    ("cold", "coldstart.json", True),
    ("thr", "intake-throughput.json", True),
    ("chunk", "chunking.json", True),
    ("gate", "gate.json", True),
    ("gate0", "gate-before-nodelay.json", True),
    ("gaterss", "gate-rss.json", True),
    ("swarm", "swarm-mem.json", True),
    ("von", "von.json", True),
    ("vonw", "von-warm.json", True),
    ("dec", "decisions.json", True),
    ("scen", "scenarios.json", True),
    ("door", "door.json", True),
    ("sam", "sam-local.json", False),
    ("incluster", "incluster.json", False),
    ("build", "build.json", True),
    ("example", "systemone-example.json", True),
    ("cold0", "coldstart-python-harness.json", True),
    ("repro", "repro.json", True),
    ("imgbefore", "images-before-trim.json", True),
]
R = Obj({key: load(name, required) for key, name, required in FILES})


def pick(rows, what, **where):
    for row in rows:
        if all(row[k] == v for k, v in where.items()):
            return row
    raise KeyError(f"no {what} with {where}")


def cs(name):
    """Cold start row by its exact name."""
    return pick(R.cold.rows, "cold start row", name=name)


def cs0(name):
    """The same row in the first, superseded harness run."""
    return pick(R.cold0.rows, "old cold start row", name=name)


def thr(impl, size):
    """Throughput row for an implementation at the size nearest `size`."""
    rows = [r for r in R.thr if r.impl == impl]
    return min(rows, key=lambda r: abs(r.bytes - size))


def sc(name):
    return pick(R.scen.results, "scenario", scenario=name)


def rec(name, i=0):
    return sc(name).records[i]


def th(threshold):
    return pick(R.dec.thresholds, "threshold row", threshold=threshold)


def gd(threshold):
    return pick(R.dec.guardAt, "guard row", threshold=threshold)


def sw(agents):
    return pick(R.swarm.rows, "swarm row", agents=agents)


def chk(prefix):
    for row in R.chunk.rows:
        if row.variant.startswith(prefix):
            return row
    raise KeyError(f"no chunking variant starting with {prefix!r}")


def can(verb, resource, namespace="trading"):
    return pick(
        R.door.rbac,
        "rbac row",
        verb=verb,
        resource=resource,
        namespace=namespace,
    ).allowed


# ----------------------------------------------------------------- charts

INK = "#111318"
INK2 = "#4f5563"
NAVY = "#22305e"
PAPER = "#ffffff"
SANS = "Geist, ui-sans-serif, system-ui, Helvetica, Arial, sans-serif"
MONO = "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace"
chart_count = 0

# Advance widths of Geist 400 and 600 for ASCII 32 to 126, in thousandths of
# an em, read from docs/fonts with fontTools. Labels are sized with them, so
# no text in a chart is measured by guesswork or clipped.
GEIST = {
    400: [250, 217, 360, 478, 649, 770, 622, 188, 313, 313, 436, 570, 203,
          426, 203, 483, 672, 385, 619, 613, 636, 626, 624, 585, 604, 624,
          293, 293, 549, 660, 553, 567, 914, 672, 681, 702, 703, 604, 591,
          709, 704, 272, 598, 653, 581, 878, 739, 748, 651, 742, 673, 649,
          578, 690, 670, 912, 629, 631, 543, 337, 478, 337, 402, 564, 252,
          576, 599, 553, 599, 568, 399, 598, 582, 246, 261, 591, 284, 878,
          582, 580, 599, 599, 383, 531, 397, 576, 538, 820, 587, 538, 550,
          424, 264, 424, 538],
    600: [236, 243, 378, 552, 669, 817, 680, 195, 336, 336, 429, 559, 227,
          423, 227, 510, 689, 428, 642, 640, 665, 656, 648, 592, 646, 651,
          304, 304, 541, 636, 545, 586, 945, 719, 696, 720, 714, 616, 600,
          727, 713, 291, 617, 688, 586, 903, 745, 765, 665, 759, 689, 669,
          614, 699, 717, 965, 689, 674, 579, 368, 506, 368, 414, 565, 261,
          605, 624, 586, 624, 596, 432, 623, 601, 270, 308, 629, 313, 893,
          601, 608, 624, 624, 412, 562, 431, 597, 586, 840, 630, 571, 581,
          429, 285, 429, 527],
}


def text_w(text, size, weight=400):
    """Width in pixels of `text` set in Geist at `size`."""
    adv = GEIST[weight]
    return size * sum(
        adv[ord(c) - 32] if 32 <= ord(c) < 127 else 700 for c in text
    ) / 1000


def esc(text):
    return html.escape(str(text), quote=True)


def window(title, body, meta="", kind="", caption=""):
    """A window in the 1996 manner: a title bar, a body, a status line.

    The bar is plain text in the markup, so a reader without the style
    sheet still sees the title and its meta line above the body.
    """
    meta = f' <span class="wm">{meta}</span>' if meta else ""
    caption = f"<figcaption>{caption}</figcaption>" if caption else ""
    return (
        f'<figure class="win {kind}"><div class="bar"><span class="wt">'
        f"{title}</span>{meta}</div>{body}{caption}</figure>"
    )


def pre(text, title, meta="", kind="data"):
    """Program output or a record, in a window titled with its source."""
    body = f'<pre class="code plain"><code>{esc(text)}</code></pre>'
    return window(esc(title), body, esc(meta), kind)


def hbar(rows, unit, fmt="{:.1f}", legend=None, label_w=None, claim="",
         src=""):
    """Horizontal bars with a label and a value on every bar.

    rows: (label, value, series). Series 0 is solid navy, 1 is a one-bit
    checkerboard dither, 2 is an outlined white bar, so the three stay apart
    on a greyscale screen and never depend on colour alone. `src` names the
    result file in the window's title bar.
    """
    global chart_count
    chart_count += 1
    pid = f"dither{chart_count}"
    width, pitch, bar_h = 680, 26, 14
    if label_w is None:
        label_w = min(330, max(text_w(r[0], 12) for r in rows) + 18)
    top = 30 if legend else 8
    height = top + len(rows) * pitch + 6
    span = width - label_w - 118
    peak = max(r[1] for r in rows) or 1
    out = [
        f'<svg viewBox="0 0 {width} {height}" role="img" '
        f'aria-label="{esc(claim)}" font-family="{SANS}" font-size="12">',
        f'<defs><pattern id="{pid}" width="3" height="3" '
        f'patternUnits="userSpaceOnUse"><rect width="3" height="3" '
        f'fill="{PAPER}"/><rect width="1.5" height="1.5" fill="{NAVY}"/>'
        f'<rect x="1.5" y="1.5" width="1.5" height="1.5" fill="{NAVY}"/>'
        f"</pattern></defs>",
    ]

    def paint(series):
        if series == 1:
            return f'fill="url(#{pid})" stroke="{NAVY}" stroke-width="1"'
        if series == 2:
            return f'fill="{PAPER}" stroke="{NAVY}" stroke-width="1"'
        return f'fill="{NAVY}"'

    if legend:
        x = label_w
        for series, name in legend:
            out.append(
                f'<rect x="{x + 0.5}" y="6.5" width="11" height="11" '
                f"{paint(series)}/>"
            )
            out.append(
                f'<text x="{x + 17}" y="16" fill="currentColor">'
                f"{esc(name)}</text>"
            )
            x += 17 + text_w(name, 12) + 22
    for i, (label, value, series) in enumerate(rows):
        y = top + i * pitch
        w = max(1.5, span * value / peak)
        shown = f"{fmt.format(value)} {unit}".strip()
        out.append(
            f'<text x="{label_w - 10}" y="{y + 11}" '
            f'text-anchor="end" fill="currentColor">{esc(label)}'
            f"</text>"
        )
        x1 = label_w + w
        inset = 0.5 if series else 0
        out.append(
            f'<rect x="{label_w + inset}" y="{y + inset}" '
            f'width="{max(0.5, w - 2 * inset):.1f}" '
            f'height="{bar_h - 2 * inset}" {paint(series)}>'
            f"<title>{esc(label)}: {esc(shown)}</title></rect>"
        )
        out.append(
            f'<text x="{x1 + 7:.1f}" y="{y + 11}" font-family="{MONO}" '
            f'font-size="11.5" fill="currentColor">{esc(shown)}</text>'
        )
    out.append(
        f'<line x1="{label_w}" y1="{top - 3}" x2="{label_w}" '
        f'y2="{height - 4}" stroke="currentColor" '
        f'stroke-width="1.5"/></svg>'
    )
    return window(esc(src or "chart"), "".join(out), "", "chart", claim)


def pipeline(steps, claim, below=None):
    """A row of small windows joined by arrows: (title, [subtitle lines])."""
    global chart_count
    chart_count += 1
    mid = f"arrow{chart_count}"
    width, gap, bar, shadow = 700, 20, 20, 3
    n = len(steps)
    box_w = (width - (n - 1) * gap) / n - shadow
    widest = max(text_w(l, 1) for _, lines in steps for l in lines)
    size = min(10.5, round((box_w - 8) / widest, 2))
    box_h = bar + 12 + (size + 2) * max(len(lines) for _, lines in steps)
    extra = 0 if not below else 16 + 13 * max(len(b) for b in below)
    height = 6 + box_h + shadow + 6 + extra
    out = [
        f'<svg viewBox="0 0 {width} {height:.1f}" role="img" '
        f'aria-label="{esc(claim)}" font-family="{SANS}">',
        f'<defs><marker id="{mid}" viewBox="0 0 10 10" refX="9" refY="5" '
        f'markerWidth="7" markerHeight="7" orient="auto">'
        f'<path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>',
    ]
    for i, (title, lines) in enumerate(steps):
        x = i * (box_w + shadow + gap)
        cx = x + box_w / 2
        out.append(
            f'<rect x="{x + shadow:.1f}" y="{6 + shadow}" width="{box_w:.1f}" '
            f'height="{box_h:.1f}" fill="currentColor"/>'
            f'<rect x="{x + 0.75:.1f}" y="6.75" width="{box_w - 1.5:.1f}" '
            f'height="{box_h - 1.5:.1f}" fill="{PAPER}" stroke="currentColor" '
            f'stroke-width="1.5"/>'
            f'<rect x="{x + 0.75:.1f}" y="6.75" width="{box_w - 1.5:.1f}" '
            f'height="{bar}" fill="{NAVY}" stroke="currentColor" '
            f'stroke-width="1.5"/>'
        )
        out.append(
            f'<text x="{cx:.1f}" y="{6 + 14.5}" text-anchor="middle" '
            f'font-size="12" font-weight="600" fill="{PAPER}">'
            f"{esc(title)}</text>"
        )
        for k, line in enumerate(lines):
            out.append(
                f'<text x="{cx:.1f}" y="{6 + bar + 15 + k * (size + 2):.1f}" '
                f'text-anchor="middle" font-size="{size}" '
                f'fill="currentColor">{esc(line)}</text>'
            )
        if i < n - 1:
            y = 6 + bar + (box_h - bar) / 2
            out.append(
                f'<line x1="{x + box_w + shadow + 1:.1f}" y1="{y:.1f}" '
                f'x2="{x + box_w + shadow + gap - 2:.1f}" y2="{y:.1f}" '
                f'stroke="currentColor" stroke-width="1.5" '
                f'marker-end="url(#{mid})"/>'
            )
        if below:
            for k, line in enumerate(below[i]):
                out.append(
                    f'<text x="{cx:.1f}" '
                    f'y="{6 + box_h + shadow + 18 + k * 13:.1f}" '
                    f'text-anchor="middle" font-family="{MONO}" '
                    f'font-size="10" fill="currentColor">{esc(line)}</text>'
                )
    out.append("</svg>")
    return (
        f'<figure class="diagram">{"".join(out)}'
        f"<figcaption>{claim}</figcaption></figure>"
    )


def table(headers, rows, caption="", num=()):
    """An HTML table; column indexes in `num` are right-aligned."""

    def cell(tag, i, value):
        cls = ' class="n"' if i in num else ""
        return f"<{tag}{cls}>{value}</{tag}>"

    head = "".join(cell("th", i, h) for i, h in enumerate(headers))
    body = "".join(
        "<tr>"
        + "".join(cell("td", i, v) for i, v in enumerate(r))
        + "</tr>"
        for r in rows
    )
    cap = f"<caption>{caption}</caption>" if caption else ""
    return (
        f'<div class="scroll"><table>{cap}<thead><tr>{head}</tr>'
        f"</thead><tbody>{body}</tbody></table></div>"
    )


# ---------------------------------------------------------------- parsing

HEAD = re.compile(r"^(##|###) ([a-z0-9-]+) \| (.+?)(?: \| (appendix))?$")
EXPR = re.compile(r"\{\{(.+?)\}\}")
TERM = re.compile(r"\[\[([a-z0-9-]+)(?:\|(.+?))?\]\]")
REF = re.compile(r"\(\(([a-z0-9-]+)\)\)")
BLOCK = (
    "<p",
    "<ul",
    "<ol",
    "<table",
    "<figure",
    "<div",
    "<dl",
    "<svg",
    "<blockquote",
    "<h4",
    "<pre",
    "<hr",
    "</",
    "<!--",
)
HASH_COMMENT = (".sh", ".py", ".yaml", ".yml", ".toml", ".Dockerfile")

numbers = {}  # id -> (kind, number, title)
order = []  # ids of chapters in document order
terms = {}  # id -> (name, [source lines])
uses = {}  # term id -> [(anchor, label)]
quizzes = []  # (chapter number, [(question, [(right, text, why)])])
state = {"chapter": None, "label": "", "linked": set(), "where": ""}
NS = {
    "R": R,
    "cs": cs,
    "cs0": cs0,
    "thr": thr,
    "sc": sc,
    "rec": rec,
    "th": th,
    "gd": gd,
    "sw": sw,
    "chk": chk,
    "can": can,
    "hbar": hbar,
    "pipeline": pipeline,
    "pre": pre,
    "table": table,
    "esc": esc,
    "med": statistics.median,
    "RES": RES,
}


def read_sources():
    files = sorted(SRC.glob("*.txt"))
    if not files:
        fail(f"no sources in {SRC}")
    return [
        (f.name, conditionals(f.read_text().split("\n"), f.name))
        for f in files
    ]


def scan(sources):
    """First pass: number every chapter and section, collect the terms."""
    chapter = section = appendix = 0
    current = None
    for name, lines in sources:
        for line in lines:
            if line.startswith("@term "):
                tid, _, tname = line[6:].partition(" | ")
                current = terms.setdefault(
                    tid.strip(), (tname.strip(), [])
                )[1]
                continue
            m = HEAD.match(line)
            if not m:
                if current is not None:
                    current.append(line)
                continue
            current = None
            level, hid, title, kind = m.groups()
            if hid in numbers:
                fail(f"{name}: duplicate id {hid}")
            if level == "##":
                section = 0
                if kind:
                    appendix += 1
                    num = chr(64 + appendix)
                    numbers[hid] = ("appendix", num, title)
                else:
                    chapter += 1
                    num = str(chapter)
                    numbers[hid] = ("chapter", num, title)
                order.append(hid)
                last = num
            else:
                section += 1
                numbers[hid] = ("section", f"{last}.{section}", title)


def inline(text):
    def expr(m):
        body, fmt = m.group(1), None
        if "|" in body:
            body, fmt = body.rsplit("|", 1)
        try:
            value = eval(body, NS)
            if fmt:
                return esc(format(value, fmt.strip()))
            return esc(f"{value:g}" if isinstance(value, float) else value)
        except Exception as e:  # noqa: BLE001, every failure is reported
            fail(f"{state['where']}: {{{{{m.group(1)}}}}} -> {e!r}")
            return "?"

    def term(m):
        tid, shown = m.group(1), m.group(2)
        if tid not in terms:
            fail(f"{state['where']}: unknown term [[{tid}]]")
            return shown or tid
        shown = shown or terms[tid][0]
        key = (tid, state["chapter"])
        if state["chapter"] is not None and key in state["linked"]:
            return shown
        state["linked"].add(key)
        anchor = f"u-{tid}-{len(uses.setdefault(tid, [])) + 1}"
        uses[tid].append((anchor, state["label"]))
        return f'<a class="term" id="{anchor}" href="#t-{tid}">{shown}</a>'

    def ref(m):
        hid = m.group(1)
        if hid not in numbers:
            fail(f"{state['where']}: unknown section (({hid}))")
            return hid
        kind, num, _ = numbers[hid]
        return f'<a href="#{hid}">{kind} {num}</a>'

    return REF.sub(ref, TERM.sub(term, EXPR.sub(expr, text)))


def width_check(lines, what):
    for n, line in enumerate(lines, 1):
        if len(line) > MAXCOL:
            fail(f"{what}: line {n} is {len(line)} columns: {line[:60]}...")


def listing(spec):
    parts = [p.strip() for p in spec.split(" :: ")]
    if len(parts) != 3:
        fail(f"{state['where']}: @code needs path :: start :: end")
        return ""
    path, start, end = parts
    file = ROOT / path
    if not file.exists():
        fail(f"{state['where']}: no such file {path}")
        return ""
    lines = file.read_text().split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    first = next((i for i, l in enumerate(lines) if start in l), None)
    if first is None:
        fail(f"{state['where']}: {path}: start {start!r} not found")
        return ""
    extra = re.match(r"^(.*) \+(\d+)$", end)
    if extra:
        end = extra.group(1)
    if end == "$":
        last = len(lines) - 1
    elif end == "=":
        last = first
    else:
        last = next(
            (
                i
                for i in range(first + 1, len(lines))
                if re.search(end, lines[i])
            ),
            None,
        )
        if last is None:
            fail(f"{state['where']}: {path}: end {end!r} not found")
            return ""
    if extra:
        last = min(len(lines) - 1, last + int(extra.group(2)))
    cut = lines[first : last + 1]
    width_check(cut, f"{path} from line {first + 1}")
    hash_style = path.endswith(HASH_COMMENT) or "/" not in path
    mark = re.compile(r"^\s*#" if hash_style else r"^\s*(//|/\*|\*)")
    shown = [
        f'<span class="c">{esc(l)}</span>' if mark.match(l) else esc(l)
        for l in cut
    ]
    # One span per line, each ending in its own newline, so the numbers in
    # the gutter come from a CSS counter and are never copied with the code.
    body = "".join(
        f'<span class="l">{l}{"" if k == len(shown) - 1 else chr(10)}</span>'
        for k, l in enumerate(shown)
    )
    span = (
        f"line {first + 1}"
        if first == last
        else f"lines {first + 1} to {last + 1}"
    )
    wide = " g4" if last + 1 >= 1000 else ""
    code = (
        f'<pre class="code lined{wide}"><code style="counter-reset: ln '
        f'{first}">{body}</code></pre>'
    )
    return window(f"<code>{esc(path)}</code>", code, span, "listing")


def quiz(lines):
    chapter = numbers[state["chapter"]][1]
    questions = []
    for line in lines:
        line = line.strip()
        if line.startswith("? "):
            questions.append((inline(line[2:]), []))
        elif line[:2] in ("+ ", "- ") and questions:
            text, _, why = line[2:].partition(" :: ")
            if not why:
                fail(f"{state['where']}: quiz option without feedback")
            questions[-1][1].append(
                (line[0] == "+", inline(text), inline(why))
            )
        elif line:
            fail(f"{state['where']}: bad quiz line: {line[:50]}")
    out = ['<ol class="quiz">']
    for q, (question, options) in enumerate(questions, 1):
        if sum(1 for o in options if o[0]) != 1:
            fail(f"{state['where']}: question {q} needs exactly one answer")
        out.append(
            f'<li id="q-{chapter}-{q}"><p><span class="qn">{chapter}.{q}'
            f"</span> {question}</p><ul>"
        )
        for k, (_, text, _) in enumerate(options):
            letter = chr(65 + k)
            out.append(
                f'<li><a href="#ans-{chapter}-{q}-{letter.lower()}">'
                f"{letter}. {text}</a></li>"
            )
        out.append("</ul></li>")
    out.append("</ol>")
    quizzes.append((chapter, questions))
    return "".join(out)


def conditionals(lines, name):
    """Resolve @if / @else / @endif before anything else looks at a line."""
    out, keep, stack = [], True, []
    for line in lines:
        if line.startswith("@if "):
            stack.append(keep)
            try:
                keep = keep and bool(eval(line[4:], NS))
            except Exception as e:  # noqa: BLE001
                fail(f"{name}: @if {line[4:]} -> {e!r}")
                keep = False
        elif line.strip() == "@else" and stack:
            keep = stack[-1] and not keep
        elif line.strip() == "@endif" and stack:
            keep = stack.pop()
        elif keep:
            out.append(line)
    if stack:
        fail(f"{name}: @if without @endif")
    return out


def render(sources):
    out = []
    para = []
    open_chapter = [False]

    def flush():
        block = "\n".join(para).strip()
        para.clear()
        if not block:
            return
        text = inline(block)
        out.append(text if block.startswith(BLOCK) else f"<p>{text}</p>")

    def close_chapter():
        if open_chapter[0]:
            i = order.index(state["chapter"])
            nav = ['<p class="nav"><a href="#toc">Contents</a>']
            if i + 1 < len(order):
                kind, num, title = numbers[order[i + 1]]
                nav.append(
                    f' &middot; Next: <a href="#{order[i + 1]}">'
                    f"{kind.capitalize()} {num}, {title}</a>"
                )
            out.append("".join(nav) + "</p></section>")
            open_chapter[0] = False

    for name, lines in sources:
        i = 0
        while i < len(lines):
            line = lines[i]
            state["where"] = f"{name}:{i + 1}"
            m = HEAD.match(line)
            if line.startswith("@term "):
                break  # the notes file is rendered by notes()
            if m:
                flush()
                level, hid, title, _ = m.groups()
                kind, num, _ = numbers[hid]
                if level == "##":
                    close_chapter()
                    state.update(chapter=hid, label=f"{kind} {num}")
                    word = "Appendix " if kind == "appendix" else "Chapter "
                    out.append(
                        f'<section class="chapter"><h2 id="{hid}">'
                        f'<span class="num">{word}{num}</span> '
                        f"{title}</h2>"
                    )
                    open_chapter[0] = True
                else:
                    state["label"] = num
                    out.append(
                        f'<h3 id="{hid}"><span class="num">{num}'
                        f"</span> {title}</h3>"
                    )
            elif line.startswith("@code "):
                flush()
                out.append(listing(line[6:]))
            elif line.strip() in ("@py", "@quiz") or line.startswith("@pre"):
                flush()
                kind, _, title = line.strip().partition(" ")
                j = i + 1
                while j < len(lines) and lines[j].strip() != "@end":
                    j += 1
                if j == len(lines):
                    fail(f"{name}:{i + 1}: {kind} without @end")
                body = lines[i + 1 : j]
                if kind == "@pre":
                    width_check(body, f"{name}:{i + 1} @pre")
                    out.append(pre("\n".join(body), title or "shell",
                                   kind="shell"))
                elif kind == "@py":
                    local = dict(NS, emit=out.append, inline=inline)
                    try:
                        exec("\n".join(body), local)
                    except Exception as e:  # noqa: BLE001
                        fail(f"{name}:{i + 1}: @py -> {e!r}")
                else:
                    out.append(quiz(body))
                i = j
            elif line.strip() == "":
                flush()
            else:
                para.append(line)
            i += 1
        flush()
    close_chapter()
    return "".join(out)


def notes():
    """Background notes, each with links back to where it was cited."""
    state.update(chapter=None)
    bodies = {}
    for tid, (name, lines) in terms.items():
        state.update(label=f"the note on {name}", where=f"term {tid}")
        paras = [p.strip() for p in "\n".join(lines).split("\n\n")]
        bodies[tid] = "".join(f"<p>{inline(p)}</p>" for p in paras if p)
    out = []
    for tid, (name, _) in sorted(
        terms.items(), key=lambda t: t[1][0].lower()
    ):
        if tid not in uses:
            fail(f"term {tid} is defined but never cited")
            continue
        back = ", ".join(
            f'<a href="#{a}">{label}</a>' for a, label in uses[tid]
        )
        out.append(
            f'<div class="note" id="t-{tid}"><h4>{name}</h4>'
            f'{bodies[tid]}<p class="back">Return to the text: '
            f"{back}</p></div>"
        )
    return "".join(out)


def answers():
    out = []
    for chapter, questions in quizzes:
        for q, (_, options) in enumerate(questions, 1):
            for k, (right, text, why) in enumerate(options):
                letter = chr(65 + k)
                verdict = (
                    '<b class="ok">Correct.</b>'
                    if right
                    else '<b class="no">Not this one.</b>'
                )
                out.append(
                    f'<div class="ans" id="ans-{chapter}-{q}-'
                    f'{letter.lower()}"><div class="dlg"><p><b>Question '
                    f"{chapter}.{q}, option {letter}.</b> {text}</p><p>"
                    f'{verdict} {why}</p><p class="back"><a class="btn" '
                    f'href="#q-{chapter}-{q}">Back to question {chapter}.{q}'
                    f"</a></p></div></div>"
                )
    return "".join(out)


def toc():
    out = [
        '<nav id="toc" class="win"><h2 class="bar"><span class="wt">'
        'Contents</span></h2><ol>'
    ]
    for hid in order:
        kind, num, title = numbers[hid]
        subs = [
            (sid, n, t)
            for sid, (k, n, t) in numbers.items()
            if k == "section" and n.startswith(num + ".")
        ]
        inner = "".join(
            f'<li><a href="#{sid}">{n} {t}</a></li>' for sid, n, t in subs
        )
        inner = f"<ul>{inner}</ul>" if inner else ""
        out.append(
            f'<li><a href="#{hid}"><b>{num}</b> {title}</a>{inner}' f"</li>"
        )
    out.append("</ol></nav>")
    return "".join(out)


# -------------------------------------------------------------------- css

# Holsti's desktop: one yellow band with a dithered mountain ridge, a white
# document window on a dotted desktop, and navy-titled windows for code,
# data and charts. Geist is for reading, VT323 for window chrome, JetBrains
# Mono for data. The palette is the bird's: navy hood, yellow body.
TOKENS = {
    "desk": "#e9ebef",
    "dots": "#cfd3db",
    "paper": PAPER,
    "ink": INK,
    "ink2": INK2,
    "ink3": "#8b909b",
    "rule": "#d6d9e0",
    "wash": "#f0f1f4",
    "navy": NAVY,
    "yellow": "#f6d23c",
    "link": "#1d3ec7",
    "mark": "#fff0a6",
    "sans": SANS,
    "mono": MONO,
    "pixel": "VT323, " + MONO,
}
# (family, weight, file, copyright line): all four are under the SIL Open
# Font License 1.1, whose text is in docs/fonts/
FACES = [
    ("Geist", 400, "geist-sans-latin-400-normal.woff2",
     "Geist (C) 2023 Vercel, with basement.studio"),
    ("Geist", 600, "geist-sans-latin-600-normal.woff2",
     "Geist (C) 2023 Vercel, with basement.studio"),
    ("JetBrains Mono", 400, "jetbrains-mono-latin-400-normal.woff2",
     "JetBrains Mono (C) 2020 The JetBrains Mono Project Authors"),
    ("VT323", 400, "vt323-latin-400-normal.woff2",
     "VT323 (C) 2011 The VT323 Project Authors"),
]
CSS = """
:root { color-scheme: light; TOKENS }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background-color: var(--desk);
  background-image: radial-gradient(var(--dots) 0.9px, transparent 1.4px);
  background-size: 7px 7px;
  color: var(--ink);
  font-family: var(--sans);
  font-size: 17px;
  line-height: 1.62;
}
::selection { background: var(--yellow); color: var(--ink); }

.hero {
  position: relative;
  background-color: var(--yellow);
  background-image: url("RIDGE");
  background-repeat: repeat-x;
  background-position: center bottom;
  background-size: 1600px 192px;
  image-rendering: pixelated;
  border-bottom: 2px solid var(--ink);
}
.hero-in {
  max-width: 820px;
  margin: 0 auto;
  padding-block: 30px 150px;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 22px 32px;
}
.hero-text { min-width: 0; flex: 1 1 320px; }
.kicker { margin: 0 0 18px; }
.tag {
  display: inline-block;
  background: var(--ink);
  color: var(--paper);
  font: 400 19px/1 var(--pixel);
  letter-spacing: 0.03em;
  padding: 4px 8px 3px;
}
.hero h1 {
  font-size: clamp(52px, 15vw, 136px);
  font-weight: 600;
  line-height: 0.86;
  letter-spacing: -0.055em;
  margin: 0 0 16px -0.05em;
}
.tagline {
  font-size: clamp(19px, 2.7vw, 25px);
  line-height: 1.25;
  letter-spacing: -0.012em;
  max-width: 19em;
  margin: 0;
}
.win.bird { flex: none; width: 176px; margin: 4px 0 0; }
.bird-body { display: block; padding: 12px; background: var(--paper); }
.bird-body svg { display: block; width: 100%; height: auto; }

.page {
  position: relative;
  max-width: 780px;
  margin: -96px auto 56px;
  background: var(--paper);
  border: 1.5px solid var(--ink);
  box-shadow: 6px 6px 0 var(--ink);
}
.doc {
  padding-block: 28px 72px;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
}
@media (min-width: 640px) {
  .doc { padding-left: 40px; padding-right: 40px; }
}
@media (max-width: 812px) {
  .page { margin-left: 0; margin-right: 0; box-shadow: none; }
}
@media (max-width: 560px) {
  .page { border-left: 0; border-right: 0; margin-top: -72px; }
  .hero-in { flex-wrap: nowrap; gap: 14px; padding-block: 22px 124px; }
  .win.bird { width: 116px; }
  .bird-body { padding: 6px; }
  .win.bird .bar { font-size: 17px; padding-right: 6px; }
  .bar .opt { display: none; }
}

h1, h2, h3, h4 { font-weight: 600; text-wrap: balance; }
h2 { font-size: 30px; line-height: 1.1; letter-spacing: -0.03em; }
h3 {
  font-size: 22px;
  line-height: 1.25;
  letter-spacing: -0.015em;
  margin: 2.1em 0 0.6em;
}
h4 { font-size: 18px; letter-spacing: -0.01em; margin: 0 0 0.4em; }
h3 .num {
  font: 400 13px/1 var(--mono);
  letter-spacing: 0;
  border: 1.5px solid var(--ink);
  padding: 3px 5px 2px;
  margin-right: 10px;
  vertical-align: 3px;
}
p { margin: 0 0 1em; }
a {
  color: var(--link);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2.5px;
}
a.term { text-decoration-style: dotted; text-decoration-thickness: 1.5px; }
a:hover { background: var(--yellow); color: var(--ink); }
a:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
  background: var(--yellow);
  color: var(--ink);
}
.lede { font-size: 19px; line-height: 1.5; letter-spacing: -0.006em; }
.meta { font: 13px/1.65 var(--mono); color: var(--ink2); }

.chapter { margin-top: 76px; page-break-before: always; }
.chapter::before {
  content: "";
  display: block;
  height: 10px;
  margin-bottom: 30px;
  border-top: 3px solid var(--ink);
  background: conic-gradient(var(--ink) 25%, transparent 0 50%, var(--ink) 0 75%, transparent 0) 0 0 / 4px 4px;
}
.chapter h2 {
  font-size: clamp(32px, 5.6vw, 46px);
  line-height: 1.02;
  letter-spacing: -0.04em;
  margin: 0 0 24px;
}
.chapter h2 .num {
  display: table;
  font: 400 19px/1 var(--pixel);
  letter-spacing: 0.03em;
  text-transform: uppercase;
  background: var(--ink);
  color: var(--paper);
  padding: 4px 8px 3px;
  margin: 0 0 14px;
}

code {
  font-family: var(--mono);
  font-size: 0.84em;
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0, "calt" 0;
}
p code, li code, td code, dd code, dt code, caption code {
  background: var(--wash);
  padding: 1px 4px;
  overflow-wrap: anywhere;
}

.win {
  margin: 1.6em 0 1.9em;
  background: var(--paper);
  border: 1.5px solid var(--ink);
  box-shadow: 4px 4px 0 var(--ink);
}
.bar {
  position: relative;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 14px;
  margin: 0;
  padding: 1px 10px 0 30px;
  background: var(--navy);
  color: var(--paper);
  border-bottom: 1.5px solid var(--ink);
  font: 400 19px/24px var(--pixel);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
}
.bar::before {
  content: "";
  position: absolute;
  left: 9px;
  top: 7px;
  width: 8px;
  height: 8px;
  border: 1.5px solid var(--paper);
  background: var(--yellow);
}
.bar .wt { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.bar .wm { flex: none; opacity: 0.8; }
.bar code { font: inherit; background: none; padding: 0; }
.win.shell .bar { background: var(--ink); }
.win > figcaption {
  margin: 0;
  padding: 8px 12px 9px;
  border-top: 1.5px solid var(--ink);
  background: var(--wash);
  font-size: 14px;
  line-height: 1.45;
  color: var(--ink2);
}
.win.chart svg { padding: 14px 16px 8px; box-sizing: border-box; }

pre.code {
  margin: 0;
  padding: 12px 14px;
  overflow-x: auto;
  background-color: var(--paper);
  color: var(--ink);
  font: 13px/1.5 var(--mono);
  font-feature-settings: "liga" 0, "calt" 0;
  white-space: pre;
  tab-size: 4;
}
pre.code code { font: inherit; font-variant-ligatures: none; }
pre.code .c { color: var(--ink2); }
pre.lined {
  padding-left: 0;
  background-image: linear-gradient(90deg, var(--wash) 0 5.5ch, var(--rule) 5.5ch calc(5.5ch + 1px), transparent 0);
  background-attachment: local;
}
pre.lined.g4 {
  background-image: linear-gradient(90deg, var(--wash) 0 6.5ch, var(--rule) 6.5ch calc(6.5ch + 1px), transparent 0);
}
pre.lined .l::before {
  counter-increment: ln;
  content: counter(ln);
  display: inline-block;
  box-sizing: border-box;
  width: 5.5ch;
  padding-right: 1.2ch;
  margin-right: 1.4ch;
  text-align: right;
  color: var(--ink3);
}
pre.lined.g4 .l::before { width: 6.5ch; }
.win.data pre.code {
  background-image: radial-gradient(var(--rule) 1px, transparent 1.4px);
  background-size: 9px 9px;
  background-attachment: local;
}

figure { margin: 1.6em 0; }
figure.diagram {
  margin: 1.9em 0;
  padding: 20px 18px 14px;
  background:
    linear-gradient(var(--ink), var(--ink)) 0 0 / 14px 1.5px no-repeat,
    linear-gradient(var(--ink), var(--ink)) 0 0 / 1.5px 14px no-repeat,
    linear-gradient(var(--ink), var(--ink)) 100% 0 / 14px 1.5px no-repeat,
    linear-gradient(var(--ink), var(--ink)) 100% 0 / 1.5px 14px no-repeat,
    linear-gradient(var(--ink), var(--ink)) 0 100% / 14px 1.5px no-repeat,
    linear-gradient(var(--ink), var(--ink)) 0 100% / 1.5px 14px no-repeat,
    linear-gradient(var(--ink), var(--ink)) 100% 100% / 14px 1.5px no-repeat,
    linear-gradient(var(--ink), var(--ink)) 100% 100% / 1.5px 14px no-repeat;
}
figure.diagram figcaption {
  margin-top: 12px;
  font-size: 14px;
  line-height: 1.45;
  color: var(--ink2);
}
svg { display: block; width: 100%; height: auto; color: var(--ink); }

.scroll { overflow-x: auto; margin: 1.3em 0 1.7em; }
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 15px;
  line-height: 1.45;
}
caption {
  text-align: left;
  font-size: 14px;
  color: var(--ink2);
  padding-bottom: 8px;
}
th, td { text-align: left; vertical-align: top; padding: 8px 14px 8px 0; }
th {
  font: 400 11.5px/1.35 var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink2);
  vertical-align: bottom;
  padding-top: 0;
  border-bottom: 2px solid var(--ink);
}
td { border-bottom: 1px solid var(--rule); }
td:first-child { min-width: 7.5em; }
tbody tr:last-child td { border-bottom: 2px solid var(--ink); }
.n { text-align: right; font-variant-numeric: tabular-nums; }
td.n { font-family: var(--mono); font-size: 13.5px; }

#toc { margin: 30px 0 0; }
#toc ol { list-style: none; margin: 0; padding: 6px 16px 10px; }
#toc ol > li { padding: 9px 0 10px; border-bottom: 1px dotted var(--ink3); }
#toc ol > li:last-child { border-bottom: 0; }
#toc ol > li > a {
  display: flex;
  align-items: baseline;
  color: var(--ink);
  font-weight: 600;
  letter-spacing: -0.01em;
  text-decoration: none;
}
#toc b {
  flex: none;
  width: 2.4em;
  font: 400 14px/1 var(--mono);
  letter-spacing: 0;
  color: var(--ink2);
}
#toc ul {
  list-style: none;
  margin: 3px 0 0;
  padding: 0 0 0 2.4em;
  font-size: 15px;
  line-height: 1.5;
}
#toc ul li { margin: 2px 0; }

.status ul { list-style: none; margin: 0; padding: 10px 14px 12px; }
.status li { margin: 0; }
.status a {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  color: var(--ink);
  text-decoration: none;
  font: 14px/1.5 var(--mono);
}
.status .k { flex: 1; display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.status .k::after {
  content: "";
  flex: 1;
  min-width: 12px;
  border-bottom: 1.5px dotted var(--ink3);
}
.status .v { flex: none; padding: 0 4px; background: var(--wash); }
.status a:hover .v, .status a:focus-visible .v { background: var(--yellow); }

.nav {
  margin-top: 2.6em;
  padding-top: 12px;
  border-top: 1.5px dotted var(--ink);
  font: 14px/1.6 var(--mono);
}
dl.walk {
  margin: 0 0 1.6em;
  padding-left: 16px;
  border-left: 2px dotted var(--ink);
}
dl.walk dt { margin-top: 0.85em; }
dl.walk dt:first-child { margin-top: 0; }
dl.walk dt code { padding: 2px 6px; font-size: 13.5px; }
dl.walk dd { margin: 0.25em 0 0; }

ol.quiz { list-style: none; margin: 1em 0 0; padding: 0; }
ol.quiz > li {
  margin: 0 0 22px;
  padding: 16px 18px 16px;
  background: var(--paper);
  border: 1.5px solid var(--ink);
  box-shadow: 4px 4px 0 var(--ink);
}
ol.quiz > li > p { font-weight: 600; margin-bottom: 0.75em; }
.qn {
  font: 400 18px/1 var(--pixel);
  background: var(--ink);
  color: var(--paper);
  padding: 3px 7px 2px;
  margin-right: 6px;
  vertical-align: 2px;
}
ol.quiz ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
ol.quiz ul a {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 12px;
  border: 1.5px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  text-decoration: none;
}
ol.quiz ul a::before {
  content: "";
  flex: none;
  width: 11px;
  height: 11px;
  margin-top: 5px;
  border: 1.5px solid var(--ink);
  background: var(--paper);
}
ol.quiz ul a:hover, ol.quiz ul a:focus-visible { background: var(--yellow); }

.note { border-top: 1.5px solid var(--ink); padding: 16px 0 6px; }
.note:target { background: var(--mark); }
.back { font-size: 15px; }
.ans { padding-top: 1em; min-height: 100vh; page-break-before: always; }
.dlg {
  padding: 18px 20px 14px;
  background: var(--paper);
  border: 4px double var(--ink);
  box-shadow: 4px 4px 0 var(--ink);
}
.ans:target .dlg > p:first-child { background: var(--mark); }
b.ok, b.no { padding: 1px 6px; }
b.ok { background: var(--yellow); }
b.no { border: 1.5px solid var(--ink); }
a.btn {
  display: inline-block;
  margin: 8px 6px 4px;
  padding: 5px 18px;
  border: 2px solid var(--ink);
  border-radius: 10px;
  box-shadow: 0 0 0 2px var(--paper), 0 0 0 4.5px var(--ink);
  color: var(--ink);
  font-weight: 600;
  text-decoration: none;
}
blockquote {
  margin: 1.4em 0;
  padding: 14px 16px;
  border: 1.5px dashed var(--ink2);
  background: var(--wash);
  font: 13.5px/1.6 var(--mono);
}
@media (hover: hover) and (pointer: fine) {
  .ans { display: none; min-height: 0; }
  .ans:target { display: block; }
}
"""


def fonts():
    """The four faces as data URIs, so the page needs no font host."""
    out = []
    for family, weight, name, notice in FACES:
        data = base64.b64encode((FONTS / name).read_bytes()).decode()
        out.append(
            f"/* {notice}. SIL Open Font License 1.1. */\n"
            f'@font-face {{ font-family: "{family}"; font-style: normal; '
            f"font-weight: {weight}; font-display: swap; "
            f'src: url(data:font/woff2;base64,{data}) format("woff2"); }}'
        )
    return "\n".join(out)


def css():
    """Each one-line var() declaration is preceded by a literal copy for
    readers without custom properties; a declaration that spans lines is
    decoration and is left to readers that have them."""
    tokens = " ".join(f"--{k}: {v};" for k, v in TOKENS.items())
    ridge = base64.b64encode((IMAGES / "ridge.png").read_bytes()).decode()
    text = CSS.replace("TOKENS", tokens).replace(
        "RIDGE", f"data:image/png;base64,{ridge}"
    )
    out = []
    one_line = re.compile(r"^\s*([\w-]+\s*:.*;|[^{}]+\{[^{}]*\})\s*$")
    for line in text.split("\n"):
        if "var(--" in line and one_line.match(line):
            out.append(
                re.sub(
                    r"var\(--(\w+)\)", lambda m: TOKENS[m.group(1)], line
                )
            )
        out.append(line)
    return fonts() + "\n" + "\n".join(out)


def status():
    """The measured results in one window, each line linked to its section."""
    recs = [x for r in R.scen.results for x in r.records]
    decide = statistics.median([r.records[0].ms.decide for r in R.scen.results
                  if r.agents == 1]) / 1000
    rust = cs("intake: Rust binary, static musl (the Lambda artefact)")
    node = cs("intake: Node, esbuild bundle")
    rows = [
        ("fault scenarios passed", f"{R.scen.passed} of {R.scen.total}",
         "s-results"),
        ("incidents fixed and verified",
         f"{sum(1 for x in recs if x.executed and x.recovered)} of "
         f"{len(recs)}", "s-results"),
        ("handed to the language model",
         f"{sum(1 for x in recs if x.escalatedTo == 'reason')} of "
         f"{len(recs)}", "s-reason-run"),
        ("handed to a person",
         f"{sum(1 for x in recs if x.escalatedTo == 'human')} of "
         f"{len(recs)}", "s-results"),
        ("decide step, median", f"{decide:.1f} s", "s-latency"),
        ("cold start, static Rust", f"{rust.p50_ms} ms", "s-intake-cold"),
        ("cold start, Node bundle", f"{node.p50_ms} ms", "s-intake-cold"),
        ("1,000 agents, peak memory", f"{sw(1000).rss_peak_mb:,.0f} MB",
         "s-swarm-memory"),
    ]
    items = "".join(
        f'<li><a href="#{a}"><span class="k">{k}</span> '
        f'<span class="v">{v}</span></a></li>'
        for k, v, a in rows
    )
    return window("results", f"<ul>{items}</ul>", "bench/results", "status")


def project_version():
    """The one version of the project. ts/package.json and the Rust
    workspace both state it, and a release with two versions is an error."""
    ts = json.loads((ROOT / "ts" / "package.json").read_text())["version"]
    cargo = (ROOT / "rust" / "Cargo.toml").read_text()
    table = re.search(r"^\[workspace\.package\]$(.*?)(?=^\[|\Z)", cargo,
                      re.M | re.S)
    found = table and re.search(r'^version\s*=\s*"([^"]+)"', table.group(1),
                                re.M)
    rust = found.group(1) if found else None
    if rust != ts:
        fail(f"ts/package.json says version {ts} but rust/Cargo.toml says "
             f"{rust}; scripts/80-release.sh sets both")
    return ts


def git(*args):
    """Output of a git command in the project, or "" outside a checkout."""
    try:
        run = subprocess.run(["git", "-C", str(ROOT), *args],
                             capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return run.stdout.strip() if run.returncode == 0 else ""


def release_date(tag):
    """The date the tag was made, else its commit's, else today (UTC)."""
    day = git("for-each-ref", "--format=%(creatordate:short)",
              f"refs/tags/{tag}")
    if not day:
        day = git("log", "-1", "--format=%cs", tag)
    if not day:
        day = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        print(f"note: no tag {tag} in this checkout, dated {day}")
    return day


def main():
    version = project_version()
    release = None
    if "--release" in sys.argv:
        release = sys.argv[sys.argv.index("--release") + 1]
        if release != f"v{version}":
            fail(f"tag {release} does not match the project version "
                 f"{version}; the tag for this version is v{version}")
    sources = read_sources()
    scan(sources)
    body = render(sources)
    back = notes()
    state.update(chapter=None, label="the opening", where="front")
    front = inline(FRONT)
    state.update(chapter=None, label="", where="answers")
    page = (
        f'<header class="hero"><div class="hero-in"><div class="hero-text">'
        f'<p class="kicker"><span class="tag">{TITLE} @@LABEL@@</span></p>'
        f'<h1>{TITLE}</h1><p class="tagline">{TAGLINE}</p></div>'
        f'<div class="win bird"><div class="bar"><span class="wt">'
        f'<span class="opt">Taiwan </span>yellow tit</span></div>'
        f'<div class="bird-body">{mark()}'
        f"</div></div></div></header>"
        f'<main class="page"><div class="bar"><span class="wt">'
        f'holsti-tutorial.html</span> <span class="wm">@@STAMP@@</span>'
        f'</div><div class="doc">{front}{status()}{toc()}{body}'
    )
    page = page.replace("<!--NOTES-->", back).replace(
        "<!--ANSWERS-->", answers()
    )
    page += "</div></main>"
    prose = re.sub(r"<pre.*?</pre>", "", page, flags=re.S)
    for pattern in (
        r"<!--NOTES-->",
        r"<!--ANSWERS-->",
        r"\{\{",
        r"\[\[[a-z0-9-]+",
        r"\(\([a-z0-9-]+\)\)",
    ):
        left = re.search(pattern, prose)
        if left:
            fail(f"unresolved {left.group(0)} in the output")
    for target in set(re.findall(r'href="#([^"]+)"', page)):
        if f'id="{target}"' not in page:
            fail(f"link to #{target} has no target")
    if errors:
        print("\n".join(f"error: {e}" for e in errors), file=sys.stderr)
        sys.exit(1)
    head = (
        f"<title>{TITLE} Tutorial</title>\n"
        f'<meta name="claude:viewport-fit-sides" content="cover">\n'
        f"<style>{css()}</style>\n"
    )
    document = (
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, '
        'initial-scale=1">\n'
        + head
        + "</head>\n<body>\n"
        + page
        + "\n</body>\n</html>\n"
    )
    # The label names the content: the hash is taken over the whole file
    # with the label still a placeholder, so it changes with any change to
    # text, listings, numbers or style, and with nothing else.
    digest = hashlib.sha256(document.encode()).hexdigest()[:8]
    if release:
        label, stamp = version, f"released {release_date(release)}"
    else:
        label, stamp = f"{version}+{digest}", "development build"

    def stamped(text):
        return text.replace("@@LABEL@@", label).replace("@@STAMP@@", stamp)

    OUT.write_text(stamped(document))
    if "--page" in sys.argv:
        target = pathlib.Path(sys.argv[sys.argv.index("--page") + 1])
        target.write_text(stamped(head + page + "\n"))
    words = len(re.sub(r"<[^>]+>", " ", page).split())
    print(
        f"{OUT.relative_to(ROOT)}: {TITLE} {label}, {len(order)} chapters, "
        f"{len(uses)} notes, {sum(len(q) for _, q in quizzes)} quiz "
        f"questions, about {words} words, {OUT.stat().st_size} bytes"
    )


def mark():
    """The logo's bird, inline, so the page needs no image files."""
    svg = (ROOT / "docs" / "images" / "holsti-mark.svg").read_text()
    svg = re.sub(r"\s*<title>.*?</title>", "", svg)
    # the drawing has room around the bird for the logo; the header crops it
    svg = svg.replace('viewBox="0 0 512 512"', 'viewBox="56 82 400 400"', 1)
    return svg.replace("<svg ", '<svg width="150" height="150" ', 1).strip()


FRONT = ""
if (SRC / "front.html").exists():
    FRONT = (SRC / "front.html").read_text()

if __name__ == "__main__":
    main()
