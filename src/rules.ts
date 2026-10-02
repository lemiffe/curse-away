/**
 * Parsing of rule / exception lines and building filters from registered language lists.
 */

import { LEFT, RIGHT } from "./boundaries.js";
import { Filter } from "./filter.js";
import type { LanguageData, Rule } from "./types.js";

// Checked against the ORIGINAL Python pattern (as rules.py does): there `(?<` can only be a
// lookbehind, since Python spells named groups `(?P<`.
const ANCHORED_PREFIXES = ["^", "(?<"];
const WORD_BOUNDARY = "\\b";
/** Prefix a rule with this marker to let it match inside words (e.g. compounds). */
export const SUBSTRING_MARKER = "~";

/** Drop a rule's own outer `\b` — the letter-only boundaries replace (upgrade) it. */
function stripOuterWordBoundary(pat: string): string {
  if (pat.startsWith(WORD_BOUNDARY)) pat = pat.slice(WORD_BOUNDARY.length);
  if (pat.endsWith(WORD_BOUNDARY) && !pat.endsWith("\\" + WORD_BOUNDARY)) {
    pat = pat.slice(0, -WORD_BOUNDARY.length);
  }
  return pat;
}

const REGEX_SYNTAX = "^$\\.*+?()[]{}|/";

// Python's `\w` / `\d` / `\b` are Unicode-aware; JS's are ASCII-only even with the u flag.
const W = "\\p{L}\\p{N}_";
const OUTSIDE_CLASS: Record<string, string> = {
  w: `[${W}]`,
  W: `[^${W}]`,
  d: "\\p{Nd}",
  D: "\\P{Nd}",
  b: `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`,
  B: `(?:(?<=[${W}])(?=[${W}])|(?<![${W}])(?![${W}]))`,
  A: "^",
  Z: "$",
};
const INSIDE_CLASS: Record<string, string> = { w: W, d: "\\p{Nd}" };
// Escapes JS understands as-is (u mode); anything else non-alphanumeric is an identity
// escape, which u mode rejects unless the char is regex syntax.
const JS_ESCAPES = /[sSnrtfv0kpPux]/;
const QUANTIFIER_BRACES = /^\{\d+(,\d*)?\}|^\{,\d+\}/;

/**
 * Translate the Python regex syntax the word lists may use into JavaScript (u mode):
 *
 * - `(?P<n>…)` / `(?P=n)` named groups, `\A` / `\Z`, a leading `(?i)`;
 * - Unicode-aware `\w \W \d \D \b \B` (JS's are ASCII-only);
 * - possessive quantifiers (`x?+`, `x*+`, `x++`, `x{n}+`, Python 3.11+) become greedy, since
 *   JS has none — the JS rule may then match where backtracking makes Python's fail;
 * - literal braces and a class's leading `]` are escaped; identity escapes that u mode
 *   rejects (`\'`, `\ `, `\_`) lose the backslash.
 */
