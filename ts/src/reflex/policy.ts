// The model says what it sees. This table says what may be done about it.
// Every branch that executes names an allowlisted action and its
// precondition; everything else escalates. No model output is ever used as
// an action name.
import { config } from "../config.js";
import type { Action, Evidence } from "../types.js";
import type { RagResult } from "../rag/graph.js";

export interface Verdict {
  action: Action;
  execute: boolean;
  escalateTo: "none" | "reason" | "human";
  memoryMi?: number;
  why: string;
}

const human = (why: string): Verdict => ({
  action: "escalate",
  execute: false,
  escalateTo: "human",
  why,
});

export function decide(
  e: Evidence,
  rag: RagResult,
  injection: number,
): Verdict {
  // Text that tries to give orders is hostile input. It is not acted on,
  // and it is not forwarded to a language model, which is the component it
  // targets.
  if (injection >= config.injectionThreshold) {
    const got = injection.toFixed(2);
    return human(
      `log text reads as instructions (p=${got}); evidence is untrusted`,
    );
  }
  const rb = rag.runbook;
  if (!rb || rag.probability < config.classThreshold) {
    const got = rag.probability.toFixed(2);
    const floor = config.classThreshold;
    const why = rb
      ? `best runbook ${rb.id} at p=${got} is under ${floor}`
      : "no runbook matches";
    return {
      action: "escalate",
      execute: false,
      escalateTo: "reason",
      why,
    };
  }
  const p = `${rb.id} p=${rag.probability.toFixed(2)}`;
  switch (rb.action) {
    case "rollout_undo":
      if (e.revisions < 2)
        return human(
          `${p} says roll back, but there is no earlier revision`,
        );
      return {
        action: "rollout_undo",
        execute: true,
        escalateTo: "none",
        why: p,
      };
    case "rollout_restart":
      return {
        action: "rollout_restart",
        execute: true,
        escalateTo: "none",
        why: p,
      };
    case "raise_memory": {
      const current = e.memoryLimitMi;
      if (!current)
        return human(
          `${p} says raise memory, but the container has no limit to raise`,
        );
      const cap = config.maxMemoryMi;
      const wanted = Math.round(current * (rb.maxMemoryFactor || 2));
      const next = Math.min(wanted, cap);
      if (next <= current)
        return human(
          `${p}: limit ${current}Mi is already at the ${cap}Mi ceiling`,
        );
      return {
        action: "raise_memory",
        execute: true,
        escalateTo: "none",
        memoryMi: next,
        why: `${p}, ${current}Mi -> ${next}Mi`,
      };
    }
    default:
      return human(`${p}: the runbook requires a person`);
  }
}
