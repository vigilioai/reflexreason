---
id: clock-skew
title: Clock skew against the exchange exceeds tolerance
symptoms: [CrashLoopBackOff, Error, LogAnomaly]
match: Clock skew or lost time synchronisation against the exchange
action: escalate
---
## Recognise
The component exits or idles with a line that reports clock skew in milliseconds against the exchange and a tolerance it exceeds, and states that it refuses to trade.

## Why it happens
Time synchronisation on the node drifted or lost its source. Order timestamps outside the exchange's tolerance are rejected, and audit trails with wrong times are a regulatory problem, so the component stops on purpose.

## Remediate
No automatic action. Restarting the component does not move the clock, and a rollback would restart a healthy binary.

## Verify
Not applicable until time synchronisation on the node is repaired.

## Escalate when
Always. Page the infrastructure owner; trading on this node stays halted until the skew is back inside tolerance.
