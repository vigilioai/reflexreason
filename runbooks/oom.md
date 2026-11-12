---
id: oom
title: Container killed for exceeding its memory limit
symptoms: [OOMKilled]
match: Out of memory: container OOMKilled, exit 137, memory limit exceeded
action: raise_memory
max_memory_factor: 2
---
## Recognise
The last termination reason is OOMKilled and the exit code is 137. The log usually ends in the middle of normal work, because the kernel kills the process without warning. There may be no error line at all.

## Why it happens
The working set grew past the container's memory limit: more instruments, a larger position book at market open, or a limit that was set from an idle measurement. A leak looks the same at first, which is why the automatic step is bounded.

## Remediate
Raise the memory limit with set_memory_limit to twice the current value, never above the platform ceiling. One step only. Record the change so that capacity planning sees it.

## Verify
The pod stays Running and Ready for the verification window and the restart count stops increasing.

## Escalate when
The limit is already at the ceiling, or the container is OOMKilled again after one raise. Repeated growth is a leak, and feeding a leak more memory only delays the page.
