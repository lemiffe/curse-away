/**
 * Corpus tests (mirror pythanity's test_false_positives / test_clean_story / test_dirty_corpus).
 *
 * - Clean corpora: every word is clean, so any match is a false positive. Only the matched
 *   (clean) story text is reported; rule patterns are never printed.
 * - Dirty corpus: stored base64-encoded (tests/corpora/dirty_en_enc.txt) so the raw content
 *   is never exposed in the repo or in test output. It is decoded in memory only; after a
 *   full mask no letter or digit may survive.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Filter } from "../src/filter.js";
import { getFilter, maskFull } from "../src/index.js";

const CORPORA = join(import.meta.dirname, "corpora");
const read = (name: string) => readFileSync(join(CORPORA, name), "utf8");

describe("false positives on short clean phrases", () => {
  const corpus = read("clean_en.txt").split(/\r?\n/).filter(Boolean);
  // Obfuscation-tolerant separators MUST sit inside word boundaries.
  const anchored = /\b[t7]+[ _.-]*[i1e]+[ _.-]*[t7]+[ _.-]*s*\b/i;
  const unanchored = /[t7]+[ _.-]*[i1e]+[ _.-]*[t7]+[ _.-]*s*/i;

  it("an anchored rule has no false positives", () => {
    const f = new Filter([[anchored, "bits"]]);
    const hits = corpus.filter((line) => f.containsProfanity(line));
    expect(hits).toEqual([]);
  });

  it("the same rule unanchored bridges words (why the guard matters)", () => {
    expect(new Filter([[unanchored, "bits"]]).containsProfanity("i finally got it done")).toBe(true);
  });
});

describe.each(["story_en.txt", "story_large_en.txt"])("clean story %s", (name) => {
  const story = read(name);

  it("has no false positives", () => {
    const hits = [...new Set(getFilter("en").find(story).map((m) => m.text))].sort();
    expect(hits, `${hits.length} false positive(s) in ${name}`).toEqual([]);
  });

  it("is unchanged by every transform", () => {
    const f = getFilter("en");
    for (const t of ["mask", "maskFull", "safeSubstitute", "dropProfanity"] as const) {
      expect(f[t](story) === story, `${t} altered ${name}`).toBe(true);
    }
  });
});

describe("dirty corpus", () => {
  it("is fully masked", () => {
    const encoded = read("dirty_en_enc.txt");
    const masked = maskFull(Buffer.from(encoded, "base64").toString("utf8"), "en");
    // Expect only mask stars, whitespace and punctuation to remain — no letters/digits.
    const leftover = [...new Set([...masked].filter((ch) => /[\p{L}\p{N}]/u.test(ch)))].sort();
    expect(leftover.length, `${leftover.length} un-masked char(s) survived: ${leftover.join("")}`)
      .toBe(0);
    expect(masked.includes("*")).toBe(true);
  });
});
