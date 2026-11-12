// A scripted stand-in for vLLM. It speaks the OpenAI chat-completions
// format and walks a fixed plan: load the skill, read the log, read the
// rollout history, ask the retrieval agent, then answer. It reasons about
// nothing. Its purpose is to prove the plumbing (ADK adapter, skills, MCP,
// A2A) on a machine without a GPU, and to give the gateway a countable
// upstream.
import { createServer } from "node:http";

const delayMs = Number(process.env.MOCK_LLM_DELAY_MS ?? 0);
export const seen = { requests: 0, calls: [] as string[] };

function next(body: any): Record<string, unknown> {
  const messages: any[] = body.messages ?? [];
  const offered = new Set<string>(
    (body.tools ?? []).map((t: any) => t.function?.name),
  );
  const done = messages.filter((m) => m.role === "tool").length;
  const user = String(
    messages.find((m) => m.role === "user")?.content ?? "",
  );
  const where = /Incident on ([\w-]+)\/([\w-]+), pod ([\w-]+)/.exec(user);
  const plan: [string, Record<string, unknown>][] = [
    ["load_skill", { name: "k8s-incident-triage" }],
    [
      "pod_logs",
      { namespace: where?.[1], pod: where?.[3], tail: 20, previous: true },
    ],
    ["rollout_history", { namespace: where?.[1], deployment: where?.[2] }],
    ["runbook_rag", { request: user.slice(0, 300) }],
  ];
  const steps = plan.filter(([name]) => offered.has(name));
  const step = steps[done];
  if (step) {
    seen.calls.push(step[0]);
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call_${done}`,
          type: "function",
          function: { name: step[0], arguments: JSON.stringify(step[1]) },
        },
      ],
    };
  }
  const lastTool = String(
    [...messages].reverse().find((m) => m.role === "tool")?.content ?? "",
  ).slice(0, 160);
  return {
    role: "assistant",
    content:
      "DIAGNOSIS: scripted reply; the mock model does not reason.\n" +
      `EVIDENCE: ${done} tool results were returned to the model, the last one began: ${lastTool}\n` +
      "RECOMMENDED ACTION: page the owning team.\nCONFIDENCE: low; replace the mock with vLLM for a real diagnosis.",
  };
}

export function serveMockLlm(
  port: number,
): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    const json = (code: number, value: unknown): void => {
      res
        .writeHead(code, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    };
    if (req.url === "/stats") return json(200, seen);
    if (req.url === "/v1/models")
      return json(200, {
        object: "list",
        data: [{ id: "mock-llm", object: "model" }],
      });
    if (req.url !== "/v1/chat/completions" || req.method !== "POST")
      return json(404, { error: "not found" });
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      seen.requests += 1;
      const body = JSON.parse(raw);
      const message = next(body);
      const promptTokens = Math.ceil(raw.length / 4);
      setTimeout(
        () =>
          json(200, {
            id: `mock-${seen.requests}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: body.model ?? "mock-llm",
            choices: [
              {
                index: 0,
                message,
                finish_reason: message.tool_calls ? "tool_calls" : "stop",
              },
            ],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: 24,
              total_tokens: promptTokens + 24,
            },
            // `mock_delay_ms` in the body overrides the default delay for
            // one request; the gateway benchmark uses it to make identical
            // requests overlap.
          }),
        Number(body.mock_delay_ms ?? delayMs),
      );
    });
  }).listen(port);
}

if (
  process.argv[1]?.endsWith("mock-llm.mjs") ||
  process.argv[1]?.endsWith("mock/llm.js")
) {
  const port = Number(process.env.PORT ?? 8000);
  serveMockLlm(port);
  console.error(`mock LLM on :${port} (scripted, ${delayMs}ms per reply)`);
}
