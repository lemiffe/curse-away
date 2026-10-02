/**
 * Throughput benchmark for chat-style traffic: many small messages, some 30–40 words,
 * ~10% containing profanity. Prints only timings — never message content.
 *
 *   pnpm bench                 # mask() over a mixed message stream
 *   pnpm bench --op find       # or: mask | maskFull | safeSubstitute | dropProfanity | containsProfanity
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { getFilter } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPORA = join(ROOT, "tests", "corpora");

/** Deterministic PRNG so every run uses the same message stream. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

export function buildMessages(count: number, seed = 42): string[] {
  const words = readFileSync(join(CORPORA, "story_large_en.txt"), "utf8").split(/\s+/).filter(Boolean);
  const dirty = Buffer.from(readFileSync(join(CORPORA, "dirty_en_enc.txt"), "utf8"), "base64")
    .toString("utf8").split(/\s+/).filter(Boolean);
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const long = rand() < 0.2; // 20% are 30–40 words, the rest 2–10
    const n = long ? 30 + Math.floor(rand() * 11) : 2 + Math.floor(rand() * 9);
    const start = Math.floor(rand() * (words.length - n));
    const msg = words.slice(start, start + n);
    if (rand() < 0.1) msg.splice(Math.floor(rand() * msg.length), 0, pick(dirty));
    out.push(msg.join(" "));
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function main(argv: string[]): void {
  const opIdx = argv.indexOf("--op");
  const op = (opIdx >= 0 ? argv[opIdx + 1] : "mask") as
    "find" | "mask" | "maskFull" | "safeSubstitute" | "dropProfanity" | "containsProfanity";
  const messages = buildMessages(20_000);

  let t = performance.now();
  const f = getFilter("en");
  const build = performance.now() - t;
  t = performance.now();
  f[op](messages[0]!);
  const first = performance.now() - t;
  for (const m of messages.slice(0, 2_000)) f[op](m); // warm-up (V8 regex tier-up)

  const lat: number[] = [];
  const t0 = performance.now();
  for (const m of messages) {
    const s = performance.now();
    f[op](m);
    lat.push(performance.now() - s);
  }
  const total = performance.now() - t0;
  lat.sort((a, b) => a - b);
  const us = (ms: number) => `${(ms * 1000).toFixed(1)} µs`;
  console.log(`op=${op}  messages=${messages.length}  avg words=` +
    (messages.reduce((a, m) => a + m.split(" ").length, 0) / messages.length).toFixed(1));
  console.log(`build filter ${build.toFixed(1)} ms | first call ${first.toFixed(1)} ms`);
  console.log(`throughput   ${Math.round(messages.length / (total / 1000)).toLocaleString()} msg/s`);
  console.log(`latency      p50 ${us(percentile(lat, 0.5))}  p90 ${us(percentile(lat, 0.9))}  ` +
    `p99 ${us(percentile(lat, 0.99))}  max ${us(lat.at(-1)!)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
