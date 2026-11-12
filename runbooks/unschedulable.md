---
id: unschedulable
title: Pod cannot be scheduled
symptoms: [Unschedulable]
match: Pod cannot be scheduled: insufficient CPU or memory, taint or selector
action: escalate
---
## Recognise
The pod is Pending and the scheduler reports FailedScheduling with a count of nodes and a reason for each: Insufficient cpu, Insufficient memory, an untolerated taint or an unmatched node selector.

## Why it happens
The pod asks for more than any node can offer, or the cluster lost capacity. Neither is a property of the pod that an agent may change safely.

## Remediate
No automatic action. Lowering requests would let the pod start on a node that cannot carry it, and adding nodes is a spending decision.

## Verify
Not applicable until a person has acted.

## Escalate when
Always. Page the platform owner with the scheduler message and the pod's requests.