export function toJsPattern(pat: string): string {
  let src = pat;
  if (src.startsWith("(?i)")) src = src.slice(4);
  let out = "";
  let inClass = false;
  let afterQuantifier = false; // last emitted token was an (unescaped) quantifier
  let afterGroupOpen = false; // last emitted token was an unescaped "("
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    const wasGroupOpen = afterGroupOpen;
    afterGroupOpen = false;
    if (ch === "\\" && i + 1 < src.length) {
      const next = src[i + 1]!;
      i++;
      afterQuantifier = false;
      const table = inClass ? INSIDE_CLASS : OUTSIDE_CLASS;
      if (table[next] !== undefined) out += table[next];
      else if (REGEX_SYNTAX.includes(next) || JS_ESCAPES.test(next) || /\d/.test(next) ||
        (inClass && next === "-")) out += ch + next;
      else out += next;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      out += ch;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      afterQuantifier = false;
      out += ch;
      // Python treats a leading `]` (after an optional `^`) as a literal.
      if (src[i + 1] === "^") out += src[++i];
      if (src[i + 1] === "]") {
        out += "\\]";
        i++;
      }
      continue;
    }
    if (ch === "(" && src.startsWith("(?P<", i)) {
      out += "(?<";
      i += 3;
      continue;
    }
    if (ch === "(" && src.startsWith("(?P=", i)) {
      const close = src.indexOf(")", i);
      out += `\\k<${src.slice(i + 4, close)}>`;
      i = close;
      afterQuantifier = false;
      continue;
    }
    if (ch === "{" || ch === "}") {
      const quant = ch === "{" ? QUANTIFIER_BRACES.exec(src.slice(i)) : null;
      if (quant) {
        out += quant[0].startsWith("{,") ? "{0" + quant[0].slice(1) : quant[0]; // {,n} = {0,n}
        i += quant[0].length - 1;
        afterQuantifier = true;
      } else {
        out += "\\" + ch; // a literal brace (Python allows it bare; u mode does not)
        afterQuantifier = false;
      }
      continue;
    }
    if (ch === "+" && afterQuantifier) {
      afterQuantifier = false; // possessive marker: drop it
      continue;
    }
    const isQuantifier = ch === "*" || ch === "+" || (ch === "?" && !wasGroupOpen);
    // A `?` right after a quantifier is the lazy marker, not a new quantifier.
    afterQuantifier = isQuantifier && !(ch === "?" && afterQuantifier);
    afterGroupOpen = ch === "(";
    out += ch;
  }
  return out;
}

export interface ParseRulesOptions {
  /**
   * Wrap each rule in letter-only boundaries (default `true`) unless it is already
   * anchored (`^`, lookbehind) or prefixed with `~` (`~/regex/<TAB>safe`).
   */
  anchor?: boolean;
}

/** Parse `/regex/<TAB>safe word` lines into `[regex, safeWord]` rules. */
export function parseRules(lines: Iterable<string>, options: ParseRulesOptions = {}): Rule[] {
  const doAnchor = options.anchor ?? true;
  const rules: Rule[] = [];
  let index = -1;
  for (const line of lines) {
    index++;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    let pat = line.slice(0, tab).trim();
    const repl = line.slice(tab + 1).trim();
    const substring = pat.startsWith(SUBSTRING_MARKER);
    if (substring) pat = pat.slice(SUBSTRING_MARKER.length);
    if (pat.length >= 2 && pat.startsWith("/") && pat.endsWith("/")) pat = pat.slice(1, -1);
    if (!pat) continue;
    // Decide anchoring on the original (Python) pattern, exactly as pythanity does, then
    // translate the body and wrap it in the JS boundary lookarounds.
    const wrap = doAnchor && !substring && !ANCHORED_PREFIXES.some((p) => pat.startsWith(p));
    const body = toJsPattern(wrap ? stripOuterWordBoundary(pat) : pat);
    try {
      rules.push([new RegExp(wrap ? `${LEFT}(?:${body})${RIGHT}` : body, "giu"), repl] as const);
    } catch (err) {
      // Report the rule's position, never its text (lists hold offensive content).
      throw new Error(`parseRules: rule #${index} is not a valid regex (${(err as Error).name})`);
    }
  }
  return rules;
}

/** Parse one-phrase-per-line lists (trim; skip blank / `#`). */
export function parseLines(lines: Iterable<string>): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (s && !s.startsWith("#")) out.push(s);
  }
  return out;
}

/**
 * Build one {@link Filter} from the union of several languages' lists.
 *
 * Rules from all languages are concatenated (English usually first) and their exceptions
 * merged. Throws if `languages` is empty.
 */
export function buildFilter(languages: readonly LanguageData[]): Filter {
  if (languages.length === 0) {
    throw new Error("buildFilter: no language lists given");
  }
  const rules: Rule[] = [];
  const exceptions: string[] = [];
  for (const lang of languages) {
    rules.push(...parseRules(lang.rules));
    exceptions.push(...parseLines(lang.exceptions));
  }
  return new Filter(rules, { exceptions });
}
