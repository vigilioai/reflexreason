#!/usr/bin/env bash
# Build the images, load them into k3s and apply the manifests.
#   scripts/20-deploy.sh           agents + decision model (CPU only)
#   GPU=1 scripts/20-deploy.sh     also the vLLM pod with the gateway;
#                                  run scripts/15-fetch-model.sh first
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
HF_CACHE="${HF_CACHE:-/var/lib/rr/hf-cache}"
if [ "${GPU:-0}" = "1" ] && [ ! -d "$HF_CACHE/hub" ]; then
  echo "no model in $HF_CACHE: run scripts/15-fetch-model.sh first"
  exit 1
fi

IMAGES=1 ./build.sh
docker build -q -f deploy/docker/decision.Dockerfile -t rr-decision:1.0 .
# k3s runs its own containerd; images built by Docker have to be imported.
for image in rr-agents:1.0 rr-rust:1.0 rr-decision:1.0; do
  docker save "$image" | sudo k3s ctr images import -
done

kubectl apply -f deploy/scenarios/trading.yaml \
              -f deploy/k8s/00-oncall-rbac.yaml
# Two secrets, generated once: one opens the A2A ports, the other makes the
# MCP server offer its write tools.
for secret in a2a-token mcp-write-token; do
  kubectl -n oncall get secret "$secret" >/dev/null 2>&1 || \
    kubectl -n oncall create secret generic "$secret" \
      --from-literal=token="$(head -c 24 /dev/urandom | base64)"
done
kubectl apply -f deploy/k8s/10-decision.yaml -f deploy/k8s/30-agents.yaml \
              -f deploy/k8s/40-networkpolicy.yaml
if [ "${GPU:-0}" = "1" ]; then
  kubectl apply -f deploy/k8s/20-llm.yaml
fi
kubectl -n oncall rollout status deploy --timeout=900s
kubectl -n oncall get pods
