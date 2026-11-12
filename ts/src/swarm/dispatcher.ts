// The swarm: find every sick workload, give each one its own reflex agent,
// run them in parallel, and make sure no workload has two agents.
//
//   node swarm.mjs --once      one sweep, print a JSON line per incident
//   node swarm.mjs --watch     sweep every SWEEP_SEC seconds until stopped
import { hostname } from "node:os";
import { config } from "../config.js";
import { closeMcp, tool } from "../mcp/client.js";
import {
  handleIncident,
  logLooksSick,
  type Target,
} from "../reflex/agent.js";
import type { IncidentRecord } from "../types.js";

const HOLDER = `${hostname()}-${process.pid}`;
const DEDUP_SEC = Number(process.env.DEDUP_SEC ?? 300);
const settled = new Map<string, number>();
/**
 * Forget which incidents were escalated; used between evaluation scenarios.
 */
export const forget = (): void => settled.clear();

/** Failing pods, plus healthy-looking pods whose log is mostly warnings. */
export async function detect(namespace: string): Promise<Target[]> {
  const [sick, healthy] = await Promise.all([
    tool<Target[]>("list_unhealthy", { namespace }),
    tool<Target[]>("list_healthy", { namespace }),
  ]);
  const taken = new Set(sick.map((s) => s.workload));
  const quiet = healthy.filter((h) => !taken.has(h.workload));
  const logs = await Promise.all(
    quiet.map((h) =>
      tool<{ log: string }>("pod_logs", {
        namespace,
        pod: h.pod,
        tail: 40,
      }),
    ),
  );
  const anomalies = quiet.filter(
    (h, i) =>
      logLooksSick(logs[i]?.log ?? "") &&
      !taken.has(h.workload) &&
      taken.add(h.workload),
  );
  return [...sick, ...anomalies];
}

/** Run `task` over `items` with at most `limit` in flight. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

export async function sweep(
  namespace: string = config.watchNamespace,
): Promise<IncidentRecord[]> {
  const now = Date.now();
  const targets = (await detect(namespace)).filter((t) => {
    // An incident that was escalated stays escalated; do not page twice.
    const at = settled.get(`${t.workload}/${t.reason}`);
    return !at || now - at > DEDUP_SEC * 1000;
  });
  const records = await pool(
    targets,
    config.swarmConcurrency,
    async (t) => {
      const key = `${t.namespace}/${t.workload}`;
      const lease = await tool<{ acquired: boolean; holder: string }>(
        "acquire_lease",
        { key, holder: HOLDER, ttl_sec: config.verifyTimeoutSec + 30 },
      );
      if (!lease.acquired) return null;
      const record = await handleIncident(t);
      if (!record.recovered)
        settled.set(`${t.workload}/${t.reason}`, Date.now());
      return record;
    },
  );
  return records.filter((r): r is IncidentRecord => r !== null);
}

export function summarise(r: IncidentRecord): string {
  const outcome = r.executed
    ? r.recovered
      ? "recovered"
      : "NOT recovered"
    : `escalated to ${r.escalatedTo}`;
  return (
    `${r.workload.padEnd(14)} ${r.reason.padEnd(17)} ${(r.runbook ?? "-").padEnd(16)} p=${r.runbookProbability.toFixed(2)} ` +
    `inj=${r.injectionProbability.toFixed(2)} ${r.action.padEnd(15)} ${outcome} (${r.ms.total}ms)`
  );
}

if (
  process.argv[1]?.endsWith("swarm.mjs") ||
  process.argv[1]?.endsWith("dispatcher.js")
) {
  if (process.argv.includes("--load-only")) process.exit(0);
  const watch = process.argv.includes("--watch");
  const everySec = Number(process.env.SWEEP_SEC ?? 5);
  do {
    const records = await sweep();
    for (const r of records) {
      console.error(summarise(r));
      console.log(JSON.stringify(r));
    }
    if (watch) await new Promise((r) => setTimeout(r, everySec * 1000));
  } while (watch);
  await closeMcp();
}
