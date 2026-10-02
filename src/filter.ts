/**
 * The profanity filter engine.
 *
 * A {@link Filter} holds compiled regex rules (each paired with a "safe" substitute),
 * optional exception phrases to protect, and the phonetic (Double-Metaphone) block codes.
 * It matches on a normalized view of the text but applies every transform to the ORIGINAL
 * text via span-mapping, so only matched spans change.
 */

import { doubleMetaphone } from "double-metaphone";

import { normalizeForMatch } from "./normalize.js";
import { buildPrefilter, candidateRules, type Prefilter } from "./prefilter.js";
import type { DoubleMetaphoneFn, Rule } from "./types.js";

export const DEFAULT_PHONETIC_CODES: readonly string[] = ["NKR", "SNKR"];

type Span = readonly [start: number, end: number];

/** Keep first + last char, star the middle (segments < 3 chars unchanged). */
export function maskPartial(segment: string): string {
  if (segment.length < 3) return segment;
  return segment[0] + "*".repeat(segment.length - 2) + segment[segment.length - 1];
}

function maskFullSegment(segment: string): string {
  return "*".repeat(segment.length);
}

function overlaps(a: Span, b: Span): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A private global copy of `rx` (needed for `matchAll`). Cloning means a caller's regex —
 * or one handed back via {@link Match.pattern} — can never change the filter's state;
 * the sticky flag is dropped so every search scans the whole text.
 */
function ownGlobalCopy(rx: RegExp): RegExp {
  return new RegExp(rx.source, rx.flags.replace(/[gy]/g, "") + "g");
}

// Unicode word character, as in Python's `\w` (JS's own \w / \b are ASCII-only).
const WORD = "[\\p{L}\\p{N}_]";
const isWordChar = (ch: string) => new RegExp(WORD, "u").test(ch);

/** Python-`\b` semantics at one edge of a literal phrase whose edge char is `ch`. */
function boundary(ch: string, side: "left" | "right"): string {
  const word = isWordChar(ch);
  if (side === "left") return word ? `(?<!${WORD})` : `(?<=${WORD})`;
  return word ? `(?!${WORD})` : `(?=${WORD})`;
}

/**
 * Compile a word-bounded, case-insensitive alternation of protected phrases — the same
 * matches as pythanity's `\b(phrase|…)\b`, with Unicode-aware word characters.
 */
