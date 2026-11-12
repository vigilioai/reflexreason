#!/usr/bin/env bash
# GPU box only: download the language model once, into the directory that
# the vLLM pod mounts. The pod itself is started offline and has no egress,
# so the model, and the code that --trust-remote-code runs, are exactly what
# this script fetched and nothing newer.
#   scripts/15-fetch-model.sh                 Qwen/Qwen3.5-4B
#   MODEL=org/name scripts/15-fetch-model.sh  another model
#   HF_CACHE=/some/dir scripts/15-fetch-model.sh
set -euo pipefail
MODEL="${MODEL:-Qwen/Qwen3.5-4B}"
HF_CACHE="${HF_CACHE:-/var/lib/rr/hf-cache}"

python3 -c 'import huggingface_hub' 2>/dev/null || {
  echo "needs: python3 -m pip install --user huggingface_hub"
  exit 1
}
if [ ! -w "$HF_CACHE" ]; then
  sudo mkdir -p "$HF_CACHE"
  sudo chown "$(id -u):$(id -g)" "$HF_CACHE"
fi
HF_HOME="$HF_CACHE" python3 - "$MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download

path = snapshot_download(sys.argv[1])
print("model files in", path)
PY
du -sh "$HF_CACHE"
