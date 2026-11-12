// Does chunking matter? Index the same runbooks five ways and ask which
// runbook the nearest chunk belongs to, for every labelled incident. No
// symptom filter here: retrieval has to find the runbook from the text
// alone.
//   node bench-chunking.mjs ../runbooks ../fixtures/decisions.jsonl > bench/results/chunking.json
import { readFileSync } from "node:fs";
import { LocalEmbeddings } from "../rag/embed.js";
import {
  chunkRunbooks,
  loadRunbooks,
  type ChunkOptions,
} from "../rag/ingest.js";

const [dir = "../runbooks", fixture = "../fixtures/decisions.jsonl"] =
  process.argv.slice(2);
const cases = readFileSync(fixture, "utf8")
  .trim()
  .split("\n")
  .map(
    (l) => JSON.parse(l) as { kind: string; expect: string; state: string },
  )
  .filter((c) => c.kind === "known");
const embeddings = new LocalEmbeddings();
const queries = await embeddings.embedDocuments(cases.map((c) => c.state));
const runbooks = loadRunbooks(dir);

const variants: [string, ChunkOptions][] = [
  [
    "whole runbook as one chunk",
    { chunkSize: 100000, chunkOverlap: 0, header: false, bySection: false },
  ],
  [
    "fixed 200 characters",
    { chunkSize: 200, chunkOverlap: 20, header: false, bySection: false },
  ],
  [
    "fixed 600 characters",
    { chunkSize: 600, chunkOverlap: 80, header: false, bySection: false },
  ],
  [
    "one chunk per section",
    { chunkSize: 600, chunkOverlap: 80, header: false, bySection: true },
  ],
  [
    "per section + title and match line",
    { chunkSize: 600, chunkOverlap: 80, header: true, bySection: true },
  ],
];
const rows = [];
for (const [name, options] of variants) {
  const chunks = await chunkRunbooks(runbooks, options);
  const t0 = performance.now();
  const vectors = await embeddings.embedDocuments(
    chunks.map((c) => c.text),
  );
  const embedMs = performance.now() - t0;
  let hit1 = 0,
    hit3 = 0;
  cases.forEach((c, qi) => {
    const q = queries[qi] ?? [];
    const ranked = chunks
      .map((chunk, i) => ({
        id: chunk.id,
        sim: (vectors[i] ?? []).reduce((s, v, j) => s + v * (q[j] ?? 0), 0),
      }))
      .sort((a, b) => b.sim - a.sim);
    const order = [...new Set(ranked.map((r) => r.id))];
    if (order[0] === c.expect) hit1 += 1;
    if (order.slice(0, 3).includes(c.expect)) hit3 += 1;
  });
  rows.push({
    variant: name,
    chunks: chunks.length,
    mean_chars: Math.round(
      chunks.reduce((n, c) => n + c.text.length, 0) / chunks.length,
    ),
    hit_at_1: hit1,
    hit_at_3: hit3,
    of: cases.length,
    embed_ms: Math.round(embedMs),
  });
}
console.log(
  JSON.stringify(
    {
      model: "Xenova/all-MiniLM-L6-v2 (q8, CPU)",
      runbooks: runbooks.length,
      rows,
    },
    null,
    1,
  ),
);