export function buildExceptions(phrases: Iterable<string>): RegExp | null {
  const cleaned = [...new Set([...phrases].map((p) => (p ?? "").trim().toLowerCase()))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (cleaned.length === 0) return null;
  // Group phrases by their left-boundary kind and factor that lookbehind out: the two kinds
  // ((?<!W) vs (?<=W)) can never both hold at one position, so grouping can't change which
  // phrase matches there. Without this, hundreds of phrases each re-test a case-folded
  // \p{L} lookbehind at every position (seconds per long text). Within a group, phrases
  // stay longest-first (pythanity's order), and a uniform right boundary is factored too.
  const groups = new Map<string, string[]>();
  for (const p of cleaned) {
    const left = boundary([...p][0]!, "left");
    let g = groups.get(left);
    if (!g) groups.set(left, (g = []));
    g.push(p);
  }
  const parts: string[] = [];
  for (const [left, members] of groups) {
    const rights = members.map((p) => boundary([...p].at(-1)!, "right"));
    const uniform = rights.every((r) => r === rights[0]);
    const alts = members.map((p, i) => escapeRegex(p) + (uniform ? "" : rights[i]));
    parts.push(`${left}(?:${alts.join("|")})${uniform ? rights[0] : ""}`);
  }
  return new RegExp(parts.join("|"), "giu");
}

/** Return the tokens / adjacent bigrams whose Double-Metaphone code is blocked. */
export function phoneticHits(
  text: string,
  blocked: readonly string[] = DEFAULT_PHONETIC_CODES,
  dm: DoubleMetaphoneFn = doubleMetaphone,
): string[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const hits: string[] = [];
  for (const token of tokens) {
    if (blocked.includes(dm(token)[0]!)) hits.push(token);
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = tokens[i]! + tokens[i + 1]!;
    if (blocked.includes(dm(bigram)[0]!)) hits.push(bigram);
  }
  return hits;
}

/** True if any token or adjacent bigram has a blocked Double-Metaphone code. */
export function hasBlockedPhonetic(
  text: string,
  blocked: readonly string[] = DEFAULT_PHONETIC_CODES,
  dm: DoubleMetaphoneFn = doubleMetaphone,
): boolean {
  return phoneticHits(text, blocked, dm).length > 0;
}

/** A resolved profanity hit, in ORIGINAL-text coordinates (UTF-16 offsets). */
export class Match {
  constructor(
    readonly start: number,
    readonly end: number,
    readonly text: string,
    readonly safe: string,
    readonly pattern: RegExp,
  ) {}

  toString(): string {
    return `Match(${JSON.stringify(this.text)} [${this.start}:${this.end}] -> ${JSON.stringify(this.safe)})`;
  }
}

export interface FilterOptions {
  /** Phrases to protect from matching (e.g. `["trainers"]`). */
  exceptions?: Iterable<string>;
  /** Double-Metaphone codes that {@link Filter.containsPhoneticProfanity} treats as a hit. */
  phoneticCodes?: readonly string[];
  /**
   * How many recent texts (≤ 2048 chars) to remember results for — chat traffic repeats
   * a lot. Default 512; `0` disables the cache.
   */
  cacheSize?: number;
  /**
   * Skip rules that cannot match via combined prefilter regexes (default true). The
   * results are identical either way; turning it off only helps debugging/benchmarks.
   */
  prefilter?: boolean;
}

const CACHE_MAX_TEXT = 2048;
const MIN_PREFILTER_RULES = 8;

/**
 * Detect and transform profanity in text.
 *
 * @param rules iterable of `[regex, safeWord]`. The regex matches obfuscated forms
 *   (use the `i` flag for case-insensitivity); `safeWord` is used by
 *   {@link Filter.safeSubstitute}. Use {@link parseRules} to build anchored rules from
 *   `/regex/<TAB>safe` lines.
 */
export class Filter {
  private readonly rules: Rule[];
  private readonly exceptions: RegExp | null;
  private readonly phoneticCodes: readonly string[];
  private prefilterState: Prefilter | null | undefined; // built lazily on first search
  private readonly cacheSize: number;
  private readonly usePrefilter: boolean;
  private readonly cache = new Map<string, Match[]>();

  constructor(rules: Iterable<Rule>, options: FilterOptions = {}) {
    this.rules = [...rules].map(([rx, safe]) => [ownGlobalCopy(rx), safe] as const);
    this.exceptions = buildExceptions(options.exceptions ?? []);
    this.phoneticCodes = [...(options.phoneticCodes ?? DEFAULT_PHONETIC_CODES)];
    this.cacheSize = Math.max(0, options.cacheSize ?? 512);
    this.usePrefilter = options.prefilter ?? true;
  }

  // -- core matching -------------------------------------------------------

  /** The rule prefilter (null when there are too few rules for it to pay off). */
  private prefilter(): Prefilter | null {
    if (this.prefilterState === undefined) {
      this.prefilterState = this.usePrefilter && this.rules.length >= MIN_PREFILTER_RULES
        ? buildPrefilter(this.rules.map(([rx]) => rx))
        : null;
    }
    return this.prefilterState;
  }

  /** Return the resolved, non-overlapping {@link Match}es for `text`. */
  find(text: string): Match[] {
    const cacheable = this.cacheSize > 0 && text.length <= CACHE_MAX_TEXT;
    if (cacheable) {
      const hit = this.cache.get(text);
      if (hit) {
        this.cache.delete(text); // refresh LRU position
        this.cache.set(text, hit);
        return hit.slice();
      }
    }
    const matches = this.findUncached(text);
    if (cacheable) {
      if (this.cache.size >= this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(text, matches);
      return matches.slice();
    }
    return matches;
  }

  private findUncached(text: string): Match[] {
    const { normalized: norm, indexMap: idx } = normalizeForMatch(text);
    if (!norm) return [];
    const pre = this.prefilter();
    const toScan = pre ? candidateRules(pre, norm, this.rules.length) : this.rules.map((_, i) => i);
    if (toScan.length === 0) return [];

    const candidates: [number, number, string, RegExp][] = [];
    for (const r of toScan) {
      const [pattern, safe] = this.rules[r]!;
      // matchAll starts at lastIndex; Match.pattern hands this regex out, so reset it.
      pattern.lastIndex = 0;
      for (const m of norm.matchAll(pattern)) {
        if (m[0].length === 0) continue;
        candidates.push([m.index!, m.index! + m[0].length, safe, pattern]);
      }
    }
    if (candidates.length === 0) return [];

    // Exceptions only matter once something matched (most texts never get here).
    if (this.exceptions) {
      this.exceptions.lastIndex = 0;
      const excSpans: Span[] = [...norm.matchAll(this.exceptions)]
        .map((m) => [m.index!, m.index! + m[0].length] as const);
      if (excSpans.length) {
        for (let k = candidates.length - 1; k >= 0; k--) {
          const c = candidates[k]!;
          if (excSpans.some((e) => overlaps([c[0], c[1]], e))) candidates.splice(k, 1);
        }
      }
    }

    // Resolve overlaps: earliest start wins, then longest (stable: rule order breaks ties).
    candidates.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]));
    const matches: Match[] = [];
    let lastEnd = -1;
    for (const [start, end, safe, pattern] of candidates) {
      if (start < lastEnd) continue;
      const oStart = idx ? idx[start]! : start;
      const last = idx ? idx[end - 1]! : end - 1;
      const oEnd = idx ? last + String.fromCodePoint(text.codePointAt(last)!).length : end;
      matches.push(new Match(oStart, oEnd, text.slice(oStart, oEnd), safe, pattern));
      lastEnd = end;
    }
    return matches;
  }

  /**
   * Compile every internal regex now instead of on first use (V8 compiles lazily), e.g.
   * from `requestIdleCallback` at app start so the first real message isn't slowed down.
   */
  warmUp(): this {
    const sample = "warm up the filter a.b.c 123";
    const pre = this.prefilter();
    pre?.top?.test(sample);
    for (const b of pre?.buckets ?? []) b.rx?.test(sample);
    for (const [rx] of this.rules) {
      rx.lastIndex = 0;
      rx.test(sample);
    }
    return this;
  }

  private transform(text: string, fn: (m: Match) => string, found?: Match[]): string {
    const matches = found ?? this.find(text);
    if (matches.length === 0) return text;
    let out = "";
    let prev = 0;
    for (const m of matches) {
      out += text.slice(prev, m.start) + fn(m);
      prev = m.end;
    }
    return out + text.slice(prev);
  }

  // -- public transforms ---------------------------------------------------

  /** Mask each match, keeping first + last char (`shit` -> `s**t`). */
  mask(text: string): string {
    return this.transform(text, (m) => maskPartial(m.text));
  }

  /** Mask each match completely (`shit` -> `****`). */
  maskFull(text: string): string {
    return this.transform(text, (m) => maskFullSegment(m.text));
  }

  /** Replace each match with its configured safe word. */
  safeSubstitute(text: string): string {
    return this.transform(text, (m) => m.safe);
  }

  /** Remove each match and tidy the whitespace it leaves behind. */
  dropProfanity(text: string): string {
    const matches = this.find(text);
    if (matches.length === 0) return text; // nothing dropped: leave as-is
    return this.transform(text, () => "", matches)
      .replace(/[ \t]+([,.!?;:])/g, "$1") // no space before punctuation
      .replace(/[ \t]{2,}/g, " ") // collapse runs
      .trim();
  }

  // -- detection -----------------------------------------------------------

  containsProfanity(text: string): boolean {
    return this.find(text).length > 0;
  }

  containsPhoneticProfanity(text: string): boolean {
    return hasBlockedPhonetic(text, this.phoneticCodes);
  }

  /** Tokens/bigrams that trip the phonetic (Double-Metaphone) check. */
  phoneticHits(text: string): string[] {
    return phoneticHits(text, this.phoneticCodes);
  }
}
