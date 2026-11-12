#!/usr/bin/env bash
# What can the agents' identity do, and what does each door answer without a
# key? Prints JSON; the tutorial's security tables are generated from it.
# Needs the local stack (scripts/40-dev-up.sh) and kubectl.
#   scripts/45-door-check.sh > bench/results/door.json
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/.dev.env" ] && . "$ROOT/.dev.env"
export MCP_URL="${MCP_URL:-http://127.0.0.1:7001/mcp}"
export RAG_URL="${RAG_URL:-http://127.0.0.1:7002}"
export REASON_URL="${REASON_URL:-http://127.0.0.1:7003}"
python3 - <<'PY'
import json, os, subprocess, urllib.request, urllib.error

SA = "system:serviceaccount:oncall:kube-ops"

def can(verb, resource, ns):
    p = subprocess.run(["kubectl", "auth", "can-i", verb, resource,
                        "-n", ns, "--as", SA],
                       capture_output=True, text=True)
    return p.stdout.strip() or p.stderr.strip()

RBAC = [("get", "pods", "trading"), ("get", "pods/log", "trading"),
        ("patch", "deployments", "trading"),
        ("delete", "pods", "trading"), ("delete", "deployments", "trading"),
        ("create", "pods/exec", "trading"), ("get", "secrets", "trading"),
        ("create", "deployments", "trading"),
        ("patch", "deployments", "oncall"), ("get", "secrets", "oncall"),
        ("create", "leases", "oncall"), ("delete", "namespaces", "trading")]

def post(url, body, token=None):
    headers = {"content-type": "application/json",
               "accept": "application/json, text/event-stream"}
    if token:
        headers["authorization"] = "Bearer " + token
    req = urllib.request.Request(url, json.dumps(body).encode(), headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def rpc_result(text):
    # A Streamable HTTP reply is either JSON or one server-sent event.
    for line in text.splitlines():
        if line.startswith("data:"):
            text = line[5:]
    return json.loads(text)

def tools(token):
    _, text = post(os.environ["MCP_URL"],
                   {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, token)
    return sorted(t["name"] for t in rpc_result(text)["result"]["tools"])

def call(name, args, token):
    _, text = post(os.environ["MCP_URL"],
                   {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                    "params": {"name": name, "arguments": args}}, token)
    r = rpc_result(text)
    if "error" in r:
        return "error: " + r["error"]["message"]
    body = r["result"]["content"][0]["text"]
    return ("refused: " if r["result"].get("isError") else "ok: ") + body[:160]

def a2a(url, token):
    ask = json.dumps({"query": "FATAL config: FEED_URL is empty",
                      "symptom": "Error"})
    msg = {"jsonrpc": "2.0", "id": 1, "method": "message/send",
           "params": {"message": {"kind": "message", "messageId": "door-1",
                                  "role": "user", "parts": [
                                      {"kind": "text", "text": ask}]}}}
    return post(url, msg, token)[0]

RAG = os.environ["RAG_URL"].rstrip("/") + "/"
REASON = os.environ["REASON_URL"].rstrip("/") + "/"
write_token = os.environ.get("MCP_WRITE_TOKEN", "")
a2a_token = os.environ.get("A2A_TOKEN", "")
undo = {"namespace": "trading", "deployment": "feed-handler",
        "fingerprint": "door-check", "dry_run": True}
out = {
    "identity": SA,
    "rbac": [{"verb": v, "resource": r, "namespace": n, "allowed": can(v, r, n)}
             for v, r, n in RBAC],
    "mcp": {
        "token_configured": bool(write_token),
        "tools_without_token": tools(None),
        "tools_with_token": tools(write_token) if write_token else None,
        "rollout_undo_without_token": call("rollout_undo", undo, None),
        "rollout_undo_wrong_namespace": call(
            "rollout_undo", {**undo, "namespace": "kube-system"},
            write_token or None),
        "memory_above_ceiling": call(
            "set_memory_limit",
            {**undo, "deployment": "risk-engine", "memory_mi": 4096},
            write_token or None),
        "rollout_restart_dry_run_with_token": call(
            "rollout_restart", undo, write_token or None),
    },
    # The retrieval agent serves JSON-RPC at its root, ADK serves it at
    # /jsonrpc; the bearer check sits in front of both.
    "a2a": {
        "token_configured": bool(a2a_token),
        "rag_without_token": a2a(RAG, None),
        "rag_with_token": a2a(RAG, a2a_token or None),
        "reason_without_token": a2a(REASON + "jsonrpc", None),
        "reason_agent_card_without_token": urllib.request.urlopen(
            REASON + ".well-known/agent-card.json", timeout=20).status,
    },
}
print(json.dumps(out, indent=1))
PY
