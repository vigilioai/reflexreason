// Client for the System One wire format (POST /v1/systemone) that Jev
// defined and that open implementations such as Von serve. One state, any
// number of typed questions, probabilities back. No text is generated.
import { config } from "./config.js";

export type Question =
  | {
      type: "noul";
      instructions: string;
      criteria?: { pos?: string; neg?: string };
    }
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string | null>;
    }
  | {
      type: "score";
      instructions: string;
      criteria: string[] | Record<string, string>;
    };

export type Answer =
  | { type: "noul"; noul: number; noul_raw?: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      score: number;
      confidence: number;
      probabilities: Record<string, number>;
    };

export interface SystemOneReply {
  model: string;
  answers: Record<string, Answer>;
}

export const stats = { calls: 0, questions: 0, ms: 0 };

export async function ask(
  state: string,
  questions: Record<string, Question>,
  baseUrl: string = config.systemOneUrl,
): Promise<Record<string, Answer>> {
  const started = performance.now();
  const res = await fetch(`${baseUrl}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, questions }),
  });
  if (!res.ok)
    throw new Error(
      `systemone ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  const reply = (await res.json()) as SystemOneReply;
  stats.calls += 1;
  stats.questions += Object.keys(questions).length;
  stats.ms += performance.now() - started;
  return reply.answers;
}

/**
 * Probability of yes for a noul answer, of the winner for a choice answer.
 */
export function probability(a: Answer | undefined): number {
  if (!a) return 0;
  if (a.type === "noul") return a.noul_raw ?? a.noul;
  return a.confidence;
}

export function choiceOf(a: Answer | undefined): string {
  return a && a.type === "choice" ? a.choice : "";
}
