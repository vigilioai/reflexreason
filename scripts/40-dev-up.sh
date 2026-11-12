#!/usr/bin/env bash
# Run the agents as local processes against the cluster in your kubeconfig.
# This is the fast loop: edit, rebuild, rerun, no images.
#
#   scripts/40-dev-up.sh           decision model = SYSTEMONE_URL
#                                  (default: Von on :8100)
#   MOCK_LLM=1 scripts/40-dev-up.sh   scripted stand-in for the LLM
#   MOCK=1 scripts/40-dev-up.sh    stand-ins for both models
#
# Ports: 8001 kubectl proxy, 7001 MCP, 7002 retrieval agent (A2A),
#        7003 reason agent (A2A), 8080 vllm-gate, 8000 LLM upstream.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
B="$ROOT/ts/dist/bundle"
LOG="${LOG_DIR:-$ROOT/.logs}"; mkdir -p "$LOG"
PIDS=()
start() {
  local name=$1; shift
  "$@" >"$LOG/$name.log" 2>&1 &
  PIDS+=($!)
  echo "  $name pid $!"
}
trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT INT TERM

export KUBE_API=http://127.0.0.1:8001
export MCP_URL=http://127.0.0.1:7001/mcp
export RAG_URL=http://127.0.0.1:7002
export REASON_URL=http://127.0.0.1:7003
export LLM_BASE_URL=http://127.0.0.1:8080/v1
export INDEX_PATH="$ROOT/ts/index.json"
export SYSTEMONE_URL="${SYSTEMONE_URL:-http://127.0.0.1:8100}"
export SKILLS_DIR="$ROOT/ts/skills"

# Fresh tokens for this run, as in the cluster: A2A_TOKEN opens the agent
# ports, MCP_WRITE_TOKEN makes the MCP server offer its write tools.
token() { head -c 24 /dev/urandom | base64; }
export A2A_TOKEN="${A2A_TOKEN:-$(token)}"
export MCP_WRITE_TOKEN="${MCP_WRITE_TOKEN:-$(token)}"

# The proxy impersonates the agents' service account, so RBAC applies to
# every call exactly as it will in the cluster. Drop --as to act as
# yourself.
start kubectl-proxy kubectl proxy --port=8001 \
  --as=system:serviceaccount:oncall:kube-ops

if [ "${MOCK:-0}" = "1" ]; then
  export SYSTEMONE_URL=http://127.0.0.1:8101
  start mock-systemone env PORT=8101 node "$B/mock-systemone.mjs"
fi
if [ "${MOCK:-0}" = "1" ] || [ "${MOCK_LLM:-0}" = "1" ]; then
  export LLM_MODEL=mock-llm
  start mock-llm env PORT=8000 node "$B/mock-llm.mjs"
fi

# What a second terminal needs in order to talk to this stack:
#   . ./.dev.env && node ts/dist/bundle/swarm.mjs --once
( umask 077
  for v in MCP_URL RAG_URL REASON_URL SYSTEMONE_URL A2A_TOKEN \
           MCP_WRITE_TOKEN; do
    printf 'export %s=%q\n' "$v" "${!v}"
  done > "$ROOT/.dev.env" )

[ -f "$INDEX_PATH" ] ||
  (cd "$ROOT/ts" && node "$B/ingest.mjs" "$ROOT/runbooks")
start vllm-gate env GATE_LISTEN=127.0.0.1:8080 \
  GATE_UPSTREAM="${LLM_UPSTREAM:-http://127.0.0.1:8000}" \
  "$ROOT/rust/target/release/vllm-gate"
start mcp env PORT=7001 node "$B/mcp-server.mjs"
# Only the swarm may write. The two agents that read untrusted text start
# without the write token, exactly as their pods do.
start rag env -u MCP_WRITE_TOKEN PORT=7002 node "$B/rag-server.mjs"
start reason env -u MCP_WRITE_TOKEN PORT=7003 node "$B/reason-server.mjs"

echo "up. logs in $LOG, settings in .dev.env. Ctrl-C stops everything."
wait
