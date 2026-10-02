// Rule parsing: automatic letter-boundary anchoring, the `~` substring opt-out, and
// translation of Python-only regex syntax.
import { describe, expect, it } from "vitest";

import { Filter } from "../src/filter.js";
import { parseRules, toJsPattern } from "../src/rules.js";

const hits = (lines: string[], text: string) =>
  new Filter(parseRules(lines)).find(text).map((m) => m.text);

describe("parseRules", () => {
  it("anchors an unanchored rule by default", () => {
    const lines = ["/fr[i1!]ck/\tfudge"];
    expect(hits(lines, "africk fricker")).toEqual([]);
    expect(hits(lines, "oh frick, really")).toEqual(["frick"]);
  });

  it("allows digits, underscores and punctuation at the edges", () => {
    const lines = ["/fr[i1!]ck/\tfudge"];
    for (const text of [",frick", "(frick)", "frick123", "_frick_", "frick!"]) {
      expect(hits(lines, text), text).toEqual(["frick"]);
    }
  });

  it("allows leading-symbol leetspeak", () => {
    // \b would fail here: there is no word character before "@".
    expect(hits(["/[@a]ss/\tbutt"], "an @ss!")).toEqual(["@ss"]);
    expect(hits(["/[@a]ss/\tbutt"], "a glass")).toEqual([]);
  });

  it("uses Unicode letters for boundaries (JS \b is ASCII-only)", () => {
    expect(hits(["/frick/\tfudge"], "éfrick")).toEqual([]);
    expect(hits(["/frick/\tfudge"], "frické")).toEqual([]);
  });

  it("lets the ~ marker opt out of anchoring", () => {
    expect(hits(["~/fr[i1!]ck/\tfudge"], "africk")).toEqual(["frick"]);
  });

  it("upgrades a rule's own \\b to letter boundaries", () => {
    const lines = [String.raw`/\bfrick\b/` + "\tfudge"];
    expect(hits(lines, "frick123 _frick_")).toEqual(["frick", "frick"]);
    expect(hits(lines, "africk")).toEqual([]);
  });

  it("leaves explicitly anchored rules as-is", () => {
    const [[rx]] = parseRules(["/^frick/\tfudge"]) as [[RegExp, string]];
    expect(rx.source).toBe("^frick");
  });

  it("can disable anchoring", () => {
    const f = new Filter(parseRules(["/fr[i1!]ck/\tfudge"], { anchor: false }));
    expect(f.find("africk").map((m) => m.text)).toEqual(["frick"]);
  });

  it("does not start a match inside a contraction", () => {
    // A separator-tolerant rule must not bridge "isn't it" via the contraction's "t".
    const lines = ["/t[ ._-]*[i1]+[ ._-]*t/\tbits"];
    for (const text of ["isn't it", "wasn’t it"]) expect(hits(lines, text), text).toEqual([]);
    expect(hits(lines, "'tit'")).toEqual(["tit"]); // a quoted word still matches
  });

  it("skips lines without a TAB and blank patterns", () => {
    expect(parseRules(["# comment", "", "/x/", "//\tnothing"])).toEqual([]);
  });
});

describe("toJsPattern (Python -> JS regex syntax)", () => {
  it("turns possessive quantifiers into greedy ones", () => {
    expect(toJsPattern("ab?+c*+d++e{2}+")).toBe("ab?c*d+e{2}");
  });

  it("keeps ordinary + after classes, groups and escapes", () => {
    expect(toJsPattern(String.raw`[a4]+(x)+\++`)).toBe(String.raw`[a4]+(x)+\++`);
  });

  it("keeps lazy quantifiers", () => {
    expect(toJsPattern("a+?b*?")).toBe("a+?b*?");
  });

  it("translates named groups and drops a leading (?i)", () => {
    expect(toJsPattern("(?i)(?P<w>a)(?P=w)")).toBe(String.raw`(?<w>a)\k<w>`);
  });

  it("drops identity escapes that JS u-mode rejects, keeping \\- inside classes", () => {
    expect(toJsPattern(String.raw`a\'b\ c[\-_]\-`)).toBe(String.raw`a'b c[\-_]-`);
  });

  it("escapes literal braces but keeps quantifier braces ({,n} -> {0,n})", () => {
    expect(toJsPattern("a{b}+c{2,}d{,3}")).toBe(String.raw`a\{b\}+c{2,}d{0,3}`);
  });

  it("keeps a class's leading ] literal, as Python does", () => {
    expect(toJsPattern("[]a]x[^]b]")).toBe(String.raw`[\]a]x[^\]b]`);
  });

  it("does not treat an escaped paren as a group opener", () => {
    expect(toJsPattern(String.raw`\(?+x`)).toBe(String.raw`\(?x`);
  });

  it("translates \\A and \\Z but not an escaped backslash before them", () => {
    expect(toJsPattern(String.raw`\Aab\Z`)).toBe("^ab$");
    expect(toJsPattern(String.raw`a\\Z`)).toBe(String.raw`a\\Z`);
  });

  it("makes \\w, \\d and \\b Unicode-aware, like Python", () => {
    const rx = (p: string) => new RegExp(toJsPattern(p), "u");
    expect(rx(String.raw`^fooz\w+$`).test("foozαβγ")).toBe(true);
    expect(rx(String.raw`^[\w]+$`).test("αβγ_1")).toBe(true);
    expect(rx(String.raw`^\d+$`).test("٣٤")).toBe(true); // Arabic-Indic digits
    expect(rx(String.raw`\bβ`).test("α β")).toBe(true);
    expect(rx(String.raw`\bβ`).test("αβ")).toBe(false);
  });
});

describe("parseRules parity details", () => {
  it("anchors rules that start with a named group (Python spells it (?P<…>))", () => {
    expect(hits(["/(?P<w>fooz)/\tx"], "afooz fooz")).toEqual(["fooz"]);
  });

  it("leaves real lookbehind rules unanchored", () => {
    expect(hits(["/(?<=a)fooz/\tx"], "afooz")).toEqual(["fooz"]);
  });

  it("reports an invalid rule by position only", () => {
    expect(() => parseRules(["/ok/\tx", "/(unclosed/\tx"])).toThrow(/rule #1 is not a valid regex/);
  });
});
