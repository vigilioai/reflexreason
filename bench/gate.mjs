#!/usr/bin/env node
// Gateway benchmark. Needs vllm-gate on GATE (default :8080) in front of the
// scripted mock LLM on UPSTREAM (default :8000). Four measurements:
//   overhead   time the gate itself spends per request, small and large prompts
//   coalesce   200 identical requests at once -> how many reach the model
//   cache      100 requests over 10 distinct prompts -> hits
//   prefix     a 12-turn agent session whose client shuffles tools and JSON keys
//              every turn -> shared prompt prefix before and after canonicalisation
// The coalesce request asks the mock to wait 300 ms, so the 200 copies overlap.
const GATE = process.env.GATE ?? "http://127.0.0.1:8080";
const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:8000";

const metrics = async () => Object.fromEntries((await (await fetch(`${GATE}/gate/metrics`)).text()).trim().split("\n").map((l) => l.split(" ")).map(([k, v]) => [k, Number(v)]));
const upstreamRequests = async () => (await (await fetch(`${UPSTREAM}/stats`)).json()).requests;
const post = (base, body, headers = {}) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const pct = (xs, q) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * q)];
const tool = (name) => ({ type: "function", function: { name, description: `Tool ${name} for the on-call agent. `.repeat(6),
  parameters: { type: "object", properties: { namespace: { type: "string" }, pod: { type: "string" }, tail: { type: "integer" } }, required: ["namespace"] } } });
const TOOLS = ["list_unhealthy", "describe_incident", "pod_logs", "rollout_history", "rollout_status", "load_skill", "list_skills", "runbook_rag"].map(tool);
const shuffled = (xs) => xs.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
const shuffleKeys = (v) => Array.isArray(v) ? v.map(shuffleKeys) : v && typeof v === "object" ? Object.fromEntries(shuffled(Object.entries(v)).map(([k, x]) => [k, shuffleKeys(x)])) : v;

async function timed(base, body, n) {
  const ms = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await (await post(base, { ...body, messages: [...body.messages, { role: "user", content: `request ${i}` }] })).arrayBuffer();
    ms.push(performance.now() - t);
  }
  return { p50_ms: Number(pct(ms, 0.5).toFixed(3)), p99_ms: Number(pct(ms, 0.99).toFixed(3)) };
}

async function overhead(label, system, tools, n = 400) {
  const body = { model: "mock-llm", temperature: 0.7, tools, messages: [{ role: "system", content: system }] };
  await timed(GATE, body, 20); await timed(UPSTREAM, body, 20);
  const m0 = await metrics();
  const viaGate = await timed(GATE, body, n);
  const m1 = await metrics();
  const direct = await timed(UPSTREAM, body, n);
  const requests = m1.gate_requests_total - m0.gate_requests_total;
  return { case: label, request_bytes: JSON.stringify(body).length, requests,
    gate_internal_us: Number(((m1.gate_overhead_microseconds_total - m0.gate_overhead_microseconds_total) / requests).toFixed(1)),
    direct, via_gate: viaGate, added_p50_ms: Number((viaGate.p50_ms - direct.p50_ms).toFixed(3)) };
}

async function coalesce(n = 200) {
  const body = { model: "mock-llm", temperature: 0, mock_delay_ms: 300, messages: [{ role: "user", content: `storm ${Date.now()}: is order-gateway safe to roll back?` }] };
  const before = await upstreamRequests();
  const t = performance.now();
  const outcomes = await Promise.all(Array.from({ length: n }, async () => { const r = await post(GATE, body); await r.arrayBuffer(); return r.headers.get("x-gate"); }));
  const wall = performance.now() - t;
  const count = (k) => outcomes.filter((o) => o === k).length;
  return { identical_requests: n, upstream_calls: (await upstreamRequests()) - before, miss: count("miss"), coalesced: count("coalesced"), hit: count("hit"), wall_ms: Math.round(wall) };
}

async function cache(distinct = 10, total = 100) {
  const stamp = Date.now();
  const before = await upstreamRequests();
  const outcomes = [];
  for (let i = 0; i < total; i++) {
    const r = await post(GATE, { model: "mock-llm", temperature: 0, messages: [{ role: "user", content: `cache ${stamp} question ${i % distinct}` }] });
    await r.arrayBuffer();
    outcomes.push(r.headers.get("x-gate"));
  }
  return { requests: total, distinct_prompts: distinct, hits: outcomes.filter((o) => o === "hit").length, upstream_calls: (await upstreamRequests()) - before };
}

async function prefix(label, { shuffle, clock }) {
  const session = `bench-${label}-${Date.now()}`;
  const messages = [{ role: "system", content: "You are the second-line incident analyst for a Kubernetes cluster. ".repeat(12) }];
  const m0 = await metrics();
  for (let turn = 0; turn < 12; turn++) {
    messages.push({ role: "user", content: `turn ${turn}: tool result ${"x".repeat(300)}` });
    const sent = structuredClone(messages);
    if (clock) sent[0].content = `Current time: 2026-11-11T09:00:${String(turn).padStart(2, "0")}Z. ${sent[0].content}`;
    const body = { model: "mock-llm", temperature: 0.7, tools: shuffle ? shuffled(TOOLS) : TOOLS, messages: sent };
    await (await post(GATE, shuffle ? shuffleKeys(body) : body, { "x-session-id": session })).arrayBuffer();
    messages.push({ role: "assistant", content: `answer ${turn}` });
  }
  const m1 = await metrics();
  const total = m1.gate_prompt_bytes_total - m0.gate_prompt_bytes_total;
  const share = (k) => Number((100 * (m1[k] - m0[k]) / total).toFixed(1));
  return { session: label, turns: 12, prompt_bytes: total, shared_as_sent_pct: share("gate_prompt_shared_raw_bytes_total"), shared_canonical_pct: share("gate_prompt_shared_canonical_bytes_total") };
}

const out = {
  overhead: [await overhead("small prompt, no tools", "You are a helpful agent.", undefined), await overhead("agent prompt, 8 tools", "You are the incident analyst. ".repeat(40), TOOLS)],
  coalesce: await coalesce(),
  cache: await cache(),
  prefix: [
    await prefix("stable client", { shuffle: false, clock: false }),
    await prefix("client shuffles tools and keys", { shuffle: true, clock: false }),
    await prefix("clock in the system prompt", { shuffle: false, clock: true }),
  ],
};
console.log(JSON.stringify(out, null, 1));
