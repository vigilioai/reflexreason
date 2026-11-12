// ADK for TypeScript ships Gemini models only. This adapter lets an ADK
// agent talk to any OpenAI-compatible endpoint, which is what vLLM (and the
// gateway in front of it) serves. It translates in both directions:
//
//   ADK Content / functionCall / functionResponse  <->  chat messages / tool_calls / tool results
//   ADK FunctionDeclaration (Gemini schema)        ->   OpenAI tool (JSON Schema)
import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import type { Content, Part } from "@google/genai";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

/**
 * Gemini writes schema types in upper case ("OBJECT"); JSON Schema wants
 * lower case.
 */
function toJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema))
    out[k] =
      k === "type" && typeof v === "string"
        ? v.toLowerCase()
        : toJsonSchema(v);
  return out;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value && typeof value === "object") {
    const v = value as { text?: string; parts?: Part[] };
    if (typeof v.text === "string") return v.text;
    if (v.parts) return v.parts.map((p) => p.text ?? "").join("\n");
  }
  return "";
}

export function toMessages(req: LlmRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const system = textOf(req.config?.systemInstruction);
  if (system) messages.push({ role: "system", content: system });
  let serial = 0;
  const pending = new Map<string, string[]>();
  for (const content of req.contents as Content[]) {
    const parts = content.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    const results = parts.filter((p) => p.functionResponse);
    const text = parts.map((p) => p.text ?? "").join("");
    if (calls.length > 0) {
      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: calls.map((p) => {
          // Keep the id the model gave; if a server omitted it, pair call
          // and result by tool name and order instead.
          const id = p.functionCall!.id ?? `call_${serial++}`;
          const name = p.functionCall!.name ?? "";
          pending.set(name, [...(pending.get(name) ?? []), id]);
          return {
            id,
            type: "function" as const,
            function: {
              name,
              arguments: JSON.stringify(p.functionCall!.args ?? {}),
            },
          };
        }),
      });
    } else if (results.length > 0) {
      for (const p of results) {
        const name = p.functionResponse!.name ?? "";
        const id =
          p.functionResponse!.id ??
          pending.get(name)?.shift() ??
          `call_${serial++}`;
        messages.push({
          role: "tool",
          tool_call_id: id,
          content: JSON.stringify(p.functionResponse!.response ?? {}),
        });
      }
    } else if (text) {
      messages.push({
        role: content.role === "model" ? "assistant" : "user",
        content: text,
      });
    }
  }
  return messages;
}

export function toTools(req: LlmRequest): unknown[] | undefined {
  const tools: unknown[] = [];
  for (const tool of (req.config?.tools ?? []) as {
    functionDeclarations?: any[];
  }[]) {
    for (const fn of tool.functionDeclarations ?? []) {
      tools.push({
        type: "function",
        function: {
          name: fn.name,
          description: fn.description ?? "",
          parameters:
            fn.parametersJsonSchema ??
            toJsonSchema(
              fn.parameters ?? { type: "object", properties: {} },
            ),
        },
      });
    }
  }
  return tools.length > 0 ? tools : undefined;
}

export function toLlmResponse(json: any): LlmResponse {
  const message = json.choices?.[0]?.message ?? {};
  const parts: Part[] = [];
  if (message.content) parts.push({ text: message.content });
  for (const call of message.tool_calls ?? []) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function?.arguments || "{}");
    } catch {
      /* a malformed call reaches the tool as {} and fails there, visibly */
    }
    parts.push({
      functionCall: { id: call.id, name: call.function?.name, args },
    });
  }
  return {
    content: { role: "model", parts },
    turnComplete: true,
    usageMetadata: json.usage && {
      promptTokenCount: json.usage.prompt_tokens,
      candidatesTokenCount: json.usage.completion_tokens,
      totalTokenCount: json.usage.total_tokens,
    },
  };
}

export class OpenAiCompatLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [/.*/];

  constructor(
    private readonly options: {
      model: string;
      baseUrl: string;
      apiKey?: string;
      sessionId?: string;
    },
  ) {
    super({ model: options.model });
  }

  override async *generateContentAsync(
    req: LlmRequest,
    _stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.options.apiKey)
      headers.authorization = `Bearer ${this.options.apiKey}`;
    if (this.options.sessionId)
      headers["x-session-id"] = this.options.sessionId;
    const res = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: abortSignal,
      // Temperature 0: a triage answer should not change between two
      // identical requests, and only greedy requests are cacheable at the
      // gateway.
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: toMessages(req),
        tools: toTools(req),
      }),
    });
    if (!res.ok) {
      yield {
        errorCode: String(res.status),
        errorMessage: (await res.text()).slice(0, 400),
        turnComplete: true,
      };
      return;
    }
    yield toLlmResponse(await res.json());
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error(
      "live (bidirectional) sessions are not supported by this adapter",
    );
  }
}
