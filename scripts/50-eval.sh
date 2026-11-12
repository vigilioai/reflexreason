#!/usr/bin/env bash
# Run the fault scenarios against the cluster and record what the swarm did.
# Start the agents first (scripts/40-dev-up.sh, or the in-cluster deployment
# with port-forwards). ACTION_BUDGET on the MCP server should be high for this.
#   scripts/50-eval.sh                 all ten scenarios
#   scripts/50-eval.sh oom storm       only these
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Tokens of the running local stack, written by scripts/40-dev-up.sh.
[ -f "$ROOT/.dev.env" ] && . "$ROOT/.dev.env"
export MCP_URL="${MCP_URL:-http://127.0.0.1:7001/mcp}" RAG_URL="${RAG_URL:-http://127.0.0.1:7002}"
export REASON_URL="${REASON_URL:-http://127.0.0.1:7003}" SYSTEMONE_URL="${SYSTEMONE_URL:-http://127.0.0.1:8100}"
mkdir -p "$ROOT/bench/results"
out="$ROOT/bench/results/scenarios.json"
[ $# -gt 0 ] && out="$ROOT/bench/results/scenarios-partial.json"
node "$ROOT/ts/dist/bundle/eval.mjs" "$@" > "$out"
python3 - "$out" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(f"{d['passed']}/{d['total']} scenarios passed on {d['cluster']}")
for r in d["results"]:
    print(f"  {'ok  ' if r['pass'] else 'FAIL'} {r['scenario']:14s} detect {r['detect_ms']/1000:5.1f}s  handle {r['handle_ms']/1000:5.1f}s  agents {r['agents']}")
PY
