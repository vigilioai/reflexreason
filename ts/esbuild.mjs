// Bundle each entry point into one file under dist/bundle. A bundle starts
// faster than a node_modules tree because Node resolves and reads one file
// instead of hundreds; bench/coldstart measures the difference.
import { build } from "esbuild";

const entries = {
  "intake-cli": "src/intake/cli.ts",
  "intake-lambda": "src/intake/lambda.ts",
  "mcp-server": "src/mcp/server.ts",
  "rag-server": "src/rag/a2a.ts",
  ingest: "src/rag/ingest.ts",
  swarm: "src/swarm/dispatcher.ts",
  "reason-server": "src/reason/agent.ts",
  "mock-llm": "src/mock/llm.ts",
  "mock-systemone": "src/mock/systemone.ts",
  eval: "src/eval/run.ts",
  "bench-decisions": "src/bench/decisions.ts",
  "bench-swarm-mem": "src/bench/swarm-mem.ts",
  "bench-chunking": "src/bench/chunking.ts",
  "mock-mcp": "src/mock/mcp.ts",
};

await build({
  entryPoints: entries,
  outdir: "dist/bundle",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: process.env.MINIFY !== "0",
  legalComments: "none",
  // Native addons and their loaders cannot be inlined; they stay in
  // node_modules.
  external: ["@huggingface/transformers", "onnxruntime-node", "sharp"],
  // Some dependencies still call require(); give the ESM bundle one.
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
  logLevel: "warning",
});
