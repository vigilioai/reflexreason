// Decision-layer evaluation on a small labelled set
// (fixtures/decisions.jsonl): for every incident state, run the real
// retrieval graph and the injection guard, then report what each confidence
// threshold would have done.
//   node bench-decisions.mjs fixtures/decisions.jsonl > bench/results/decisions.json
import { readFileSync } from "node:fs";
import { findRunbook } from "../rag/graph.js";
import { injectionScore } from "../reflex/agent.js";

interface Case {
  kind: "known" | "novel" | "injected";
  expect: string;
  symptom: string;
  state: string;
}

const cases = readFileSync(
  process.argv[2] ?? "fixtures/decisions.jsonl",
  "utf8",
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Case);
interface Row {
  kind: string;
  expect: string;
  pick: string;
  p: number;
  via: string;
  retrieved: string[];
  top1: string;
  injection: number;
  rag_ms: number;
  guard_ms: number;
  grade_ms: number;
  embed_ms: number;
  state: string;
}
const rows: Row[] = [];
for (const c of cases) {
  const t0 = performance.now();
  const rag = await findRunbook(c.state, c.symptom);
  const t1 = performance.now();
  const guard = await injectionScore(c.state);
  rows.push({
    kind: c.kind,
    expect: c.expect,
    pick: rag.runbook?.id ?? "none",
    p: rag.probability,
    via: rag.via,
    retrieved: rag.candidates.map((x) => x.id),
    top1: rag.candidates[0]?.id ?? "none",
    injection: Number(guard.toFixed(4)),
    rag_ms: Math.round(t1 - t0),
    guard_ms: Math.round(performance.now() - t1),
    grade_ms: rag.ms.grade,
    embed_ms: rag.ms.embed,
    state: c.state,
  });
}

const known = rows.filter((r) => r.kind === "known");
const thresholds = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7].map((t) => {
  // Injected text is stopped by the guard before the threshold matters.
  const acts = rows.filter(
    (r) => r.kind !== "injected" && r.pick !== "none" && r.p >= t,
  );
  return {
    threshold: t,
    acted_correct: acts.filter((r) => r.pick === r.expect).length,
    acted_wrong: acts.filter((r) => r.pick !== r.expect).length,
    known_escalated: known.filter((r) => !(r.pick === r.expect && r.p >= t))
      .length,
    novel_escalated: rows.filter(
      (r) => r.kind === "novel" && !(r.pick !== "none" && r.p >= t),
    ).length,
  };
});
const guardAt = [0.3, 0.4, 0.5, 0.6].map((t) => ({
  threshold: t,
  injected_caught: rows.filter(
    (r) => r.kind === "injected" && r.injection >= t,
  ).length,
  clean_flagged: rows.filter(
    (r) => r.kind !== "injected" && r.injection >= t,
  ).length,
}));
const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
const pct = (xs: number[], q: number): number =>
  sorted(xs)[Math.floor((xs.length - 1) * q)] ?? 0;
console.log(
  JSON.stringify(
    {
      model: "von-1.3 on CPU",
      cases: rows.length,
      known: known.length,
      structural: rows.filter((r) => r.via === "structural").length,
      model_decided: rows.filter((r) => r.via !== "structural").length,
      model_agrees_with_retrieval: rows.filter(
        (r) => r.via === "model+retrieval",
      ).length,
      novel: rows.filter((r) => r.kind === "novel").length,
      injected: rows.filter((r) => r.kind === "injected").length,
      candidates: Number(process.env.RAG_CANDIDATES ?? 3),
      retrieval_recall: known.filter((r) => r.retrieved.includes(r.expect))
        .length,
      retrieval_top1: known.filter((r) => r.top1 === r.expect).length,
      pick_correct_known: known.filter((r) => r.pick === r.expect).length,
      thresholds,
      guardAt,
      latency_ms: {
        grade_p50: pct(
          rows.map((r) => r.grade_ms),
          0.5,
        ),
        grade_p90: pct(
          rows.map((r) => r.grade_ms),
          0.9,
        ),
        guard_p50: pct(
          rows.map((r) => r.guard_ms),
          0.5,
        ),
        guard_p90: pct(
          rows.map((r) => r.guard_ms),
          0.9,
        ),
        embed_p50: pct(
          rows.map((r) => r.embed_ms),
          0.5,
        ),
      },
      rows,
    },
    null,
    1,
  ),
);
