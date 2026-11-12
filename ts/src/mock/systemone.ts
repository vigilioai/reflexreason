// A rule-based stand-in for the decision model, for unit tests and for load
// tests where the model's own latency would hide what is being measured.
// It is word overlap and one regular expression. It is not a model, and no
// number it produces appears in the tutorial as a model result.
import { createServer } from "node:http";

const delayMs = Number(process.env.MOCK_S1_DELAY_MS ?? 0);
const ORDERS =
  /ignore (all )?(previous|prior) instructions|system override|delete (the )?namespace|you are an ai|as an ai agent/i;
const stems = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 4)
      .map((w) => w.slice(0, 5)),
  );

export function answer(state: string, q: any): unknown {
  if (q.type === "noul") {
    const p = ORDERS.test(state) ? 0.92 : 0.08;
    return { type: "noul", noul: p, noul_raw: p };
  }
  const have = stems(state);
  const scored = Object.entries(q.criteria as Record<string, string | null>)
    .filter(([id]) => id !== "none")
    .map(([id, text]) => ({
      id,
      hits: [...stems(`${id} ${text ?? ""}`)].filter((s) => have.has(s))
        .length,
    }))
    .sort((a, b) => b.hits - a.hits);
  const ids = Object.keys(q.criteria);
  const best = scored[0];
  const winner =
    best && best.hits >= 2
      ? best.id
      : ids.includes("none")
        ? "none"
        : (best?.id ?? "");
  const top = winner === "none" ? 0.7 : 0.8;
  const rest = ids.length > 1 ? (1 - top) / (ids.length - 1) : 0;
  const probabilities = Object.fromEntries(
    ids.map((id) => [id, id === winner ? top : rest]),
  );
  return { type: "choice", choice: winner, probabilities, confidence: top };
}

export function serveMockSystemOne(
  port: number,
): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end('{"status":"ok"}');
      return;
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const answers = Object.fromEntries(
        Object.entries(body.questions ?? {}).map(([name, q]) => [
          name,
          answer(String(body.state ?? ""), q),
        ]),
      );
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            model: "mock-rules",
            answers,
            usage: { input_tokens: 0, output_tokens: 0 },
          }),
        );
      }, delayMs);
    });
  }).listen(port);
}

if (
  process.argv[1]?.endsWith("mock-systemone.mjs") ||
  process.argv[1]?.endsWith("mock/systemone.js")
) {
  const port = Number(process.env.PORT ?? 8100);
  serveMockSystemOne(port);
  console.error(`mock decision server on :${port} (rules, not a model)`);
}
