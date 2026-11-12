// One MCP session shared by every agent in the process.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../config.js";

let session: Promise<Client> | undefined;

function connect(): Promise<Client> {
  session ??= (async () => {
    const client = new Client({ name: "reflex-swarm", version: "1.0.0" });
    const headers: Record<string, string> = {};
    if (config.mcpWriteToken)
      headers.authorization = `Bearer ${config.mcpWriteToken}`;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
        requestInit: { headers },
      }),
    );
    return client;
  })();
  return session;
}

/**
 * Call a tool and parse its JSON text result. A tool error becomes an
 * exception.
 */
export async function tool<T = any>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const client = await connect();
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: { type: string; text?: string }[];
  };
  const body = res.content?.find((c) => c.type === "text")?.text ?? "null";
  if (res.isError) throw new Error(`${name}: ${body}`);
  return JSON.parse(body) as T;
}

export async function closeMcp(): Promise<void> {
  if (session) {
    await (await session).close();
    session = undefined;
  }
}
