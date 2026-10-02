/**
 * Every LDNOOBW-imported rule must be able to match its own term (mirrors pythanity's
 * test_language_coverage.py).
 *
 * Rules are matched against *normalized* text (accents stripped, Cyrillic transliterated,
 * Hangul decomposed, ...), so a rule built from an unfolded term can silently never fire.
 * For each imported rule we rebuild its canonical spelling from the rule itself (first
 * alternative of every token) and check the rule catches it after normalization. Only
 * per-language failure counts are reported — never the terms.
 */
import { expect, it } from "vitest";

import { Filter } from "../src/filter.js";
import { all } from "../src/languages.js";
import { parseRules } from "../src/rules.js";

const SEP = "[ ._-]*";
const TOKEN = /^(?:\[(.)[^\]]*\]|\\(.)|(.))\+$/su;

function canonicalSample(pattern: string): string | null {
  if (!pattern.startsWith("\\b") || !pattern.endsWith("\\b")) return null;
  let out = "";
  for (const tok of pattern.slice(2, -2).split(SEP)) {
    const m = TOKEN.exec(tok);
    if (!m) return null;
    out += m[1] ?? m[2] ?? m[3];
  }
  return out;
}

it("every imported rule matches its own term", () => {
  const failures: Record<string, string> = {};
  for (const lang of all) {
    let total = 0;
    let bad = 0;
    for (const line of lang.rules) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const sample = canonicalSample(line.slice(0, tab).trim().slice(1, -1));
      if (sample === null) continue;
      total++;
      if (new Filter(parseRules([line])).find(sample).length === 0) bad++;
    }
    if (bad) failures[lang.code] = `${bad}/${total}`;
  }
  expect(failures).toEqual({});
}, 60_000);
