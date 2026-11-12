// How much memory does one more agent cost? Run N reflex agents at once
// against stand-in backends that answer after a fixed delay, so that all N
// are in flight together, and sample this process's memory while they wait.
//   node bench-swarm-mem.mjs 1 10 100 1000 > bench/results/swarm-mem.json
// Needs: mock MCP on MCP_URL, retrieval agent on RAG_URL, mock decision
// server.
import { closeMcp } from "../mcp/client.js";
import { handleIncident, type Target } from "../reflex/agent.js";
import { pool } from "../swarm/dispatcher.js";

const sizes = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => n > 0);
const mb = (bytes: number): number => Number((bytes / 1048576).toFixed(1));
const gc = (): void => {
  (globalThis as { gc?: () => void }).gc?.();
};

// One warm-up agent: connect MCP and A2A, load every module, so the numbers
// below are the cost of agents and not of start-up.
await handleIncident({
  namespace: "trading",
  workload: "warm",
  pod: "warm-pod",
  reason: "CrashLoopBackOff",
});
gc();
const idle = process.memoryUsage();
const rows = [];
for (const n of sizes.length > 0 ? sizes : [1, 10, 100, 1000]) {
  gc();
  const before = process.memoryUsage();
  let peakRss = before.rss,
    peakHeap = before.heapUsed;
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakHeap = Math.max(peakHeap, m.heapUsed);
  }, 10);
  const targets: Target[] = Array.from({ length: n }, (_, i) => ({
    namespace: "trading",
    workload: `w${i}`,
    pod: `w${i}-pod`,
    reason: "CrashLoopBackOff",
  }));
  const t0 = performance.now();
  const records = await pool(targets, n, handleIncident);
  const wall = performance.now() - t0;
  clearInterval(sampler);
  rows.push({
    agents: n,
    wall_ms: Math.round(wall),
    incidents_per_s: Number((n / (wall / 1000)).toFixed(1)),
    acted: records.filter((r) => r.executed).length,
    rss_before_mb: mb(before.rss),
    rss_peak_mb: mb(peakRss),
    heap_before_mb: mb(before.heapUsed),
    heap_peak_mb: mb(peakHeap),
    heap_kb_per_agent: Number(
      ((peakHeap - before.heapUsed) / 1024 / n).toFixed(1),
    ),
    rss_kb_per_agent: Number(
      ((peakRss - before.rss) / 1024 / n).toFixed(1),
    ),
  });
  console.error(JSON.stringify(rows.at(-1)));
}
await closeMcp();
console.log(
  JSON.stringify(
    {
      idle_rss_mb: mb(idle.rss),
      idle_heap_mb: mb(idle.heapUsed),
      node: process.version,
      rows,
    },
    null,
    1,
  ),
);
process.exit(0);
