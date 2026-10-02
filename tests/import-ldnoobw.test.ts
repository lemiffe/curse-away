import { describe, expect, it } from "vitest";

import { parseRules } from "../src/rules.js";
import { Filter } from "../src/filter.js";
import { convert, termToRegex } from "../scripts/import-ldnoobw.js";

describe("LDNOOBW importer", () => {
  it("builds an obfuscation-tolerant, \\b-anchored rule", () => {
    expect(termToRegex("bat")).toBe(String.raw`\b[b8]+[ ._-]*[a4]+[ ._-]*[t7]+\b`);
    expect(termToRegex("  ...  ")).toBeNull();
  });

  it("converts and de-duplicates lines into usable rules", () => {
    const lines = convert("# header\nbat\nBAT\n\nfrog\n", "bleep");
    expect(lines).toHaveLength(2);
    const f = new Filter(parseRules(lines));
    expect(f.safeSubstitute("a b.a.t and a fr0g, not a batch")).toBe("a bleep and a bleep, not a batch");
  });
});
