---
id: stale-feed
title: Market data feed is stale while the pod looks healthy
symptoms: [LogAnomaly]
match: Feed heartbeat gap or sequence gap warnings: market data is stale
action: rollout_restart
---
## Recognise
Kubernetes shows the feed handler Running and Ready with no restarts. Its log has stopped printing ticks and repeats a warning about a heartbeat gap or a sequence gap, with the last sequence number frozen. Strategies downstream see prices that no longer move.

## Why it happens
The session to the exchange gateway stalled without closing: a half-open TCP connection, a missed heartbeat during a network blip, or a multicast group that was dropped. The process is alive, so no probe fires.

## Remediate
Restart the feed handler with rollout_restart. A new pod opens a new session and requests a snapshot, which is the same recovery a person would perform. The restart does not change the deployment's configuration.

## Verify
New ticks appear in the log with increasing sequence numbers and the gap warning stops.

## Escalate when
The gap warning returns after the restart. Then the fault is upstream, at the exchange or the network, and trading on stale prices must be stopped by a person.
