#!/usr/bin/env python3
"""Write an intake event with a feed-handler style log of roughly SIZE_KB kilobytes.
bench/gen-event.py 200 > /tmp/event-200k.json"""

import json, sys

size = int(sys.argv[1]) * 1024 if len(sys.argv) > 1 else 4096
lines, total, i = [], 0, 0
while total < size:
    i += 1
    if i % 997 == 0:
        line = f"08:59:{i % 60:02d}.{i % 1000:03d} WARN feed heartbeat gap {i % 9000}ms last_seq={i}"
    elif i % 4001 == 0:
        line = f"08:59:{i % 60:02d}.{i % 1000:03d} ERROR retransmit request timeout channel=TXF attempt={i % 5}"
    else:
        line = f"08:59:{i % 60:02d}.{i % 1000:03d} md tick seq={i} sym=TXF px={17250 + i % 7} qty={1 + i % 40} lat_us={300 + i % 90}"
    lines.append(line)
    total += len(line) + 1
lines.append("09:00:00.001 FATAL config: FEED_URL is empty")
json.dump(
    {
        "namespace": "trading",
        "workload": "feed-handler",
        "reason": "CrashLoopBackOff",
        "log": "\n".join(lines),
    },
    sys.stdout,
)
