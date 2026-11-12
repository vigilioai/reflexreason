#!/usr/bin/env bash
# The Rust intake and its TypeScript twin must agree byte for byte.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUST="$ROOT/rust/target/release/intake"
NODE="node $ROOT/ts/dist/bundle/intake-cli.mjs"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
for kb in 1 16 256; do python3 "$ROOT/bench/gen-event.py" "$kb" > "$TMP/gen-$kb.json"; done
printf '%s' '{"namespace":"trading","workload":"risk-engine","reason":"OOMKilled","log":""}' > "$TMP/empty.json"
printf '%s' '{"namespace":"t","workload":"w","reason":"Error","log":"  價格 px=17250 \"quoted\" back\\\\slash\ttab\r\n\n線路 ERROR  timeout  after 30s\n"}' > "$TMP/unicode.json"
for f in "$TMP"/*.json; do
  if [ "$($RUST < "$f" | sha1sum)" = "$($NODE < "$f" | sha1sum)" ]; then echo "same  $(basename "$f")"
  else echo "DIFF  $(basename "$f")"; fail=1; fi
done
exit $fail
