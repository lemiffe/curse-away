// The prefilter and result cache are pure optimisations: results must be identical to a
// plain scan of every rule. Only counts / offsets are compared — no text is printed.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildMessages } from "../scripts/bench.js";
import { Filter } from "../src/filter.js";
import { all } from "../src/languages.js";
import { buildPrefilter, candidateRules } from "../src/prefilter.js";
import { parseLines, parseRules } from "../src/rules.js";
import en from "../src/data/en.js";

const CORPORA = join(import.meta.dirname, "corpora");
const read = (n: string) => readFileSync(join(CORPORA, n), "utf8");
const spans = (f: Filter, t: string) => f.find(t).map((m) => `${m.start}:${m.end}:${m.safe}`);

function filters(langs: typeof en[]) {
  const rules = langs.flatMap((l) => parseRules(l.rules));
  const exceptions = langs.flatMap((l) => parseLines(l.exceptions));
  return {
    fast: new Filter(rules, { exceptions }),
    plain: new Filter(rules, { exceptions, prefilter: false, cacheSize: 0 }),
  };
}

describe("prefilter exactness", () => {
  const texts = [
    ...buildMessages(5_000, 7),
    ...read("story_large_en.txt").split(/\n\n/),
    Buffer.from(read("dirty_en_enc.txt"), "base64").toString("utf8"),
    "Café 😀 naïve ж", "", "a", "isn't it",
  ];

  it.each([
    ["en", [en]],
    ["all languages", [en, ...all]],
  ] as const)("matches a plain scan of every rule (%s)", (name, langs) => {
    const { fast, plain } = filters([...langs]);
    // The plain scan over every language is slow, so sample fewer messages there.
    const sample = name === "en" ? texts : texts.filter((_, i) => i % 10 === 0 || i >= 5_000);
    let differing = 0;
    for (const t of sample) if (spans(fast, t).join() !== spans(plain, t).join()) differing++;
    expect(differing).toBe(0);
  }, 120_000);

  it("returns the same (copied) results from the cache", () => {
    const { fast } = filters([en]);
    const t = Buffer.from(read("dirty_en_enc.txt"), "base64").toString("utf8").slice(0, 200);
    const first = fast.find(t);
    first.length = 0; // mutating a returned array must not corrupt the cache
    expect(fast.find(t).length).toBeGreaterThan(0);
  });
});

describe("buildPrefilter", () => {
  it("never skips a rule that matches (unit)", () => {
    const rules = parseRules(["/fooz/\ta", "/b[a4]rz/\tb", "~/quxx/\tc", "/(?<=x)yyy/\td"])
      .map(([rx]) => rx);
    const pre = buildPrefilter(rules, 2);
    expect(candidateRules(pre, "nothing here", rules.length)).toEqual([]);
    expect(candidateRules(pre, "a b4rz", rules.length)).toEqual([0, 1]); // its bucket
    expect(candidateRules(pre, "aquxxa xyyy", rules.length)).toEqual([2, 3]);
  });

  it("relaxes 'term embedded in a word' rules (\\w*X) without missing matches", () => {
    const rules = parseRules([String.raw`/\w*fooz\w*/` + "\tx", "/barz/\ty", "/quxx/\tz",
      "/a1/\tq", "/b2/\tq", "/c3/\tq", "/d4/\tq", "/e5/\tq", "/f6/\tq"]).map(([rx]) => rx);
    const pre = buildPrefilter(rules, 2);
    for (const t of ["xfoozy", "fooz", "a_fooz_b", "uberfoozing!"]) {
      expect(candidateRules(pre, t, rules.length)).toContain(0);
    }
    expect(candidateRules(pre, "nothing to see", rules.length)).toEqual([]);
  });

  it("always scans rules with back-references or named groups", () => {
    const rules = [/(a)\1/giu, /(?<n>b)\k<n>/giu, /c/giu];
    expect(buildPrefilter(rules).always).toEqual([0, 1]);
  });

  it("keeps rules with different flags in separate buckets", () => {
    const pre = buildPrefilter([/a/giu, /b/g, /c/giu]);
    expect(pre.top).toBeNull();
    expect(pre.buckets.map((b) => b.members)).toEqual([[0, 2], [1]]);
    expect(candidateRules(pre, "B", 3)).toEqual([]); // /b/ is case-sensitive
  });
});
