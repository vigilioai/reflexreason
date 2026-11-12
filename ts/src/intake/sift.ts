// TypeScript twin of rust/crates/sift. Same algorithm, same output bytes.
// scripts/check-twins.sh diffs the two on every fixture.
import type { Distilled, Template } from "../types.js";

const LEVEL3 = /fatal|panic|oom|killed|segfault/i;
const LEVEL2 = /error|exception|refused|timeout|timed out|denied|failed/i;
const LEVEL1 = /warn|gap|stale|retry|backoff/i;
// The five ASCII whitespace bytes Rust's split_ascii_whitespace uses.
const SPACE = /[ \t\n\f\r]+/;
const TRIM = /^[ \t\n\f\r]+|[ \t\n\f\r]+$/g;
const DIGIT = /[0-9]/;

export function level(pattern: string): number {
  if (LEVEL3.test(pattern)) return 3;
  if (LEVEL2.test(pattern)) return 2;
  if (LEVEL1.test(pattern)) return 1;
  return 0;
}

export function mask(line: string): string {
  let out = "";
  for (const tok of line.split(SPACE)) {
    if (tok === "") continue;
    if (out !== "") out += " ";
    if (!DIGIT.test(tok)) {
      out += tok;
      continue;
    }
    const eq = tok.indexOf("=");
    out +=
      eq > 0 && !DIGIT.test(tok.slice(0, eq))
        ? tok.slice(0, eq + 1) + "<*>"
        : "<*>";
  }
  return out;
}

export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

const clip = (s: string, max: number): string =>
  s.length <= max ? s : Array.from(s).slice(0, max).join("");

interface Slot {
  pattern: string;
  count: number;
  level: number;
  first: number;
  sample: string;
}

export function distill(
  log: string,
  topK = 8,
): { lines: number; templates: Template[] } {
  const index = new Map<string, Slot>();
  let lines = 0;
  for (const raw of log.split("\n")) {
    const pattern = mask(raw);
    if (pattern === "") continue;
    const slot = index.get(pattern);
    if (slot) slot.count += 1;
    else
      index.set(pattern, {
        pattern,
        count: 1,
        level: level(pattern),
        first: lines,
        sample: raw.replace(TRIM, ""),
      });
    lines += 1;
  }
  const ranked = [...index.values()].sort(
    (a, b) => b.level - a.level || b.count - a.count || a.first - b.first,
  );
  const templates = ranked.slice(0, topK).map((s) => ({
    pattern: s.pattern,
    count: s.count,
    level: s.level,
    sample: clip(s.sample, 240),
  }));
  return { lines, templates };
}

export interface IntakeEvent {
  namespace: string;
  workload: string;
  reason: string;
  log: string;
  top_k?: number;
}

export function intake(ev: IntakeEvent): Distilled {
  const d = distill(ev.log, ev.top_k ?? 8);
  const top = d.templates[0]?.pattern ?? "";
  return {
    fingerprint: fnv1a64(
      `${ev.namespace}/${ev.workload}/${ev.reason}/${top}`,
    ),
    key: `${ev.namespace}/${ev.workload}`,
    lines: d.lines,
    bytes: Buffer.byteLength(ev.log),
    templates: d.templates,
  };
}
