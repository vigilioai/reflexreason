// Ask another agent over A2A and read its reply as JSON or text. Works
// against both servers in this project: the LangGraph retrieval agent,
// which answers with a Message, and the ADK reason agent, which answers
// with a Task.
import { randomUUID } from "node:crypto";
import type { Client } from "@a2a-js/sdk/client";
import { clientFactory } from "./auth.js";

const clients = new Map<string, Promise<Client>>();

export async function a2aText(
  baseUrl: string,
  text: string,
): Promise<string> {
  let client = clients.get(baseUrl);
  if (!client) {
    client = clientFactory().createFromUrl(baseUrl);
    clients.set(baseUrl, client);
  }
  const reply: any = await (
    await client
  ).sendMessage({
    message: {
      kind: "message",
      messageId: randomUUID(),
      role: "user",
      parts: [{ kind: "text", text }],
    },
  });
  const parts: any[] =
    reply.kind === "message"
      ? reply.parts
      : [
          ...(reply.artifacts ?? []).flatMap((a: any) => a.parts ?? []),
          ...(reply.status?.message?.parts ?? []),
        ];
  return parts
    .filter((p) => p.kind === "text")
    .map((p) => p.text)
    .join("\n");
}

export async function a2aJson<T>(
  baseUrl: string,
  payload: unknown,
): Promise<T> {
  return JSON.parse(await a2aText(baseUrl, JSON.stringify(payload))) as T;
}
