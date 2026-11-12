// One place for every knob. All of them are environment variables so the
// same bundle runs on a laptop, in a pod and in a Lambda function.
const env = (name: string, fallback: string): string =>
  process.env[name] ?? fallback;
const num = (name: string, fallback: number): number =>
  Number(process.env[name] ?? fallback);

export const config = {
  // Kubernetes API. Local: `kubectl proxy --port 8001`. In a pod: the
  // service URL, with KUBE_TOKEN_FILE and NODE_EXTRA_CA_CERTS pointing at
  // the mounted service-account files.
  kubeApi: env("KUBE_API", "http://127.0.0.1:8001"),
  kubeTokenFile: env("KUBE_TOKEN_FILE", ""),
  watchNamespace: env("WATCH_NAMESPACE", "trading"),
  leaseNamespace: env("LEASE_NAMESPACE", "oncall"),

  mcpUrl: env("MCP_URL", "http://127.0.0.1:7001/mcp"),
  ragUrl: env("RAG_URL", "http://127.0.0.1:7002"),
  reasonUrl: env("REASON_URL", ""),
  systemOneUrl: env("SYSTEMONE_URL", "http://127.0.0.1:8100"),
  llmBaseUrl: env("LLM_BASE_URL", "http://127.0.0.1:8080/v1"),
  llmModel: env("LLM_MODEL", "Qwen/Qwen3.5-4B"),
  qdrantUrl: env("QDRANT_URL", ""),
  embedModel: env("EMBED_MODEL", "Xenova/all-MiniLM-L6-v2"),

  // Callers that present this token see the write tools of the MCP server;
  // everyone else sees the read tools only. Empty means no check, which is
  // the local default.
  mcpWriteToken: env("MCP_WRITE_TOKEN", ""),

  // Guard rails enforced by the MCP server, independent of what any agent
  // asks.
  allowedNamespaces: env("ALLOWED_NAMESPACES", "trading").split(","),
  maxMemoryMi: num("MAX_MEMORY_MI", 256),
  actionBudget: num("ACTION_BUDGET", 3),
  actionWindowSec: num("ACTION_WINDOW_SEC", 600),

  // Reflex policy. Both thresholds were read off
  // bench/results/decisions.json: 0.45 is the lowest value with no wrong
  // action on the labelled set, 0.60 separates every injected line from
  // every clean one. Refit on your own data.
  classThreshold: num("CLASS_THRESHOLD", 0.45),
  injectionThreshold: num("INJECTION_THRESHOLD", 0.6),
  shadow: env("SHADOW", "0") === "1",
  swarmConcurrency: num("SWARM_CONCURRENCY", 16),
  verifyTimeoutSec: num("VERIFY_TIMEOUT_SEC", 90),
};
