#!/usr/bin/env bash
# PLAN, not run in the build environment: measure real Lambda cold starts.
# Needs an AWS account and credentials; it creates billable resources (a few
# cents) and deletes them at the end. Read before running.
#
# A cold start is forced by changing an environment variable, which makes
# Lambda discard every warm sandbox. The number to read is "Init Duration" in
# the REPORT line: the time Lambda spent starting the runtime and the code,
# measured by Lambda itself.
set -euo pipefail
[ "${YES:-0}" = "1" ] || { echo "Creates AWS resources. Re-run with YES=1."; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK="${STACK:-rr-intake}"
RUNS="${RUNS:-20}"
EVENT="$(mktemp)"; python3 "$ROOT/bench/gen-event.py" 4 > "$EVENT"
cd "$ROOT/deploy/sam"
sam deploy --stack-name "$STACK" --resolve-s3 --capabilities CAPABILITY_IAM --no-confirm-changeset
for fn in IntakeRust IntakeTs; do
  name="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='${fn}Name'].OutputValue" --output text)"
  for i in $(seq 1 "$RUNS"); do
    aws lambda update-function-configuration --function-name "$name" --environment "Variables={COLD=$i}" >/dev/null
    aws lambda wait function-updated --function-name "$name"
    aws lambda invoke --function-name "$name" --payload "fileb://$EVENT" --log-type Tail --query LogResult --output text /dev/null \
      | base64 -d | grep REPORT | sed "s/^/$fn /"
  done
done | tee "$ROOT/bench/results/aws-coldstart.txt"
sam delete --stack-name "$STACK" --no-prompts
