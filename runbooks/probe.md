---
id: probe
title: Readiness probe fails after a rollout
symptoms: [NotReady]
match: Readiness probe fails: pod is Running but never Ready
action: rollout_undo
---
## Recognise
The container is Running and does not restart, but the pod never becomes Ready. Events repeat Readiness probe failed with the probe's own error, such as a refused connection, a missing file or a wrong path. The Service has no endpoints for the new pods.

## Why it happens
The rollout changed the probe, the port or the path the probe checks, so a healthy process is reported as unready. Less often the process itself hangs during start.

## Remediate
Return the deployment to its previous revision with rollout_undo. Restarting does not help, because the new pods would carry the same probe.

## Verify
All pods are Ready and the Service lists endpoints again.

## Escalate when
There is no previous revision, or pods of the previous revision are unready as well.
