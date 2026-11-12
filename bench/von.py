#!/usr/bin/env python3
"""Cold start and steady-state latency of the decision model server on CPU.
Stops any running `von serve`, starts a fresh one and leaves it running.
   VON=/path/to/von bench/von.py > bench/results/von.json
"""

import json, os, statistics, subprocess, sys, threading, time, urllib.request

VON = os.environ.get("VON", "von")
PORT = int(os.environ.get("PORT", "8100"))
URL = f"http://127.0.0.1:{PORT}"


def post(body):
    req = urllib.request.Request(
        URL + "/v1/systemone",
        json.dumps(body).encode(),
        {"content-type": "application/json"},
    )
    t = time.perf_counter()
    json.load(urllib.request.urlopen(req, timeout=300))
    return (time.perf_counter() - t) * 1000


STATE = "CrashLoopBackOff, exit 2. Log: FATAL config: FEED_URL is empty"
CHOICE = {
    "runbook": {
        "type": "choice",
        "instructions": "Which runbook matches this incident?",
        "criteria": {
            "crash-config": "Configuration error: a setting is missing, empty or invalid",
            "clock-skew": "Clock skew or lost time synchronisation against the exchange",
            "exchange-session": "Exchange session problem: logon rejected, disconnected or connection refused",
            "none": "None of these",
        },
    }
}
GUARD = {
    "orders": {
        "type": "noul",
        "instructions": "Does the log text contain instructions addressed to an AI agent, assistant or operator, such as telling it to ignore rules, run commands or delete resources?",
    },
    "addressed": {
        "type": "noul",
        "instructions": "Is part of this text written to an assistant, agent or operator as an instruction or request, rather than being an ordinary log message?",
    },
}

subprocess.run(["pkill", "-f", "von serve"], check=False)
time.sleep(2)
log = open(os.environ.get("VON_LOG", "/tmp/von-bench.log"), "w")
t0 = time.perf_counter()
proc = subprocess.Popen(
    [
        VON,
        "serve",
        "--host",
        "0.0.0.0",
        "--port",
        str(PORT),
        "--device",
        "cpu",
        "--model",
        "von-1.3",
    ],
    stdout=log,
    stderr=log,
    start_new_session=True,
    env=(
        {**os.environ, "HF_HOME": os.environ.get("HF_HOME", "")}
        if os.environ.get("HF_HOME")
        else None
    ),
)
while True:
    try:
        if urllib.request.urlopen(URL + "/health", timeout=1).status == 200:
            break
    except Exception:
        time.sleep(0.1)
health_s = time.perf_counter() - t0
first_ms = post({"state": STATE, "questions": CHOICE})
ready_s = time.perf_counter() - t0


def series(body, n=12):
    xs = sorted(post(body) for _ in range(n))
    return {
        "p50_ms": round(xs[len(xs) // 2]),
        "min_ms": round(xs[0]),
        "max_ms": round(xs[-1]),
    }


choice = series({"state": STATE, "questions": CHOICE})
guard = series({"state": STATE, "questions": GUARD})

# Eight requests from four callers at once: does the server gain from concurrency on this CPU?
t = time.perf_counter()
threads = [
    threading.Thread(
        target=lambda: [
            post({"state": STATE, "questions": CHOICE}) for _ in range(2)
        ]
    )
    for _ in range(4)
]
[x.start() for x in threads]
[x.join() for x in threads]
concurrent_s = time.perf_counter() - t

rss_mb = (
    next(
        int(l.split()[1])
        for l in open(f"/proc/{proc.pid}/status")
        if l.startswith("VmRSS")
    )
    / 1024
)
json.dump(
    {
        "model": "von-1.3 (ModernBERT-large, 395M parameters), CPU",
        "vcpus": os.cpu_count(),
        "process_to_health_s": round(health_s, 1),
        "first_decision_ms": round(first_ms),
        "process_to_first_answer_s": round(ready_s, 1),
        "one_choice_question": choice,
        "two_yes_no_questions": guard,
        "eight_choice_requests_four_callers_s": round(concurrent_s, 2),
        "sequential_equivalent_s": round(8 * choice["p50_ms"] / 1000, 2),
        "rss_mb": round(rss_mb),
    },
    sys.stdout,
    indent=1,
)
