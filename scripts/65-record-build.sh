#!/usr/bin/env bash
# Run the full build with images and record what it printed. The tutorial's
# section on a clean build is generated from the file this writes.
#   scripts/65-record-build.sh      writes bench/results/build.json
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$(mktemp)"; trap 'rm -f "$LOG"' EXIT
IMAGES=1 "$ROOT/build.sh" 2>&1 | tee "$LOG"
python3 - "$LOG" "$ROOT/bench/results/build.json" <<'PY'
import json
import re
import sys

text = open(sys.argv[1]).read()
lines = [line.rstrip() for line in text.split("\n") if line.strip()]


def number(pattern):
    found = re.search(pattern, text)
    return float(found.group(1)) if found else None


json.dump(
    {
        "log": lines,
        "npm_packages": int(number(r"added (\d+) packages")),
        "ts_tests": int(number(r"# tests (\d+)")),
        "agents_image_mb": number(r"rr-agents:1\.0\s+([\d.]+) MB"),
        "rust_image_mb": number(r"rr-rust:1\.0\s+([\d.]+) MB"),
    },
    open(sys.argv[2], "w"),
    indent=1,
)
PY
echo "recorded in bench/results/build.json"
