#!/usr/bin/env python3
"""Build docs/reflex-reason-tutorial.html from docs/src/*.txt.

Nothing in the text is typed twice. Numbers are {{...}} expressions that are
evaluated against bench/results/*.json, listings are cut from the real source
files, and section numbers, term links and quiz answers are generated. A
missing result, a listing line over 76 columns, an unknown term or a dangling
section reference stops the build, so the document cannot drift away from the
package without this script noticing.

    python3 docs/build_tutorial.py                  the standalone file
    python3 docs/build_tutorial.py --page out.html  also a page fragment

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

import html
import json
import pathlib
import re
import statistics
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "src"
RES = ROOT / "bench" / "results"
OUT = ROOT / "docs" / "reflex-reason-tutorial.html"
TITLE = "Reflex and Reason"
VERSION = "1.0"
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

INK2 = "#57514a"
SERIES = {0: "#2a78d6", 1: "#eb6834", 2: "#e6dfcf"}
chart_count = 0


def esc(text):
    return html.escape(str(text), quote=True)


def hbar(rows, unit, fmt="{:.1f}", legend=None, label_w=None, claim=""):
    """Horizontal bars with a label and a value on every bar.

    rows: (label, value, series). Series 0 is solid blue, 1 is hatched
    orange, 2 is a pale outlined bar, so the three stay apart on a
    greyscale screen and never depend on colour alone.
    """
    global chart_count
    chart_count += 1
    pid = f"hatch{chart_count}"
    width, pitch, bar_h = 680, 26, 14
    if label_w is None:
        label_w = min(330, max(len(r[0]) for r in rows) * 6.5 + 18)
    top = 30 if legend else 8
    height = top + len(rows) * pitch + 6
    span = width - label_w - 118
    peak = max(r[1] for r in rows) or 1
    out = [
        f'<svg viewBox="0 0 {width} {height}" role="img" '
        f'aria-label="{esc(claim)}" font-family="ui-sans-serif, '
        f'system-ui, Helvetica, Arial, sans-serif" font-size="12">',
        f'<defs><pattern id="{pid}" width="6" height="6" '
        f'patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
        f'<rect width="6" height="6" fill="{SERIES[1]}"/>'
        f'<line x1="0" y1="0" x2="0" y2="6" stroke="#7a2c08" '
        f'stroke-width="2"/></pattern></defs>',
    ]

    def paint(series):
        if series == 1:
            return f'fill="url(#{pid})"'
        if series == 2:
            return f'fill="{SERIES[2]}" stroke="{INK2}" stroke-width="1"'
        return f'fill="{SERIES[0]}"'

    if legend:
        x = label_w
        for series, name in legend:
            out.append(
                f'<rect x="{x}" y="6" width="12" height="12" '
                f"{paint(series)}/>"
            )
            out.append(
                f'<text x="{x + 17}" y="16" fill="currentColor">'
                f"{esc(name)}</text>"
            )
            x += 17 + len(name) * 6.4 + 22
    for i, (label, value, series) in enumerate(rows):
        y = top + i * pitch
        w = max(1.5, span * value / peak)
        shown = f"{fmt.format(value)} {unit}".strip()
        out.append(
            f'<text x="{label_w - 8}" y="{y + 11}" '
            f'text-anchor="end" fill="currentColor">{esc(label)}'
            f"</text>"
        )
        x1 = label_w + w
        if w >= 8:
            d = (
                f"M{label_w} {y}H{x1 - 4:.1f}Q{x1:.1f} {y} {x1:.1f} {y + 4}"
                f"V{y + bar_h - 4}Q{x1:.1f} {y + bar_h} {x1 - 4:.1f} "
                f"{y + bar_h}H{label_w}Z"
            )
            mark = f'<path d="{d}" {paint(series)}>'
        else:
            mark = (
                f'<rect x="{label_w}" y="{y}" width="{w:.1f}" '
                f'height="{bar_h}" {paint(series)}>'
            )
        out.append(
            f"{mark}<title>{esc(label)}: {esc(shown)}</title>"
            f'{"</path>" if w >= 8 else "</rect>"}'
        )
        out.append(
            f'<text x="{x1 + 6:.1f}" y="{y + 11}" '
            f'fill="currentColor">{esc(shown)}</text>'
        )
    out.append(
        f'<line x1="{label_w}" y1="{top - 3}" x2="{label_w}" '
        f'y2="{height - 4}" stroke="currentColor" '
        f'stroke-width="1"/></svg>'
    )
    return (
        f'<figure class="chart">{"".join(out)}'
        f"<figcaption>{claim}</figcaption></figure>"
    )


def pipeline(steps, claim, below=None):
    """A row of boxes joined by arrows: (title, [subtitle lines])."""
    global chart_count
    chart_count += 1
    mid = f"arrow{chart_count}"
    width, gap = 700, 22
    box_h = 36 + 12.5 * max(len(lines) for _, lines in steps)
    n = len(steps)
    box_w = (width - (n - 1) * gap) / n
    extra = 0 if not below else 16 + 13 * max(len(b) for b in below)
    height = box_h + 12 + extra
    out = [
        f'<svg viewBox="0 0 {width} {height}" role="img" '
        f'aria-label="{esc(claim)}" font-family="ui-sans-serif, '
        f'system-ui, Helvetica, Arial, sans-serif">',
        f'<defs><marker id="{mid}" viewBox="0 0 10 10" refX="9" refY="5" '
        f'markerWidth="7" markerHeight="7" orient="auto">'
        f'<path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>',
    ]
    for i, (title, lines) in enumerate(steps):
        x = i * (box_w + gap)
        cx = x + box_w / 2
        out.append(
            f'<rect x="{x + 0.6:.1f}" y="6" width="{box_w - 1.2:.1f}" '
            f'height="{box_h}" rx="6" fill="#efe9db" '
            f'stroke="currentColor" stroke-width="1.2"/>'
        )
        out.append(
            f'<text x="{cx:.1f}" y="25" text-anchor="middle" '
            f'font-size="12.5" font-weight="700" '
            f'fill="currentColor">{esc(title)}</text>'
        )
        for k, line in enumerate(lines):
            out.append(
                f'<text x="{cx:.1f}" y="{40 + k * 12.5}" '
                f'text-anchor="middle" font-size="10.5" '
                f'fill="currentColor">{esc(line)}</text>'
            )
        if i < n - 1:
            out.append(
                f'<line x1="{x + box_w + 2:.1f}" y1="{6 + box_h / 2:.1f}" '
                f'x2="{x + box_w + gap - 3:.1f}" y2="{6 + box_h / 2:.1f}" '
                f'stroke="currentColor" stroke-width="1.4" '
                f'marker-end="url(#{mid})"/>'
            )
        if below:
            for k, line in enumerate(below[i]):
                out.append(
                    f'<text x="{cx:.1f}" y="{box_h + 24 + k * 13}" '
                    f'text-anchor="middle" font-size="10.5" '
                    f'fill="currentColor">{esc(line)}</text>'
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
    body = "\n".join(
        f'<span class="c">{esc(l)}</span>' if mark.match(l) else esc(l)
        for l in cut
    )
    span = (
        f"line {first + 1}"
        if first == last
        else f"lines {first + 1} to {last + 1}"
    )
    return (
        f'<figure class="listing"><figcaption><code>{esc(path)}</code>, '
        f'{span}</figcaption><pre class="code"><code>{body}</code></pre>'
        f"</figure>"
    )


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
        out.append(f'<li id="q-{chapter}-{q}"><p>{question}</p><ul>')
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
                    word = "Appendix " if kind == "appendix" else ""
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
            elif line.strip() in ("@pre", "@py", "@quiz"):
                flush()
                kind = line.strip()
                j = i + 1
                while j < len(lines) and lines[j].strip() != "@end":
                    j += 1
                if j == len(lines):
                    fail(f"{name}:{i + 1}: {kind} without @end")
                body = lines[i + 1 : j]
                if kind == "@pre":
                    width_check(body, f"{name}:{i + 1} @pre")
                    out.append(
                        '<pre class="code plain"><code>'
                        + esc("\n".join(body))
                        + "</code></pre>"
                    )
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
                verdict = "Correct." if right else "Not this one."
                out.append(
                    f'<div class="ans" id="ans-{chapter}-{q}-'
                    f'{letter.lower()}"><p><b>Question {chapter}.{q}, '
                    f"option {letter}.</b> {text}</p><p><b>{verdict}</b> "
                    f'{why}</p><p class="back"><a href="#q-{chapter}-{q}">'
                    f"Back to question {chapter}.{q}</a></p></div>"
                )
    return "".join(out)


def toc():
    out = ['<nav id="toc"><h2>Contents</h2><ol>']
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

TOKENS = {
    "paper": "#f7f3ea",
    "ink": "#1f1c17",
    "ink2": INK2,
    "rule": "#d6cebd",
    "wash": "#efe9db",
    "link": "#1b4a86",
    "mark": "#fff3c4",
}
CSS = """
:root { color-scheme: light; TOKENS }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  font-size: 17px;
  line-height: 1.6;
}
.page {
  max-width: 700px;
  margin: 0 auto;
  padding-block: 28px 80px;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
}
h1 { font-size: 2.1em; line-height: 1.15; margin: 0.4em 0 0.2em; }
h2 { font-size: 1.5em; line-height: 1.25; margin: 0 0 0.6em; }
h3 { font-size: 1.15em; margin: 2em 0 0.5em; }
h4 { font-size: 1em; margin: 0 0 0.4em; }
.num { color: var(--ink2); font-weight: 400; margin-right: 0.3em; }
p { margin: 0 0 0.95em; }
a { color: var(--link); text-decoration: underline; }
a.term { text-decoration-style: dotted; }
.lede { font-size: 1.08em; color: var(--ink2); }
.chapter {
  border-top: 2px solid var(--ink);
  margin-top: 3.2em;
  padding-top: 1.1em;
  page-break-before: always;
}
code {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.86em;
}
pre.code {
  background: var(--wash);
  border: 1px solid var(--rule);
  border-radius: 4px;
  padding: 10px 12px;
  margin: 0 0 1em;
  overflow-x: auto;
  line-height: 1.42;
  font-size: 13px;
  white-space: pre;
}
pre.code code { font-size: inherit; }
pre.code .c { color: var(--ink2); }
figure { margin: 1.3em 0; }
figure.listing figcaption { margin: 0 0 4px; }
figcaption { font-size: 0.86em; color: var(--ink2); margin-top: 6px; }
svg { display: block; width: 100%; height: auto; color: var(--ink); }
.scroll { overflow-x: auto; margin: 0 0 1.1em; }
table { border-collapse: collapse; font-size: 0.88em; width: 100%; }
caption {
  text-align: left;
  font-size: 0.97em;
  color: var(--ink2);
  padding-bottom: 6px;
}
th, td {
  border-bottom: 1px solid var(--rule);
  padding: 5px 10px 5px 0;
  text-align: left;
  vertical-align: top;
}
th { border-bottom: 1.5px solid var(--ink); font-weight: 700; }
.n { text-align: right; font-variant-numeric: tabular-nums; }
#toc { margin: 2em 0; }
#toc h2 { font-size: 1.1em; margin-bottom: 0.4em; }
#toc ol { list-style: none; margin: 0; padding: 0; }
#toc ol > li { margin: 0 0 0.45em; }
#toc ul {
  list-style: none;
  margin: 0;
  padding: 0 0 0 1.4em;
  font-size: 0.86em;
  line-height: 1.45;
}
.nav { font-size: 0.9em; margin-top: 2.2em; }
dl.walk { margin: 0 0 1.1em; }
dl.walk dt { margin-top: 0.75em; }
dl.walk dt code {
  background: var(--wash);
  padding: 1px 5px;
  border-radius: 3px;
}
dl.walk dd { margin: 0.15em 0 0 0; }
ol.quiz > li { margin-bottom: 1.1em; }
ol.quiz ul { list-style: none; padding: 0; margin: 0; }
ol.quiz ul li { margin: 0.3em 0; }
.note {
  border-top: 1px solid var(--rule);
  padding: 0.9em 0 0.2em;
}
.note:target, .ans:target > p:first-child { background: var(--mark); }
.back { font-size: 0.9em; }
.ans {
  border-top: 1px solid var(--rule);
  padding-top: 1em;
  min-height: 100vh;
  page-break-before: always;
}
.meta { font-size: 0.9em; color: var(--ink2); }
blockquote {
  margin: 0 0 1em;
  padding: 0.2em 0 0.2em 1em;
  border-left: 3px solid var(--rule);
  font-size: 0.93em;
}
@media (hover: hover) and (pointer: fine) {
  .ans { display: none; min-height: 0; }
  .ans:target { display: block; }
}
"""


def css():
    """Each var() line is preceded by a literal copy for old readers."""
    tokens = " ".join(f"--{k}: {v};" for k, v in TOKENS.items())
    out = []
    for line in CSS.replace("TOKENS", tokens).split("\n"):
        if "var(--" in line:
            out.append(
                re.sub(
                    r"var\(--(\w+)\)", lambda m: TOKENS[m.group(1)], line
                )
            )
        out.append(line)
    return "\n".join(out)


def main():
    sources = read_sources()
    scan(sources)
    body = render(sources)
    back = notes()
    state.update(chapter=None, label="the opening", where="front")
    front = inline(FRONT)
    state.update(chapter=None, label="", where="answers")
    page = (
        f'<main class="page"><header><p class="meta">Tutorial {VERSION}'
        f"</p><h1>{TITLE}</h1>{front}</header>{toc()}{body}"
    )
    page = page.replace("<!--NOTES-->", back).replace(
        "<!--ANSWERS-->", answers()
    )
    page += "</main>"
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
    OUT.write_text(
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, '
        'initial-scale=1">\n'
        + head
        + "</head>\n<body>\n"
        + page
        + "\n</body>\n</html>\n"
    )
    if "--page" in sys.argv:
        target = pathlib.Path(sys.argv[sys.argv.index("--page") + 1])
        target.write_text(head + page + "\n")
    words = len(re.sub(r"<[^>]+>", " ", page).split())
    print(
        f"{OUT.relative_to(ROOT)}: {len(order)} chapters, "
        f"{len(uses)} notes, {sum(len(q) for _, q in quizzes)} quiz "
        f"questions, about {words} words, {OUT.stat().st_size} bytes"
    )


FRONT = ""
if (SRC / "front.html").exists():
    FRONT = (SRC / "front.html").read_text()

if __name__ == "__main__":
    main()
