// Ingestion: read runbooks, split them, embed the pieces, store them.
//   node ingest.mjs [runbook-dir] [--chunk 600] [--overlap 80] [--no-header] [--fixed] [--k8s-docs]
// --k8s-docs also fetches a pinned list of Kubernetes documentation pages
// (CC BY 4.0) as background reading for the reason agent.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { LocalEmbeddings } from "./embed.js";
import { saveIndex, type Chunk } from "./store.js";

export interface Runbook {
  id: string;
  title: string;
  symptoms: string[];
  match: string;
  action: string;
  maxMemoryFactor: number;
  body: string;
}

/** Front matter is `key: value` lines; a value in brackets is a list. */
export function parseRunbook(markdown: string): Runbook {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(markdown);
  if (!m) throw new Error("runbook without front matter");
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const list = (v = ""): string[] =>
    v
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    id: meta.id ?? "",
    title: meta.title ?? "",
    symptoms: list(meta.symptoms),
    match: meta.match ?? "",
    action: meta.action ?? "escalate",
    maxMemoryFactor: Number(meta.max_memory_factor ?? 0),
    body: (m[2] ?? "").trim(),
  };
}

export function loadRunbooks(dir: string): Runbook[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseRunbook(readFileSync(join(dir, f), "utf8")));
}

export interface ChunkOptions {
  chunkSize: number;
  chunkOverlap: number;
  header: boolean;
  bySection: boolean;
}

/**
 * A runbook is written in sections, and a section is the unit a reader
 * wants back: "Remediate" whole, not the tail of "Why" glued to the head of
 * "Remediate". So split on the section headings first and only cut inside a
 * section that is longer than chunkSize. With `header`, each chunk starts
 * with the runbook's title and match line, because a "Verify" section alone
 * says nothing about which fault it belongs to.
 */
export async function chunkRunbooks(
  runbooks: Runbook[],
  o: ChunkOptions,
): Promise<Chunk[]> {
  const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
    chunkSize: o.chunkSize,
    chunkOverlap: o.chunkOverlap,
  });
  const chunks: Chunk[] = [];
  for (const rb of runbooks) {
    const sections = o.bySection ? rb.body.split(/\n(?=## )/) : [rb.body];
    for (const part of sections) {
      for (const piece of await splitter.splitText(part)) {
        const section =
          /^##\s+(.+)$/m.exec(piece)?.[1] ??
          /^##\s+(.+)$/m.exec(part)?.[1] ??
          "";
        chunks.push({
          text: o.header ? `${rb.title}. ${rb.match}\n${piece}` : piece,
          kind: "runbook",
          id: rb.id,
          title: rb.title,
          section,
          symptoms: rb.symptoms,
          match: rb.match,
          action: rb.action,
          maxMemoryFactor: rb.maxMemoryFactor,
        });
      }
    }
  }
  return chunks;
}

const K8S_REF = "release-1.32";
const K8S_PAGES = [
  "tasks/debug/debug-application/debug-pods.md",
  "tasks/debug/debug-application/debug-running-pod.md",
  "tasks/debug/debug-application/determine-reason-pod-failure.md",
  "tasks/configure-pod-container/configure-liveness-readiness-startup-probes.md",
  "concepts/workloads/pods/pod-lifecycle.md",
  "concepts/configuration/manage-resources-containers.md",
  "concepts/containers/images.md",
  "concepts/workloads/controllers/deployment.md",
  "concepts/scheduling-eviction/assign-pod-node.md",
];

async function k8sDocs(o: ChunkOptions): Promise<Chunk[]> {
  const splitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
    chunkSize: o.chunkSize,
    chunkOverlap: o.chunkOverlap,
  });
  const chunks: Chunk[] = [];
  for (const page of K8S_PAGES) {
    const url = `https://raw.githubusercontent.com/kubernetes/website/${K8S_REF}/content/en/docs/${page}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`skip ${page}: ${res.status}`);
      continue;
    }
    const body = (await res.text())
      .replace(/^---\n[\s\S]*?\n---\n/, "")
      .replace(/\{\{[<%][\s\S]*?[>%]\}\}/g, "");
    const title = page.split("/").pop()!.replace(/\.md$/, "");
    for (const piece of await splitter.splitText(body)) {
      chunks.push({
        text: piece,
        kind: "doc",
        id: title,
        title,
        section: url,
        symptoms: [],
        match: "",
        action: "",
        maxMemoryFactor: 0,
      });
    }
  }
  return chunks;
}

export async function ingest(
  dir: string,
  o: ChunkOptions,
  withDocs: boolean,
): Promise<Record<string, number | string>> {
  const t0 = performance.now();
  const chunks = await chunkRunbooks(loadRunbooks(dir), o);
  if (withDocs) chunks.push(...(await k8sDocs(o)));
  const t1 = performance.now();
  const embeddings = new LocalEmbeddings();
  const vectors = await embeddings.embedDocuments(
    chunks.map((c) => c.text),
  );
  const t2 = performance.now();
  const where = await saveIndex(chunks, vectors, embeddings);
  return {
    chunks: chunks.length,
    runbook_chunks: chunks.filter((c) => c.kind === "runbook").length,
    chars: chunks.reduce((n, c) => n + c.text.length, 0),
    dims: vectors[0]?.length ?? 0,
    chunk_ms: Math.round(t1 - t0),
    embed_ms: Math.round(t2 - t1),
    store_ms: Math.round(performance.now() - t2),
    where,
  };
}

if (
  process.argv[1]?.endsWith("ingest.mjs") ||
  process.argv[1]?.endsWith("ingest.js")
) {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: number): number => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : fallback;
  };
  const dir =
    args.find(
      (a, i) =>
        !a.startsWith("--") &&
        !args[i - 1]?.startsWith("--c") &&
        !args[i - 1]?.startsWith("--o"),
    ) ?? "../runbooks";
  const report = await ingest(
    dir,
    {
      chunkSize: flag("--chunk", 600),
      chunkOverlap: flag("--overlap", 80),
      header: !args.includes("--no-header"),
      bySection: !args.includes("--fixed"),
    },
    args.includes("--k8s-docs"),
  );
  console.log(JSON.stringify(report));
}
