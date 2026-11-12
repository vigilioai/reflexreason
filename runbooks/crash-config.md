---
id: crash-config
title: Crash loop from a configuration error
symptoms: [CrashLoopBackOff, Error, CreateContainerConfigError]
match: Configuration error: a setting is missing, empty or invalid
action: rollout_undo
---
## Recognise
The container starts, prints a fatal line that names a setting, and exits with a small non-zero code. Typical lines: FATAL config: FEED_URL is empty, invalid value for --max-order-size, required key missing. The restart count climbs and the pod state is CrashLoopBackOff. The crashes begin right after a rollout.

## Why it happens
The last change removed or emptied an environment variable, a ConfigMap key or a flag. The binary validates its configuration at start and refuses to run, which is the correct behaviour for a trading component: running with a wrong limit is worse than not running.

## Remediate
Return the deployment to its previous revision with rollout_undo. The configuration that worked comes back with it. Do not edit the configuration by hand during the incident.

## Verify
The pod is Running and Ready, the restart count stops increasing, and the fatal line no longer appears in the log.

## Escalate when
There is no previous revision, or the same fatal line appears on the previous revision too. Then the cause is outside the deployment, for example a shared ConfigMap, and a person must decide.
