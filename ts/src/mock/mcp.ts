// A cluster-free MCP server with the same tool names as kube-ops and canned
// answers. It exists for the swarm scaling test, where the question is how
// much memory N agents need, not how Kubernetes behaves.
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const LOG = Array.from(
  { length: 200 },
  (_, i) =>
    `08:59:${String(i % 60).padStart(2, "0")} md tick seq=${i} sym=TXF px=${17250 + (i % 7)}`,
)
  .concat("09:00:00 FATAL config: FEED_URL is empty")
  .join("\n");
const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
const any = {
  namespace: z.string().optional(),
  pod: z.string().optional(),
  deployment: z.string().optional(),
};

function build(): McpServer {
  const s = new McpServer({ name: "kube-ops-mock", version: "1.0.0" });
  s.registerTool(
    "describe_incident",
    {
      description: "canned evidence",
      inputSchema: { ...any, reason_hint: z.string().optional() },
    },
    async ({ namespace, pod }) =>
      text({
        namespace,
        workload: String(pod).replace(/-pod$/, ""),
        pod,
        phase: "Running",
        ready: false,
        reason: "CrashLoopBackOff",
        lastTerminated: "Error exit 2",
        exitCode: 2,
        restarts: 4,
        image: "busybox:1.36",
        memoryLimitMi: 32,
        revision: 2,
        revisions: 2,
        secondsSinceRollout: 40,
        events: ["BackOff: Back-off restarting failed container"],
        log: LOG,
      }),
  );
  s.registerTool(
    "acquire_lease",
    {
      description: "always granted",
      inputSchema: {
        key: z.string(),
        holder: z.string(),
        ttl_sec: z.number().optional(),
      },
    },
    async ({ holder }) => text({ acquired: true, holder }),
  );
  s.registerTool(
    "rollout_undo",
    {
      description: "no-op",
      inputSchema: { ...any, fingerprint: z.string().optional() },
    },
    async () => text({ ok: true, dryRun: false, result: "mock" }),
  );
  s.registerTool(
    "rollout_status",
    { description: "always done", inputSchema: any },
    async () => text({ done: true, ready: 1, want: 1 }),
  );
  s.registerTool(
    "list_unhealthy",
    { description: "nothing is sick", inputSchema: any },
    async () => text([]),
  );
  return s;
}

export function serveMockMcp(
  port: number,
): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const server = build();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }).listen(port);
}

if (process.argv[1]?.endsWith("mock-mcp.mjs")) {
  serveMockMcp(Number(process.env.PORT ?? 7001));
  console.error("mock MCP up");
}
