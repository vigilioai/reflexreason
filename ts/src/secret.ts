// Comparing a secret with === stops at the first byte that differs, and the
// time that takes tells a patient caller how much of a guess was right.
import { timingSafeEqual } from "node:crypto";

export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
