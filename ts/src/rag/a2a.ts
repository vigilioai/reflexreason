// The retrieval graph, published as an A2A agent. Any A2A client can
// discover it at /.well-known/agent-card.json and send it a message; this
// project's reflex agents and the ADK reason agent both do.
import { randomUUID } from "node:crypto";
import express from "express";
import type { AgentCard, Message } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { A2AExpressApp } from "@a2a-js/sdk/server/express";
import {
  assertSafeToListen,
  listenHost,
  requireToken,
} from "../a2a/auth.js";
import { findRunbook, searchDocs } from "./graph.js";

class RunbookExecutor implements AgentExecutor {
  async execute(
    ctx: RequestContext,
    bus: ExecutionEventBus,
  ): Promise<void> {
    const text = ctx.userMessage.parts
      .map((p) => (p.kind === "text" ? p.text : ""))
      .join("\n")
      .trim();
    // Agents in this project send {query, symptom, mode}; an LLM sends
    // prose.
    let request: { query: string; symptom?: string; mode?: string } = {
      query: text,
    };
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.query === "string") request = parsed;
    } catch {
      /* prose is fine */
    }
    const result =
      request.mode === "docs"
        ? await searchDocs(request.query)
        : await findRunbook(request.query, request.symptom ?? "");
    const reply: Message = {
      kind: "message",
      messageId: randomUUID(),
      role: "agent",
      contextId: ctx.contextId,
      parts: [{ kind: "text", text: JSON.stringify(result) }],
    };
    bus.publish(reply);
    bus.finished();
  }
  async cancelTask(): Promise<void> {
    /* a lookup finishes before it could be cancelled */
  }
}

export function serveRag(
  port: number,
  publicUrl = `http://127.0.0.1:${port}/`,
): ReturnType<express.Application["listen"]> {
  const card: AgentCard = {
    name: "runbook_rag",
    description:
      "Finds the runbook that matches an incident description and " +
      "returns its remediation and action. Can also search Kubernetes " +
      "documentation.",
    url: publicUrl,
    version: "1.0.0",
    protocolVersion: "0.3.0",
    capabilities: { streaming: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "find_runbook",
        name: "Find runbook",
        description:
          "Match incident evidence to one runbook, or report that none " +
          "applies.",
        tags: ["rag", "runbook", "incident"],
      },
    ],
  };
  const handler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new RunbookExecutor(),
  );
  assertSafeToListen();
  const app = express();
  app.use(requireToken);
  app.get("/healthz", (_req, res) => {
    res.send("ok");
  });
  new A2AExpressApp(handler).setupRoutes(app);
  return app.listen(port, listenHost);
}

if (
  process.argv[1]?.endsWith("rag-server.mjs") ||
  process.argv[1]?.endsWith("rag/a2a.js")
) {
  if (process.argv.includes("--load-only")) process.exit(0);
  const port = Number(process.env.PORT ?? 7002);
  serveRag(port, process.env.PUBLIC_URL);
  console.error(`runbook_rag A2A agent on :${port}`);
}
