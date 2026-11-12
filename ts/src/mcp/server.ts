// kube-ops: the only door between agents and the cluster, served over MCP
// (Streamable HTTP, stateless). Read tools return evidence. Write tools are
// the three reversible actions, each behind the same four checks: namespace
// allowlist, per-workload action budget, memory ceiling, and shadow mode
// (server-side dry run). RBAC in the cluster repeats the allowlist a level
// below, so a bug here still cannot delete anything. With MCP_WRITE_TOKEN
// set, the write tools are only registered for callers that present it.
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "../config.js";
import * as ops from "../kube/ops.js";
import { sameSecret } from "../secret.js";

const spent = new Map<string, number[]>();

function guard(namespace: string, workload: string): void {
  if (!config.allowedNamespaces.includes(namespace))
    throw new Error(`namespace ${namespace} is not on the allowlist`);
  const cutoff = Date.now() - config.actionWindowSec * 1000;
  const recent = (spent.get(`${namespace}/${workload}`) ?? []).filter(
    (t) => t > cutoff,
  );
  if (recent.length >= config.actionBudget) {
    throw new Error(
      `action budget exhausted for ${workload}: ` +
        `${recent.length} actions in ${config.actionWindowSec}s`,
    );
  }
  spent.set(`${namespace}/${workload}`, [...recent, Date.now()]);
}

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
const where = { namespace: z.string().describe("Kubernetes namespace") };
const target = {
  ...where,
  deployment: z.string().describe("Deployment name"),
  fingerprint: z
    .string()
    .describe("Incident fingerprint, recorded in the audit annotation"),
  dry_run: z
    .boolean()
    .default(false)
    .describe("Validate on the server without changing anything"),
};

export function buildServer(mayWrite = true): McpServer {
  const server = new McpServer({ name: "kube-ops", version: "1.0.0" });

  server.registerTool(
    "list_unhealthy",
    {
      description:
        "List workloads whose pods Kubernetes reports as failing, one entry per workload.",
      inputSchema: where,
    },
    async ({ namespace }) => text(await ops.listUnhealthy(namespace)),
  );

  server.registerTool(
    "list_healthy",
    {
      description:
        "List running pods that Kubernetes considers healthy, for log anomaly scans.",
      inputSchema: where,
    },
    async ({ namespace }) => text(await ops.listHealthy(namespace)),
  );

  server.registerTool(
    "describe_incident",
    {
      description:
        "Collect status, warning events, rollout history and the log tail for one pod.",
      inputSchema: {
        ...where,
        pod: z.string(),
        reason_hint: z.string().default(""),
      },
    },
    async ({ namespace, pod, reason_hint }) =>
      text(await ops.describe(namespace, pod, reason_hint)),
  );

  server.registerTool(
    "pod_logs",
    {
      description:
        "Tail a pod log. Set previous=true for the container instance before the last restart.",
      inputSchema: {
        ...where,
        pod: z.string(),
        tail: z.number().int().max(500).default(100),
        previous: z.boolean().default(false),
      },
    },
    async ({ namespace, pod, tail, previous }) =>
      text({ log: await ops.podLogs(namespace, pod, tail, previous) }),
  );

  server.registerTool(
    "rollout_history",
    {
      description:
        "Revision count and seconds since the last rollout of a deployment.",
      inputSchema: { ...where, deployment: z.string() },
    },
    async ({ namespace, deployment }) => {
      const h = await ops.rolloutHistory(namespace, deployment);
      return text({
        revision: h.revision,
        revisions: h.revisions,
        secondsSinceRollout: h.secondsSinceRollout,
      });
    },
  );

  server.registerTool(
    "rollout_status",
    {
      description:
        "Whether every replica of a deployment runs the current spec and is available.",
      inputSchema: { ...where, deployment: z.string() },
    },
    async ({ namespace, deployment }) =>
      text(await ops.rolloutStatus(namespace, deployment)),
  );

  // Everything below changes state. A caller without the operator token
  // gets a server on which these tools do not exist.
  if (!mayWrite) return server;

  server.registerTool(
    "acquire_lease",
    {
      description:
        "Claim exclusive handling of one workload for ttl_sec seconds.",
      inputSchema: {
        key: z.string(),
        holder: z.string(),
        ttl_sec: z.number().int().default(120),
      },
    },
    async ({ key, holder, ttl_sec }) =>
      text(await ops.acquireLease(key, holder, ttl_sec)),
  );

  const write = (
    name: string,
    description: string,
    extra: Record<string, z.ZodTypeAny>,
    run: (a: any, dryRun: boolean) => Promise<string>,
  ): void => {
    server.registerTool(
      name,
      { description, inputSchema: { ...target, ...extra } },
      async (a: any) => {
        guard(a.namespace, a.deployment);
        const dryRun = a.dry_run || config.shadow;
        const result = await run(a, dryRun);
        if (!dryRun)
          await ops.annotate(a.namespace, a.deployment, {
            action: name,
            fingerprint: a.fingerprint,
            at: new Date().toISOString(),
          });
        return text({ ok: true, dryRun, result });
      },
    );
  };
  write(
    "rollout_undo",
    "Return a deployment to its previous revision.",
    {},
    (a, d) => ops.rolloutUndo(a.namespace, a.deployment, d),
  );
  write(
    "rollout_restart",
    "Restart a deployment's pods without changing its spec.",
    {},
    (a, d) => ops.rolloutRestart(a.namespace, a.deployment, d),
  );
  write(
    "set_memory_limit",
    "Set the memory limit of a deployment, at most " +
      `${config.maxMemoryMi}Mi.`,
    { memory_mi: z.number().int().positive() },
    (a, d) => {
      if (a.memory_mi > config.maxMemoryMi)
        throw new Error(
          `${a.memory_mi}Mi is above the ${config.maxMemoryMi}Mi ceiling`,
        );
      return ops.setMemoryLimit(a.namespace, a.deployment, a.memory_mi, d);
    },
  );
  return server;
}

export function serve(port: number): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    // Stateless: a fresh server and transport per request, nothing to leak
    // between callers and nothing to lose on restart.
    const given = req.headers.authorization ?? "";
    const mayWrite =
      !config.mcpWriteToken ||
      sameSecret(given, `Bearer ${config.mcpWriteToken}`);
    const server = buildServer(mayWrite);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  }).listen(port);
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("mcp-server.mjs")
) {
  if (process.argv.includes("--load-only")) process.exit(0);
  const port = Number(process.env.PORT ?? 7001);
  serve(port);
  const writes = config.mcpWriteToken ? "token" : "open";
  console.error(
    `kube-ops MCP on :${port}/mcp, shadow=${config.shadow}, writes=${writes}`,
  );
}
