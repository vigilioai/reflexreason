#!/usr/bin/env bash
# Invoke both intake functions in the Lambda emulator (needs Docker and the SAM
# CLI). Each invoke starts a fresh container, so every run is a cold start. The
# REPORT line is the emulator's own accounting; it runs on this machine, so the
# numbers compare the two functions with each other, not with AWS.
#   scripts/70-sam-local.sh [runs] > bench/results/sam-local.json
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNS="${1:-10}"
SAM="${SAM:-sam}"
EVENT="$(mktemp)"; trap 'rm -f "$EVENT"' EXIT
python3 "$ROOT/bench/gen-event.py" 4 > "$EVENT"
cd "$ROOT/deploy/sam"
"$SAM" validate --lint >&2
python3 - "$SAM" "$EVENT" "$RUNS" <<'PY'
import json, re, statistics, subprocess, sys, time
sam, event, runs = sys.argv[1], sys.argv[2], int(sys.argv[3])
out = {}
for fn in ["IntakeRust", "IntakeTs"]:
    subprocess.run([sam, "local", "invoke", fn, "-e", event], capture_output=True, text=True)   # pulls the image once
    rows = []
    for _ in range(runs):
        t0 = time.perf_counter()
        p = subprocess.run([sam, "local", "invoke", fn, "-e", event], capture_output=True, text=True)
        wall = (time.perf_counter() - t0) * 1000
        text = p.stdout + p.stderr
        num = lambda key: float(m.group(1)) if (m := re.search(key + r":\s*([\d.]+)", text)) else None
        rows.append({"wall_ms": round(wall), "init_ms": num("Init Duration"), "duration_ms": num(r"(?<!Init )(?<!Billed )Duration"),
                     "max_memory_mb": num("Max Memory Used"), "ok": '"fingerprint"' in text})
    med = lambda k: statistics.median([r[k] for r in rows if r[k] is not None]) if any(r[k] is not None for r in rows) else None
    out[fn] = {"runs": runs, "all_ok": all(r["ok"] for r in rows), "init_ms_p50": med("init_ms"), "duration_ms_p50": med("duration_ms"),
               "max_memory_mb_p50": med("max_memory_mb"), "container_wall_ms_p50": med("wall_ms"), "rows": rows}
    print(fn, {k: v for k, v in out[fn].items() if k != "rows"}, file=sys.stderr)
json.dump(out, sys.stdout, indent=1)
PY
