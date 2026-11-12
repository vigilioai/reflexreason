#!/usr/bin/env python3
"""Cold-start benchmark. Each target is a fresh process that reads one
event on stdin and must print the same result.

Every process is started by rust/crates/rusage, not by this script. A child
inherits the peak memory of whatever forked it, so a child of Python can
never report less than Python's own footprint; the helper is a small static
binary, and it also takes the wall time itself, so neither number contains
any Python.

   bench/coldstart.py --runs 40 --event /tmp/event-4k.json \
       > bench/results/coldstart.json
"""

import argparse, json, os, statistics, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B = os.path.join(ROOT, "ts", "dist", "bundle")
MUSL = os.path.join(ROOT, "rust", "target", "x86_64-unknown-linux-musl")
RUSAGE = os.path.join(MUSL, "release", "rusage")


def run_once(cmd, stdin_bytes, env, cwd):
    stdin_r, stdin_w = os.pipe()
    report_r, report_w = os.pipe()
    p = subprocess.Popen(
        [RUSAGE, "--fd", str(report_w)] + cmd,
        stdin=stdin_r,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
        cwd=cwd,
        pass_fds=[report_w],
    )
    os.close(stdin_r)
    os.close(report_w)
    if stdin_bytes:
        os.write(stdin_w, stdin_bytes)
    os.close(stdin_w)
    out = p.stdout.read()
    p.wait()
    with os.fdopen(report_r) as f:
        ru = json.loads(f.read())
    return (
        ru["wall_us"] / 1000,
        ru["maxrss_kb"] / 1024,
        ru["cpu_us"] / 1000,
        ru["code"],
        out,
    )


def bench(
    name,
    cmd,
    runs,
    stdin_bytes=b"",
    env=None,
    cwd=ROOT,
    size_of=None,
    warmups=3,
):
    env = {**os.environ, **(env or {})}
    # Fill the page cache first: the first exec of a file is a disk read,
    # which is a property of the disk and not of the program.
    for _ in range(warmups):
        run_once(cmd, stdin_bytes, env, cwd)
    walls, rss, cpu, out, code = [], [], [], b"", 0
    for _ in range(runs):
        w, r, c, code, out = run_once(cmd, stdin_bytes, env, cwd)
        walls.append(w)
        rss.append(r)
        cpu.append(c)
    walls.sort()
    q = lambda p: walls[min(len(walls) - 1, int(len(walls) * p))]
    size = sum(
        os.path.getsize(f) for f in (size_of or []) if os.path.exists(f)
    )
    return {
        "name": name,
        "runs": runs,
        "ok": code == 0,
        "min_ms": round(walls[0], 2),
        "p50_ms": round(q(0.5), 2),
        "p90_ms": round(q(0.9), 2),
        "max_ms": round(walls[-1], 2),
        "mean_ms": round(statistics.mean(walls), 2),
        "stdev_ms": round(statistics.pstdev(walls), 2),
        "peak_rss_mb": round(statistics.median(rss), 2),
        "cpu_ms": round(statistics.median(cpu), 2),
        "artifact_bytes": size,
        "output_sha": __import__("hashlib").sha1(out).hexdigest()[:12],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=40)
    ap.add_argument("--event", default="/tmp/event-4k.json")
    a = ap.parse_args()
    ev = open(a.event, "rb").read()
    node = ["node"]
    cache = "/tmp/rr-compile-cache"
    rows = []
    add = lambda *x, **k: (
        rows.append(bench(*x, **k)),
        print(rows[-1]["name"], rows[-1]["p50_ms"], "ms", file=sys.stderr),
    )

    # 1. The same function in two languages: the intake front door.
    rust = os.path.join(ROOT, "rust", "target", "release", "intake")
    add("intake: Rust binary", [rust], a.runs, ev, size_of=[rust])
    static = os.path.join(MUSL, "release", "intake")
    add(
        "intake: Rust binary, static musl (the Lambda artefact)",
        [static],
        a.runs,
        ev,
        size_of=[static],
    )
    add(
        "intake: Node, esbuild bundle",
        node + [f"{B}/intake-cli.mjs"],
        a.runs,
        ev,
        size_of=[f"{B}/intake-cli.mjs"],
    )
    add(
        "intake: Node, bundle + compile cache",
        node + [f"{B}/intake-cli.mjs"],
        a.runs,
        ev,
        env={"NODE_COMPILE_CACHE": cache},
        size_of=[f"{B}/intake-cli.mjs"],
    )
    tsc = os.path.join(ROOT, "ts", "dist", "src", "intake")
    add(
        "intake: Node, tsc output (2 files)",
        node + [f"{tsc}/cli.js"],
        a.runs,
        ev,
        size_of=[f"{tsc}/cli.js", f"{tsc}/sift.js"],
    )
    add("floor: node -e '' (runtime only)", node + ["-e", ""], a.runs)
    add("floor: /bin/true (process only)", ["/bin/true"], a.runs)

    # 2. Long-running services: time from exec until every module is loaded.
    gate = os.path.join(ROOT, "rust", "target", "release", "vllm-gate")
    add(
        "service: vllm-gate (Rust), bind and exit",
        [gate],
        a.runs,
        env={"GATE_EXIT_AFTER_BIND": "1", "GATE_LISTEN": "127.0.0.1:0"},
        size_of=[gate],
    )
    for label, f in [
        ("swarm dispatcher", "swarm"),
        ("MCP server", "mcp-server"),
        ("retrieval agent (LangGraph + A2A)", "rag-server"),
        ("reason agent (ADK + MCP + A2A)", "reason-server"),
    ]:
        add(
            f"service: {label}, load only",
            node + [f"{B}/{f}.mjs", "--load-only"],
            max(10, a.runs // 2),
            size_of=[f"{B}/{f}.mjs"],
        )
        add(
            f"service: {label}, load only + compile cache",
            node + [f"{B}/{f}.mjs", "--load-only"],
            max(10, a.runs // 2),
            env={"NODE_COMPILE_CACHE": cache},
            size_of=[f"{B}/{f}.mjs"],
        )

    # 3. What each SDK costs to import, unbundled, from node_modules.
    for pkg in [
        "zod",
        "express",
        "@modelcontextprotocol/sdk/client/index.js",
        "@a2a-js/sdk/client",
        "@langchain/langgraph",
        "@google/adk",
        "@huggingface/transformers",
    ]:
        add(
            f"import: {pkg}",
            node + ["--input-type=module", "-e", f"await import('{pkg}')"],
            max(8, a.runs // 4),
            cwd=os.path.join(ROOT, "ts"),
        )

    json.dump(
        {"machine": machine(), "event_bytes": len(ev), "rows": rows},
        sys.stdout,
        indent=1,
    )


def machine():
    cpu = next(
        (
            l.split(":")[1].strip()
            for l in open("/proc/cpuinfo")
            if l.startswith("model name")
        ),
        "?",
    )
    mem = (
        int(
            next(
                l.split()[1]
                for l in open("/proc/meminfo")
                if l.startswith("MemTotal")
            )
        )
        // 1024
    )
    node = subprocess.run(
        ["node", "-v"], capture_output=True, text=True
    ).stdout.strip()
    rustc = subprocess.run(
        ["rustc", "--version"], capture_output=True, text=True
    ).stdout.strip()
    return {
        "cpu": cpu,
        "vcpus": os.cpu_count(),
        "mem_mb": mem,
        "kernel": os.uname().release,
        "node": node,
        "rustc": rustc,
    }


if __name__ == "__main__":
    main()
