// Turn evidence into the one short paragraph the decision model reads.
// Measured on Von 1.3: a long key-value dump of every field gave
// near-uniform probabilities, while symptom + one event + the top log lines
// gave a clear winner. Say only what distinguishes one fault from another.
import type { Distilled, Evidence } from "../types.js";

/** The symptom name runbooks are filed under. */
export function symptomKey(e: Evidence): string {
  return e.lastTerminated.startsWith("OOMKilled") ? "OOMKilled" : e.reason;
}

function headline(e: Evidence): string {
  switch (e.reason) {
    case "NotReady":
      return "Running but not Ready";
    case "Unschedulable":
      return "Pending, Unschedulable";
    // Measured: prefixing "Running and Ready" pulled log-only incidents
    // toward the wrong runbook. The log is the evidence here, so it stands
    // alone.
    case "LogAnomaly":
      return "";
    case "CrashLoopBackOff":
    case "Error":
    case "OOMKilled":
      if (
        e.reason !== "OOMKilled" &&
        e.lastTerminated.startsWith("OOMKilled")
      )
        return `${e.reason}, last termination ${e.lastTerminated}`;
      return e.exitCode === null
        ? e.reason
        : `${e.reason}, exit ${e.exitCode}`;
    default:
      return e.reason;
  }
}

// For these symptoms the event text is the evidence. For a crash or an OOM
// kill the evidence is the log, and events only add restart noise.
const EVENT_IS_EVIDENCE = new Set([
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "Unschedulable",
  "NotReady",
  "CreateContainerConfigError",
]);
const EVENT_OF_INTEREST =
  /^(Failed|FailedScheduling|Unhealthy|FailedMount|FailedCreate)/;

export function renderState(e: Evidence, d: Distilled): string {
  const parts = [headline(e)].filter(Boolean);
  const event = [...e.events]
    .reverse()
    .find((x) => EVENT_OF_INTEREST.test(x));
  if (event && EVENT_IS_EVIDENCE.has(e.reason))
    parts.push(`Event: ${event.replace(/^\w+: /, "").slice(0, 180)}`);
  const loud = d.templates.filter((t) => t.level >= 1).slice(0, 3);
  const lines = (loud.length > 0 ? loud : d.templates.slice(0, 1)).map(
    (t) => {
      const times = t.count > 1 ? `${t.count}x ` : "";
      return times + stripClock(t.sample).slice(0, 220);
    },
  );
  if (lines.length > 0) parts.push(`Log: ${lines.join("; ")}`);
  return parts.join(". ");
}

const stripClock = (line: string): string =>
  line.replace(/^\d{2}:\d{2}:\d{2}(\.\d+)?\s+/, "");

/**
 * The lines an attacker would have to write on: prose that is not a normal
 * log line shows up as a rare template with no severity keyword. Those go
 * first, then the loud lines, three in all. The guard reads exactly this.
 * Measured: one injected line among five ordinary ones scored 0.46, alone
 * or next to one other line it scored 0.70 or more, so the text is kept
 * short.
 */
export function guardText(d: Distilled): string {
  const rare = d.templates.filter((t) => t.level === 0 && t.count <= 2);
  const loud = d.templates.filter((t) => t.level >= 1);
  return [...rare, ...loud]
    .slice(0, 3)
    .map((t) => stripClock(t.sample).slice(0, 220))
    .join("\n");
}
