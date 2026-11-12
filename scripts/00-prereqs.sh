#!/usr/bin/env bash
# What is installed, and what each missing piece is needed for. Changes nothing.
have() { command -v "$1" >/dev/null 2>&1; }
row() { printf '%-22s %-10s %s\n' "$1" "$2" "$3"; }
row "node >= 22.12" "$(have node && node -v || echo MISSING)" "all TypeScript agents"
row "cargo / rustup" "$(have cargo && cargo --version | cut -d' ' -f2 || echo MISSING)" "intake, vllm-gate"
row "python3" "$(have python3 && python3 -V | cut -d' ' -f2 || echo MISSING)" "bench drivers, Von decision server"
row "kubectl" "$(have kubectl && echo ok || echo MISSING)" "everything that touches the cluster"
row "k3s" "$(have k3s && echo ok || echo MISSING)" "scripts/10-k3s-up.sh installs it"
row "docker" "$(have docker && echo ok || echo MISSING)" "container images, sam local"
row "nvidia-smi" "$(have nvidia-smi && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1 || echo MISSING)" "vLLM only; the reflex swarm needs no GPU"
row "nvidia-container-runtime" "$(have nvidia-container-runtime && echo ok || echo MISSING)" "GPU pods on k3s"
row "von" "$(have von && echo ok || echo MISSING)" "decision model: pip install 'von-sdk>=1.3.7'"
row "sam" "$(have sam && sam --version | awk '{print $NF}' || echo MISSING)" "optional: Lambda packaging and local invoke"
