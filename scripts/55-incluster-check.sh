#!/usr/bin/env bash
# After scripts/20-deploy.sh: is the in-cluster deployment doing its job?
# Injects one fault, waits for the swarm pods to handle it, and checks that
# the network policy keeps a stranger out and an agent in. Prints JSON.
#   scripts/55-incluster-check.sh > bench/results/incluster.json
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export ROOT
python3 - <<'PY'
import json, os, subprocess, sys, time

ROOT = os.environ["ROOT"]


def sh(*cmd, timeout=180):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def kubectl(*args, **kw):
    return sh("kubectl", *args, **kw)


def note(text):
    print(text, file=sys.stderr)


# 1. What is running.
_, out, _ = kubectl("-n", "oncall", "get", "pods", "-o", "json")
pods = [
    {
        "name": p["metadata"]["name"],
        "app": p["metadata"].get("labels", {}).get("app", ""),
        "ready": all(c.get("ready") for c in
                     p["status"].get("containerStatuses", [])),
        "restarts": sum(c.get("restartCount", 0) for c in
                        p["status"].get("containerStatuses", [])),
    }
    for p in json.loads(out)["items"]
]
note(f"{sum(p['ready'] for p in pods)} of {len(pods)} pods ready")

# 2. One fault, handled by the swarm pods and nobody else.
sh(f"{ROOT}/scripts/30-inject.sh", "reset", timeout=300)
since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
t0 = time.time()
sh(f"{ROOT}/scripts/30-inject.sh", "crash-config")
record = None
while time.time() - t0 < 240 and record is None:
    time.sleep(3)
    _, logs, _ = kubectl("-n", "oncall", "logs", "-l", "app=swarm",
                         "--since-time", since, "--tail", "-1",
                         "--prefix", "--all-containers")
    for line in logs.splitlines():
        prefix, _, body = line.partition("] ")
        if body.startswith("{") and '"feed-handler"' in body:
            record = json.loads(body)
            record["handled_by"] = prefix.strip("[").split("/")[1]
seconds = round(time.time() - t0, 1)
_, leases, _ = kubectl("-n", "oncall", "get", "lease", "-o",
                       "jsonpath={range .items[*]}{.metadata.name}="
                       "{.spec.holderIdentity} {end}")
rollout, _, _ = kubectl("-n", "trading", "rollout", "status",
                        "deploy/feed-handler", "--timeout=60s")
note(f"incident record after {seconds}s: {bool(record)}")

# 3. Network policy. A pod with no label must not reach the MCP server; a
# swarm pod must reach it and must not reach the internet.
stranger, _, _ = kubectl(
    "-n", "oncall", "run", "np-probe", "--rm", "-i", "--restart=Never",
    "--image=busybox:1.36", "--command", "--",
    "wget", "-qO-", "-T", "5", "http://kube-ops-mcp:7001/healthz",
    timeout=120)
fetch = ("fetch(process.argv[1], {signal: AbortSignal.timeout(5000)})"
         ".then(r => r.text()).then(t => console.log('reached'))"
         ".catch(() => { console.log('blocked') })")
_, inside, _ = kubectl("-n", "oncall", "exec", "deploy/swarm", "--",
                       "node", "-e", fetch,
                       "http://kube-ops-mcp:7001/healthz")
_, outside, _ = kubectl("-n", "oncall", "exec", "deploy/swarm", "--",
                        "node", "-e", fetch, "http://1.1.1.1/")
sh(f"{ROOT}/scripts/30-inject.sh", "reset", timeout=300)

handled = bool(record and record.get("executed") and record.get("recovered"))
netpol = {
    "stranger_to_mcp": "blocked" if stranger != 0 else "reached",
    "swarm_to_mcp": inside or "no answer",
    "swarm_to_internet": outside or "no answer",
}
enforced = (netpol["stranger_to_mcp"] == "blocked"
            and netpol["swarm_to_mcp"] == "reached"
            and netpol["swarm_to_internet"] == "blocked")
print(json.dumps({
    "pods": pods,
    "all_ready": all(p["ready"] for p in pods),
    "fault": "crash-config",
    "handled": handled,
    "seconds_from_injection_to_record": seconds,
    "record": record,
    "leases": leases.split(),
    "rollout_ok": rollout == 0,
    "netpol": netpol,
    "netpol_enforced": enforced,
}, indent=1))
PY
