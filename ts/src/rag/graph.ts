// The retrieval agent as a LangGraph state machine:
//
//   retrieve -> grade -> (matched) compose -> END
//                     -> (no match)           END
//
// retrieve: vector search, filtered by the symptom Kubernetes reported.
// grade:    the decision model chooses among the candidates or "none".
// compose:  attach the remediation section of the chosen runbook.
//
// No text is generated anywhere in this graph. The answer is a runbook id,
// an action name taken from the runbook's own metadata, and a probability.
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ask, type Answer } from "../systemone.js";
import { LocalEmbeddings } from "./embed.js";
import { search, type Chunk, type Hit } from "./store.js";

export interface Candidate {
  id: string;
  title: string;
  match: string;
  action: string;
  maxMemoryFactor: number;
  similarity: number;
}
export interface RagResult {
  runbook: Candidate | null;
  probability: number;
  /**
   * How the runbook was chosen: structural, model+retrieval (both agree),
   * model, or none.
   */
  via: string;
  candidates: Candidate[];
  remediation: string;
  ms: { embed: number; search: number; grade: number };
}

const State = Annotation.Root({
  query: Annotation<string>,
  symptom: Annotation<string>,
  candidates: Annotation<Candidate[]>,
  picked: Annotation<Candidate | null>,
  probability: Annotation<number>,
  via: Annotation<string>,
  remediation: Annotation<string>,
  ms: Annotation<{ embed: number; search: number; grade: number }>,
});
type S = typeof State.State;

const embeddings = new LocalEmbeddings();
const MAX_CANDIDATES = Number(process.env.RAG_CANDIDATES ?? 3);

/** Best chunk per runbook, then the top few runbooks. */
export function toCandidates(hits: Hit[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const { chunk, similarity } of hits) {
    if (!best.has(chunk.id)) {
      best.set(chunk.id, {
        id: chunk.id,
        title: chunk.title,
        match: chunk.match,
        action: chunk.action,
        maxMemoryFactor: chunk.maxMemoryFactor,
        similarity: Number(similarity.toFixed(4)),
      });
    }
  }
  return [...best.values()].slice(0, MAX_CANDIDATES);
}

async function retrieve(s: S): Promise<Partial<S>> {
  const t0 = performance.now();
  const vector = await embeddings.embedQuery(s.query);
  const t1 = performance.now();
  const hits = await search(
    vector,
    embeddings,
    12,
    "runbook",
    s.symptom || undefined,
  );
  return {
    candidates: toCandidates(hits),
    ms: { embed: t1 - t0, search: performance.now() - t1, grade: 0 },
  };
}

async function grade(s: S): Promise<Partial<S>> {
  if (s.candidates.length === 0)
    return { picked: null, probability: 0, via: "none" };
  // One runbook is filed under this symptom. Kubernetes already named the
  // fault in a status field; a model can only add doubt to a fact.
  if (s.symptom && s.candidates.length === 1)
    return { picked: s.candidates[0]!, probability: 1, via: "structural" };
  const t0 = performance.now();
  const criteria: Record<string, string> = {};
  for (const c of s.candidates) criteria[c.id] = c.match;
  criteria.none = "None of these";
  const answers = await ask(s.query, {
    runbook: {
      type: "choice",
      instructions: "Which runbook matches this incident?",
      criteria,
    },
  });
  const a = answers.runbook as Extract<Answer, { type: "choice" }>;
  const picked = s.candidates.find((c) => c.id === a.choice) ?? null;
  return {
    picked,
    // Two independent readers: the embedding ranked the candidates, the
    // decision model chose one. `via` records whether they agree.
    via:
      picked && picked.id === s.candidates[0]?.id
        ? "model+retrieval"
        : "model",
    probability: picked ? (a.probabilities[picked.id] ?? 0) : 0,
    ms: { ...s.ms, grade: performance.now() - t0 },
  };
}

async function compose(s: S): Promise<Partial<S>> {
  const vector = await embeddings.embedQuery(
    `${s.picked!.title} remediate`,
  );
  const hits = await search(vector, embeddings, 40, "runbook");
  const section = hits.find(
    (h: Hit) =>
      h.chunk.id === s.picked!.id && /remediate/i.test(h.chunk.section),
  );
  return { remediation: section?.chunk.text ?? "" };
}

export const ragGraph = new StateGraph(State)
  .addNode("retrieve", retrieve)
  .addNode("grade", grade)
  .addNode("compose", compose)
  .addEdge(START, "retrieve")
  .addEdge("retrieve", "grade")
  .addConditionalEdges("grade", (s: S) => (s.picked ? "compose" : END), [
    "compose",
    END,
  ])
  .addEdge("compose", END)
  .compile();

export async function findRunbook(
  query: string,
  symptom: string,
): Promise<RagResult> {
  const out = await ragGraph.invoke({ query, symptom });
  return {
    runbook: out.picked ?? null,
    probability: Number((out.probability ?? 0).toFixed(4)),
    via: out.via ?? "none",
    candidates: out.candidates ?? [],
    remediation: out.remediation ?? "",
    ms: {
      embed: Math.round(out.ms.embed),
      search: Math.round(out.ms.search),
      grade: Math.round(out.ms.grade),
    },
  };
}

/**
 * Background reading for the reason agent: plain top-k over documentation.
 */
export async function searchDocs(
  query: string,
  k = 4,
): Promise<Pick<Chunk, "title" | "section" | "text">[]> {
  const hits = await search(
    await embeddings.embedQuery(query),
    embeddings,
    k,
    "doc",
  );
  return hits.map((h: Hit) => ({
    title: h.chunk.title,
    section: h.chunk.section,
    text: h.chunk.text,
  }));
}
