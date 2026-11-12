#!/usr/bin/env bash
# Single-node k3s on Ubuntu with the NVIDIA runtime. THIS CHANGES THE MACHINE:
# it installs a system service and writes under /etc/rancher and /var/lib/rancher.
# Read it before running it. It was written from the k3s documentation
# (https://docs.k3s.io/advanced, "NVIDIA Container Runtime") and was not
# executed in the environment that produced the benchmark numbers.
set -euo pipefail
[ "${YES:-0}" = "1" ] || { echo "This installs k3s as a system service. Re-run with YES=1 to proceed."; exit 1; }

# 1. GPU pieces first: k3s looks for nvidia-container-runtime on PATH when it starts.
if ! command -v nvidia-container-runtime >/dev/null; then
  echo "Install the NVIDIA driver and nvidia-container-toolkit first:"
  echo "  https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
  echo "The reflex swarm runs without them; only the vLLM pod needs a GPU."
fi

# 2. k3s without the bundled ingress and load balancer, which this project does not use.
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server --disable traefik --disable servicelb --write-kubeconfig-mode 644" sh -

# 3. Use it as the current user.
mkdir -p "$HOME/.kube" && sudo cat /etc/rancher/k3s/k3s.yaml > "$HOME/.kube/config" && chmod 600 "$HOME/.kube/config"
kubectl wait --for=condition=Ready node --all --timeout=120s

# 4. Did k3s pick up the GPU runtime? It ships the `nvidia` RuntimeClass itself.
if sudo grep -q nvidia /var/lib/rancher/k3s/agent/etc/containerd/config.toml; then
  echo "NVIDIA runtime registered; GPU pods use runtimeClassName: nvidia"
else
  echo "NVIDIA runtime not found by k3s; GPU pods will not start until it is (CPU-only mode still works)"
fi
