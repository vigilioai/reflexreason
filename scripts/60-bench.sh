#!/usr/bin/env bash
# Every benchmark that needs no cluster. Results land in bench/results/*.json
# and the tutorial's tables and charts are generated from those files.
# Close other heavy programs first; these are timing measurements.
#   scripts/60-bench.sh                       all
#   scripts/60-bench.sh coldstart gate        only these
# `decisions` needs the real decision model on SYSTEMONE_URL (default :8100).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
B="$ROOT/ts/dist/bundle"; R="$ROOT/bench/results"; mkdir -p "$R"
TMP="$(mktemp -d)"; PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
bg() { "$@" >/dev/null 2>&1 & PIDS+=($!); }
want() { [ $# -eq 0 ] || [[ " ${ALL[*]} " == *" $1 "* ]]; }
ALL=("$@"); pick() { [ ${#ALL[@]} -eq 0 ] || [[ " ${ALL[*]} " == *" $1 "* ]]; }
RUNS="${RUNS:-40}"

if pick coldstart; then
  echo "== cold start"
  python3 bench/gen-event.py 4 > "$TMP/event-4k.json"
  python3 bench/coldstart.py --runs "$RUNS" --event "$TMP/event-4k.json" > "$R/coldstart.json"
fi

if pick throughput; then
  echo "== intake throughput, warm"
  {
    echo '['
    first=1
    for kb in 4 256 4096; do
      python3 bench/gen-event.py "$kb" > "$TMP/event-$kb.json"
      n=$(( kb >= 4096 ? 30 : 300 ))
      for cmd in "rust/target/release/intake --bench $n" "node $B/intake-cli.mjs --bench $n"; do
        [ $first -eq 1 ] || echo ','; first=0
        $cmd < "$TMP/event-$kb.json"
      done
    done
    echo ']'
  } > "$R/intake-throughput.json"
fi

if pick chunking; then
  echo "== chunking"
  (cd ts && node "$B/bench-chunking.mjs" "$ROOT/runbooks" "$ROOT/fixtures/decisions.jsonl") > "$R/chunking.json"
fi

if pick gate; then
  echo "== gateway"
  bg env PORT=18000 node "$B/mock-llm.mjs"
  bg env GATE_LISTEN=127.0.0.1:18080 GATE_UPSTREAM=http://127.0.0.1:18000 GATE_MAX_INFLIGHT=64 rust/target/release/vllm-gate
  sleep 1
  GATE=http://127.0.0.1:18080 UPSTREAM=http://127.0.0.1:18000 node bench/gate.mjs > "$R/gate.json"
  ps -o rss= -p "${PIDS[-1]}" | awk '{printf "{\"gate_rss_mb_after_bench\": %.1f}\n", $1/1024}' > "$R/gate-rss.json"
fi

if pick swarm; then
  echo "== swarm memory"
  bg env PORT=17101 node "$B/mock-mcp.mjs"
  bg env PORT=18101 MOCK_S1_DELAY_MS=100 node "$B/mock-systemone.mjs"
  bg env PORT=17102 SYSTEMONE_URL=http://127.0.0.1:18101 INDEX_PATH="$ROOT/ts/index.json" node "$B/rag-server.mjs"
  sleep 3
  (cd ts && MCP_URL=http://127.0.0.1:17101/mcp RAG_URL=http://127.0.0.1:17102 SYSTEMONE_URL=http://127.0.0.1:18101 REASON_URL= VERIFY_TIMEOUT_SEC=20 \
     node --expose-gc "$B/bench-swarm-mem.mjs" 1 10 100 1000) > "$R/swarm-mem.json"
fi

if pick decisions; then
  echo "== decision layer on the labelled set (real model)"
  (cd ts && INDEX_PATH="$ROOT/ts/index.json" node "$B/bench-decisions.mjs" "$ROOT/fixtures/decisions.jsonl") > "$R/decisions.json"
fi
echo "results in $R"
