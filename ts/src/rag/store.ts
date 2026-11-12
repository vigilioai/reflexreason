// Two vector stores behind one search function. Qdrant when QDRANT_URL is
// set (the cluster deployment); otherwise a JSON file of normalised vectors
// scanned in memory, which is exact and fast enough for a few thousand
// chunks.
import { readFileSync, writeFileSync } from "node:fs";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { config } from "../config.js";

export interface Chunk {
  text: string;
  kind: "runbook" | "doc";
  id: string;
  title: string;
  section: string;
  symptoms: string[];
  match: string;
  action: string;
  maxMemoryFactor: number;
}
export interface Hit {
  chunk: Chunk;
  similarity: number;
}
interface IndexFile {
  model: string;
  chunks: Chunk[];
  vectors: number[][];
}

const COLLECTION = "runbooks";
const INDEX_PATH = process.env.INDEX_PATH ?? "index.json";
let memory: IndexFile | undefined;

export async function saveIndex(
  chunks: Chunk[],
  vectors: number[][],
  embeddings: EmbeddingsInterface,
): Promise<string> {
  if (config.qdrantUrl) {
    const { QdrantVectorStore } = await import("@langchain/qdrant");
    await fetch(`${config.qdrantUrl}/collections/${COLLECTION}`, {
      method: "DELETE",
    });
    const store = await QdrantVectorStore.fromExistingCollection(
      embeddings,
      { url: config.qdrantUrl, collectionName: COLLECTION },
    );
    await store.addVectors(
      vectors,
      chunks.map((c) => ({
        pageContent: c.text,
        metadata: { ...c, text: undefined },
      })),
    );
    return `qdrant:${COLLECTION}`;
  }
  writeFileSync(
    INDEX_PATH,
    JSON.stringify({
      model: config.embedModel,
      chunks,
      vectors,
    } satisfies IndexFile),
  );
  memory = undefined;
  return INDEX_PATH;
}

/** Nearest chunks of one kind, optionally only those listing `symptom`. */
export async function search(
  queryVector: number[],
  embeddings: EmbeddingsInterface,
  k: number,
  kind: Chunk["kind"],
  symptom?: string,
): Promise<Hit[]> {
  if (config.qdrantUrl) {
    const { QdrantVectorStore } = await import("@langchain/qdrant");
    const store = await QdrantVectorStore.fromExistingCollection(
      embeddings,
      { url: config.qdrantUrl, collectionName: COLLECTION },
    );
    const must: { key: string; match: Record<string, unknown> }[] = [
      { key: "metadata.kind", match: { value: kind } },
    ];
    if (symptom)
      must.push({ key: "metadata.symptoms", match: { any: [symptom] } });
    const found = await store.similaritySearchVectorWithScore(
      queryVector,
      k,
      { must },
    );
    return found.map(([doc, score]) => ({
      chunk: { ...(doc.metadata as Chunk), text: doc.pageContent },
      similarity: score,
    }));
  }
  memory ??= JSON.parse(readFileSync(INDEX_PATH, "utf8")) as IndexFile;
  const hits: Hit[] = [];
  memory.chunks.forEach((chunk, i) => {
    if (
      chunk.kind !== kind ||
      (symptom && !chunk.symptoms.includes(symptom))
    )
      return;
    const v = memory!.vectors[i] ?? [];
    let dot = 0;
    for (let j = 0; j < v.length; j++)
      dot += (v[j] ?? 0) * (queryVector[j] ?? 0);
    hits.push({ chunk, similarity: dot });
  });
  return hits.sort((a, b) => b.similarity - a.similarity).slice(0, k);
}
