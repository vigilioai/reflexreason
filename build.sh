#!/usr/bin/env bash
# From a clean checkout to tested binaries, bundles, a search index and
# Lambda packages. Needs Node >= 22.12, Rust (rustup), Python 3 and network
# access to npm, crates.io and huggingface.co. Nothing is installed
# system-wide.
#
#   ./build.sh            build and test everything
#   IMAGES=1 ./build.sh   also build the two container images (needs Docker)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
step() { printf '\n== %s\n' "$*"; }
# One readable line from the JSON that the ingest step prints.
index_summary() {
  python3 -c 'import json, sys
d = json.load(sys.stdin)
print(d["chunks"], "chunks,", d["dims"], "dimensions,",
      "embedded in", d["embed_ms"], "ms")'
}
MUSL=x86_64-unknown-linux-musl
OUT="rust/target/$MUSL/release"

step "1/7 toolchain"
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    console.error("Node >= 22.12 required, found " + process.version);
    process.exit(1);
  }'
echo "node $(node -v), $(cargo --version), $(python3 --version)"

step "2/7 rust: unit tests, host build, static build"
(cd rust && cargo test --release --quiet 2>&1 \
  | grep -E "^test result|FAILED|panicked" \
  | sed -E 's/; [0-9]+ ignored.*//' || true)
(cd rust && cargo build --release --quiet)
# A static musl binary runs in a scratch container and as a Lambda
# bootstrap, whatever glibc the host or the runtime has.
rustup target list --installed | grep -q "$MUSL" \
  || rustup target add "$MUSL"
(cd rust && cargo build --release --quiet --target "$MUSL")

step "3/7 typescript: install, type-check, compile, bundle, unit tests"
(cd ts && npm ci --no-audit --no-fund --loglevel=error)
(cd ts && npx tsc && node esbuild.mjs)
(cd ts && npm test 2>&1 | grep -E "^# (tests|pass|fail)")

step "4/7 the Rust intake and its TypeScript twin agree"
scripts/check-twins.sh

step "5/7 retrieval index (downloads the 23 MB embedding model once)"
(cd ts && INDEX_PATH="$ROOT/ts/index.json" \
  node dist/bundle/ingest.mjs "$ROOT/runbooks") | index_summary

step "6/7 Lambda packages"
rm -rf dist/lambda
mkdir -p dist/lambda/intake-rust dist/lambda/intake-ts
cp "$OUT/intake" dist/lambda/intake-rust/bootstrap
cp ts/dist/bundle/intake-lambda.mjs dist/lambda/intake-ts/

step "7/7 artifacts"
ls -l "$OUT/intake" "$OUT/vllm-gate" ts/dist/bundle/*.mjs \
  | awk '{printf "%9d  %s\n", $5, $9}'

if [ "${IMAGES:-0}" = "1" ]; then
  step "images"
  # Only the embedding runtime is installed into the image; everything else
  # is already inside the bundles. The model is cached now so that pods
  # need no egress.
  RT=dist/runtime
  rm -rf "$RT" && mkdir -p "$RT"
  (cd "$RT" && npm init -y >/dev/null && npm install --no-audit --no-fund \
    --loglevel=error --omit=dev @huggingface/transformers@4.3.2)
  (cd "$RT" && node --input-type=module -e '
    const t = await import("@huggingface/transformers");
    await t.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2",
      { dtype: "q8" });')
  # onnxruntime ships binaries for every platform plus GPU providers and
  # browser builds. Keep only this machine's CPU build.
  ORT="$RT/node_modules/onnxruntime-node/bin/napi-v6"
  KEEP="$ORT/linux/$(node -p process.arch)"
  find "$ORT" -mindepth 2 -maxdepth 2 -type d ! -path "$KEEP" \
    -exec rm -rf {} +
  rm -f "$KEEP"/libonnxruntime_providers_cuda.so \
        "$KEEP"/libonnxruntime_providers_tensorrt.so
  find "$RT/node_modules/onnxruntime-web" \
    \( -name '*.wasm' -o -name '*.map' \) -delete
  docker build -q -f deploy/docker/agents.Dockerfile -t rr-agents:1.0 .
  docker build -q -f deploy/docker/rust.Dockerfile -t rr-rust:1.0 .
  # The image has to be able to embed on its own, with no network.
  docker run --rm --network none -e INDEX_PATH=/tmp/index.json \
    rr-agents:1.0 node bundle/ingest.mjs runbooks | index_summary
  docker image inspect rr-agents:1.0 rr-rust:1.0 \
    --format '{{index .RepoTags 0}} {{.Size}}' \
    | awk '{printf "%s  %.1f MB\n", $1, $2 / 1048576}'
fi
echo; echo "build ok"
