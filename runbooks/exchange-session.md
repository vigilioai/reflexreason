---
id: exchange-session
title: Order gateway lost its exchange session
symptoms: [CrashLoopBackOff, Error, LogAnomaly]
match: Exchange session problem: logon rejected, disconnected or connection refused
action: escalate
---
## Recognise
The order gateway logs a rejected logon, a refused connection to the exchange endpoint, or repeated disconnects. Orders are not acknowledged.

## Why it happens
Credentials expired, the exchange session was already open elsewhere, or the line is down. The gateway may hold working orders whose state is unknown.

## Remediate
No automatic action. Restarting a gateway with working orders can duplicate or orphan them. Order state must be reconciled first.

## Verify
Not applicable until a person has reconciled open orders.

## Escalate when
Always. Page the trading desk and the session owner at the same time.
