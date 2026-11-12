// Same command line as the Rust binary: event on stdin, result on stdout,
// `--bench N` to time N warm runs.
import { readFileSync } from "node:fs";
import { intake, type IntakeEvent } from "./sift.js";

const ev = JSON.parse(readFileSync(0, "utf8")) as IntakeEvent;
if (process.argv[2] === "--bench") {
  const n = Number(process.argv[3] ?? 200);
  const samples: number[] = [];
  let sink = 0;
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    sink += JSON.stringify(intake(ev)).length;
    samples.push(Number(process.hrtime.bigint() - t));
  }
  samples.sort((a, b) => a - b);
  const at = (q: number): number =>
    samples[Math.floor((samples.length - 1) * q)] ?? 0;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const bytes = Buffer.byteLength(ev.log);
  console.log(
    JSON.stringify({
      impl: "typescript",
      runs: n,
      bytes,
      p50_ns: at(0.5),
      p99_ns: at(0.99),
      mean_ns: Math.round(mean),
      mb_per_s: Number((bytes / 1e6 / (mean / 1e9)).toFixed(1)),
      sink,
    }),
  );
} else {
  process.stdout.write(JSON.stringify(intake(ev)) + "\n");
}
