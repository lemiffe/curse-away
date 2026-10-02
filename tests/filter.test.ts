import { describe, expect, it } from "vitest";

import { Filter, hasBlockedPhonetic, phoneticHits } from "../src/filter.js";
import type { Rule } from "../src/types.js";

const make = (rules?: Rule[], exceptions: string[] = []) =>
  new Filter(rules ?? [[/\bbadword\b/i, "nice"]], { exceptions });

describe("Filter transforms", () => {
  it("mask keeps first and last", () => {
    expect(make().mask("a badword here")).toBe("a b*****d here");
  });

  it("maskFull stars everything", () => {
    expect(make().maskFull("a badword here")).toBe("a ******* here");
  });

  it("safeSubstitute uses the rule word", () => {
    expect(make().safeSubstitute("a badword here")).toBe("a nice here");
  });

  it("dropProfanity removes and collapses", () => {
    expect(make().dropProfanity("a badword here")).toBe("a here");
  });

  it("dropProfanity leaves no space before punctuation", () => {
    expect(make().dropProfanity("that badword. ok")).toBe("that. ok");
    expect(make().dropProfanity("badword!")).toBe("!");
  });

  it("dropProfanity leaves clean text untouched (including trailing newlines)", () => {
    expect(make().dropProfanity("all clean\n")).toBe("all clean\n");
  });

  it("containsProfanity", () => {
    const f = make();
    expect(f.containsProfanity("a badword")).toBe(true);
    expect(f.containsProfanity("all clean")).toBe(false);
  });

  it("does not star short matches and keeps case", () => {
    const f = make([[/\bbad\b/i, "ok"]]);
    expect(f.mask("That is BAD today")).toBe("That is B*D today"); // 3 chars, case kept
  });

  it("exceptions protect a word", () => {
    const f = make([[/trainers/i, "shoes"]], ["trainers"]);
    expect(f.mask("my new trainers today")).toBe("my new trainers today");
    expect(f.find("my new trainers today")).toEqual([]);
  });

  it("preserves original accents outside the mask", () => {
    // Matching folds "Café" -> "Cafe", but the transform applies to the ORIGINAL span,
    // so the accent survives and only the middle is starred.
    const f = make([[/\bcafe\b/i, "shop"]]);
    expect(f.mask("at the Café now")).toBe("at the C**é now");
  });

  it("preserves emoji outside a match", () => {
    const f = make([[/\bbad\b/i, "ok"]]);
    expect(f.mask("bad 😀 day")).toBe("b*d 😀 day");
  });

  it("maps spans correctly after astral characters (UTF-16 surrogate pairs)", () => {
    const f = make([[/\bbad\b/i, "ok"]]);
    expect(f.mask("😀😀 bad 𝔘 bad")).toBe("😀😀 b*d 𝔘 b*d");
    const [m] = f.find("😀 bad");
    expect([m!.start, m!.end, m!.text]).toEqual([3, 6, "bad"]);
  });

  it("matches obfuscation and masks the original punctuation", () => {
    const f = make([[/\bb[ _.-]*a[ _.-]*d\b/i, "ok"]]);
    expect(f.mask("that is b.a.d stuff")).toBe("that is b***d stuff");
  });

  it("works with non-global regexes (adds the g flag)", () => {
    const f = make([[/bad/i, "ok"]]);
    expect(f.mask("bad bad")).toBe("b*d b*d");
  });

  it("is not affected by regex state (shared, sticky, or handed out via Match.pattern)", () => {
    const shared = /fooz/gi;
    const f = make([[shared, "x"], [/barz/iy, "y"]]);
    shared.lastIndex = 99;
    expect(f.find("fooz and fooz").length).toBe(2);
    const [m] = f.find("fooz");
    m!.pattern.test("xxxxxxxxxxxx fooz"); // advances that regex's lastIndex
    expect(f.find("fooz and fooz").length).toBe(2);
    expect(f.find("one barz").length).toBe(1); // sticky flag dropped
  });

  it("exception boundaries follow Python's \\b, including at punctuation edges", () => {
    const f = make([[/fooz/i, "x"]], ["fooz!"]);
    // Python's \b after "!" needs a word char next: "fooz!x" is protected, "fooz! x" is not.
    expect(f.mask("fooz!x")).toBe("fooz!x");
    expect(f.mask("fooz! x")).toBe("f**z! x");
  });
});

describe("performance options", () => {
  const many: Rule[] = Array.from({ length: 20 }, (_, i) => [new RegExp(`\\bw${i}x\\b`, "i"), "ok"]);

  it("warmUp() compiles everything without changing results", () => {
    const f = new Filter(many);
    expect(f.warmUp()).toBe(f);
    expect(f.mask("a w3x and W17X")).toBe("a w*x and W**X");
  });

  it("caches results per text (LRU) and can be disabled", () => {
    const f = new Filter(many, { cacheSize: 2 });
    const a = f.find("w1x");
    expect(f.find("w1x")).toEqual(a);
    expect(f.find("w1x")).not.toBe(a); // copies, never the cached array itself
    f.find("w2x");
    f.find("w3x"); // evicts the least recently used entry
    expect(f.mask("w1x")).toBe("w*x");
    expect(new Filter(many, { cacheSize: 0 }).mask("w5x")).toBe("w*x");
  });

  it("does not cache very long texts", () => {
    const f = new Filter(many, { cacheSize: 4 });
    const long = "w1x ".repeat(1000);
    expect(f.find(long).length).toBe(1000);
    expect(f.find(long).length).toBe(1000);
  });
});

describe("phonetic", () => {
  it("hasBlockedPhonetic with an injected dm", () => {
    const dm = (t: string): [string, string] => (t === "zzx" ? ["SNKR", ""] : ["AAA", ""]);
    expect(hasBlockedPhonetic("hello zzx world", undefined, dm)).toBe(true);
    expect(hasBlockedPhonetic("all clean words", undefined, dm)).toBe(false);
  });

  it("real Double-Metaphone codes match pythanity's for the blocked sounds", () => {
    // Reference codes from Python's `metaphone.doublemetaphone` (primary code only).
    // Harmless words that share the blocked sound must trip the check...
    expect(phoneticHits("the horse gave a nicker")).toEqual(["nicker"]);
    expect(phoneticHits("new sneaker today")).toEqual(["sneaker"]);
    // ...while plurals and everyday words do not.
    expect(phoneticHits("sneakers and knickers in the park")).toEqual([]);
  });

  it("containsPhoneticProfanity returns a boolean", () => {
    expect(typeof make().containsPhoneticProfanity("a normal sentence")).toBe("boolean");
  });
});
