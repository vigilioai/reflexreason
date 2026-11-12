#!/usr/bin/env bash
# GPU box only; not run in the build environment. Shows what the gateway's
# canonicalisation is worth to vLLM's prefix cache, in vLLM's own counters.
# Sends the same 12-turn agent session twice, straight to vLLM and through the
# gate, with a client that shuffles tool order and JSON keys on every turn.
#   VLLM=http://127.0.0.1:8000 GATE=http://127.0.0.1:8080 MODEL=Qwen/Qwen3.5-4B scripts/63-bench-vllm-prefix.sh
set -euo pipefail
VLLM="${VLLM:-http://127.0.0.1:8000}"; GATE="${GATE:-http://127.0.0.1:8080}"; MODEL="${MODEL:-Qwen/Qwen3.5-4B}"
python3 - "$VLLM" "$GATE" "$MODEL" <<'PY'
import json, random, sys, time, urllib.request
vllm, gate, model = sys.argv[1:4]
def counters():
    text = urllib.request.urlopen(vllm + "/metrics").read().decode()
    get = lambda name: sum(float(l.rsplit(" ", 1)[1]) for l in text.splitlines() if l.startswith(name) and not l.startswith("#"))
    return get("vllm:prefix_cache_queries"), get("vllm:prefix_cache_hits")
def tool(n):
    return {"type": "function", "function": {"name": n, "description": f"Tool {n} for the on-call agent. " * 6,
            "parameters": {"type": "object", "properties": {"namespace": {"type": "string"}, "pod": {"type": "string"}}, "required": ["namespace"]}}}
TOOLS = [tool(n) for n in ["list_unhealthy", "describe_incident", "pod_logs", "rollout_history", "rollout_status", "load_skill", "list_skills", "runbook_rag"]]
def shuffle_keys(v):
    if isinstance(v, list): return [shuffle_keys(x) for x in v]
    if isinstance(v, dict):
        items = list(v.items()); random.shuffle(items); return {k: shuffle_keys(x) for k, x in items}
    return v
def session(base, tag):
    q0, h0 = counters()
    messages = [{"role": "system", "content": "You are the second-line incident analyst for a Kubernetes cluster. " * 12}]
    t0 = time.time(); first = []
    for turn in range(12):
        messages.append({"role": "user", "content": f"{tag} turn {turn}: summarise this in five words. " + "x" * 300})
        tools = TOOLS[:]; random.shuffle(tools)
        body = shuffle_keys({"model": model, "temperature": 0.7, "max_tokens": 16, "tools": tools, "messages": messages})
        t = time.time()
        r = json.load(urllib.request.urlopen(urllib.request.Request(base + "/v1/chat/completions", json.dumps(body).encode(), {"content-type": "application/json"})))
        first.append(time.time() - t)
        messages.append({"role": "assistant", "content": r["choices"][0]["message"].get("content") or "ok"})
    q1, h1 = counters()
    return {"path": tag, "prompt_tokens_queried": q1 - q0, "prompt_tokens_from_cache": h1 - h0,
            "hit_rate_pct": round(100 * (h1 - h0) / max(1, q1 - q0), 1), "median_request_s": round(sorted(first)[6], 3), "wall_s": round(time.time() - t0, 2)}
print(json.dumps([session(vllm, "direct"), session(gate, "via-gate")], indent=1))
PY
