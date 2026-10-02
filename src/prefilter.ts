/**
 * Prefilter: decide cheaply which rules can possibly match a text, so most texts (clean
 * chat messages) are answered by ONE regex instead of one scan per rule.
 *
 * Rules are combined into alternations, which is exact for "does anything match here?":
 * if any rule matches at some position, the alternation matches there too. Rules anchored
 * with the shared letter-boundary lookbehind ({@link LEFT}) get it factored out —
 * `LEFT(?:a|b|…)` — so a position in the middle of a word fails once, not once per rule.
 * That is what makes the combined regex ~8x faster than scanning the rules one by one.
 *
 * Two levels: a top regex over every combinable rule, then buckets of ~16 rules; only the
 * rules of buckets that hit are scanned individually (in original order, so match
 * resolution is unchanged). Rules that can't be combined safely (back-references, named
 * groups, or a combined regex that fails to compile) are always scanned.
 */

import { LEFT, RIGHT, WORD_CLASS } from "./boundaries.js";

export interface Prefilter {
  /** Matches iff some combinable rule may match; null = no top-level shortcut. */
  top: RegExp | null;
  /** Bucket regex (null = always scan) and the rule indexes it covers. */
  buckets: { rx: RegExp | null; members: number[] }[];
  /** Rule indexes that are always scanned. */
  always: number[];
}

export const BUCKET_SIZE = 16;

// Numeric / named back-references or named groups change meaning (or clash) in a combination.
const UNSAFE_TO_COMBINE = /\\[1-9]|\\k<|\(\?<(?![=!])/;

/**
 * One regex source that matches wherever any of `sources` (same flags) matches.
 *
 * Boundary lookarounds shared by every rule are factored out of the alternation:
 * `LEFT(?:a|b)RIGHT` matches iff some `LEFT a RIGHT` / `LEFT b RIGHT` does, because
 * backtracking tries every alternative at every length before giving up. Besides failing
 * fast mid-word, this keeps V8 from compiling the (case-folded) `\p{L}` class once per
 * rule, which more than halves the combined regex's cold-start cost.
 */
function combine(sources: string[], ignoreCase: boolean): string {
  const both: string[] = []; // LEFT … RIGHT (every rule from parseRules)
  const leftOnly: string[] = [];
  const embeddedBoth: string[] = []; // LEFT \w* … RIGHT, relaxed to … RIGHT (see below)
  const others: string[] = [];
  for (const s of sources) {
    if (!s.startsWith(LEFT)) {
      others.push(`(?:${s})`);
      continue;
    }
    let rest = s.slice(LEFT.length);
    const right = rest.endsWith(RIGHT) && !rest.endsWith("\\" + RIGHT);
    if (right) rest = rest.slice(0, -RIGHT.length);
    // "Term embedded in a word" rules start with \w* / \w+: at every word start they swallow
    // the word and backtrack through it, which also defeats V8's first-character checks for
    // the whole alternation. A prefilter may over-approximate (never miss), so drop the
    // LEFT \w* prefix here: wherever `LEFT \w* X` matches, `X` alone matches too. The real
    // per-rule scan still uses the full rule.
    const relaxed = stripLeadingWord(rest);
    if (relaxed !== null) {
      if (right) embeddedBoth.push(relaxed);
      else others.push(relaxed);
    } else if (right) both.push(`(?:${rest})`);
    else leftOnly.push(`(?:${rest})`);
  }
  const parts: string[] = [];
  if (both.length) parts.push(`${LEFT}(?:${dispatch(both, ignoreCase)})${RIGHT}`);
  if (leftOnly.length) parts.push(`${LEFT}(?:${dispatch(leftOnly, ignoreCase)})`);
  if (embeddedBoth.length) parts.push(`(?:${embeddedBoth.join("|")})${RIGHT}`);
  return [...parts, ...others].join("|");
}

/**
 * `(?:\w*X)` / `(?:\w+X)` (lazy forms too) -> `(?:X)`; null if `src` doesn't start that way
 * or nothing would be left. `\w` here is toJsPattern's Unicode word class.
 */
function stripLeadingWord(src: string): string | null {
  const head = `(?:${WORD_CLASS}`;
  if (!src.startsWith(head) || groupEnd(src, 0) !== src.length - 1) return null;
  let i = head.length;
  if (src[i] !== "*" && src[i] !== "+") return null;
  i++;
  if (src[i] === "?") i++; // lazy
  const rest = src.slice(i, -1);
  return rest ? `(?:${rest})` : null;
}

// -- first-character dispatch ---------------------------------------------------------
//
// A backtracking engine tries an alternation's branches one by one, so at every word
// start `(?:r1|r2|…|r2000)` costs ~2000 attempts. Grouping branches behind a lookahead on
// the characters they can start with — `(?=[a4])(?:…)|(?=[s5$])(?:…)` — lets the engine
// skip whole groups with one cheap check. The analysis is conservative: any branch whose
// first character it can't pin down goes into an ungated group that is always tried.

const MAX_RANGE = 64; // expand class ranges up to this size, else give up on the branch
// V8 handles plain alternations of a few hundred branches well (it has its own first-char
// checks); the lookahead gates only pay off for very large ones (e.g. every language at once).
const DISPATCH_MIN_BRANCHES = 1000;

/** Index of the `)` closing the group that opens at `open`, or -1. */
function groupEnd(src: string, open: number): number {
  let depth = 0;
  let inClass = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") i++;
    else if (inClass) inClass = ch !== "]";
    else if (ch === "[") inClass = true;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Split a group body on its top-level `|`. */
function topLevelAlternatives(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") i++;
    else if (inClass) inClass = ch !== "]";
    else if (ch === "[") inClass = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "|" && depth === 0) {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  out.push(src.slice(start));
  return out;
}

/** Characters of a (non-negated) class body, or null if not a small literal set. */
function classChars(body: string): string[] | null {
  const chars: string[] = [];
  const items = [...body];
  for (let i = 0; i < items.length; i++) {
    let ch = items[i]!;
    if (ch === "\\") {
      const next = items[++i];
      if (next === undefined || /[A-Za-z0-9]/.test(next)) return null; // \d \p{…} \u… etc.
      ch = next;
    }
    if (items[i + 1] === "-" && i + 2 < items.length && items[i + 2] !== "\\") {
      const from = ch.codePointAt(0)!;
      const to = items[i + 2]!.codePointAt(0)!;
      if (to < from || to - from > MAX_RANGE) return null;
      for (let c = from; c <= to; c++) chars.push(String.fromCodePoint(c));
      i += 2;
      continue;
    }
    chars.push(ch);
  }
  return chars;
}

/**
 * The characters a match of `src` can start with — a superset — or null when unknown.
 * Only handles what rule bodies actually use; anything else is "unknown" (safe).
 */
export function firstChars(src: string): string[] | null {
  if (!src) return null; // empty branch matches the empty string
  let atom: string[] | null;
  let end: number; // index just past the atom
  const ch = src[0]!;
  if (ch === "(") {
    const close = groupEnd(src, 0);
    if (close < 0) return null;
    if (src[1] === "?") {
      if (src[2] !== ":") return null; // lookarounds / named groups: give up
      atom = unionOf(topLevelAlternatives(src.slice(3, close)));
    } else {
      atom = unionOf(topLevelAlternatives(src.slice(1, close)));
    }
    end = close + 1;
  } else if (ch === "[") {
    const close = classEnd(src);
    if (close < 0 || src[1] === "^") return null;
    atom = classChars(src.slice(1, close));
    end = close + 1;
  } else if (ch === "\\") {
    const next = src[1];
    if (next === undefined || /[A-Za-z0-9]/.test(next)) return null; // \d \w \b \1 \p…
    atom = [next];
    end = 2;
  } else if ("^$.|)*+?{".includes(ch)) {
    return null;
  } else {
    const cp = String.fromCodePoint(src.codePointAt(0)!);
    atom = [cp];
    end = cp.length;
  }
  if (!atom || atom.length === 0) return null;
  const q = src[end];
  if (q === "*" || q === "?" || (q === "{" && /^\{0[,}]/.test(src.slice(end)))) return null;
  return atom;
}

function classEnd(src: string): number {
  for (let i = src[1] === "^" ? 2 : 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "]") return i;
  }
  return -1;
}

function unionOf(alternatives: string[]): string[] | null {
  const out: string[] = [];
  for (const alt of alternatives) {
    const f = firstChars(alt);
    if (!f) return null;
    out.push(...f);
  }
  return out;
}

const CLASS_SPECIAL = /[\\\]^\-[]/;
const classLiteral = (c: string) => (CLASS_SPECIAL.test(c) ? "\\" + c : c);

/** Branches grouped behind first-character lookaheads (exact for "does any match?"). */
function dispatch(branches: string[], ignoreCase: boolean): string {
  if (branches.length < DISPATCH_MIN_BRANCHES) return branches.join("|");
  const byChar = new Map<string, number[]>();
  const ungated: number[] = [];
  branches.forEach((b, i) => {
    const chars = firstChars(b);
    if (!chars) {
      ungated.push(i);
      return;
    }
    for (const raw of new Set(chars.map((c) => (ignoreCase ? c.toLowerCase() : c)))) {
      let list = byChar.get(raw);
      if (!list) byChar.set(raw, (list = []));
      list.push(i);
    }
  });
  // Characters that gate the same set of branches share one lookahead.
  const byMembers = new Map<string, { chars: string[]; members: number[] }>();
  for (const [c, members] of byChar) {
    const key = members.join(",");
    const g = byMembers.get(key);
    if (g) g.chars.push(c);
    else byMembers.set(key, { chars: [c], members });
  }
  const parts = [...byMembers.values()].map(
    ({ chars, members }) =>
      `(?=[${chars.map(classLiteral).join("")}])(?:${members.map((i) => branches[i]).join("|")})`,
  );
  if (ungated.length) parts.push(...ungated.map((i) => branches[i]!));
  return parts.join("|");
}

function tryCompile(source: string, flags: string): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null; // e.g. "regular expression too large": fall back to finer levels
  }
}

export function buildPrefilter(rules: readonly RegExp[], bucketSize = BUCKET_SIZE): Prefilter {
  const always: number[] = [];
  const byFlags = new Map<string, number[]>();
  rules.forEach((rx, i) => {
    if (UNSAFE_TO_COMBINE.test(rx.source)) {
      always.push(i);
      return;
    }
    const flags = rx.flags.replace(/[gyd]/g, "");
    let group = byFlags.get(flags);
    if (!group) byFlags.set(flags, (group = []));
    group.push(i);
  });

  const buckets: Prefilter["buckets"] = [];
  for (const [flags, members] of byFlags) {
    for (let k = 0; k < members.length; k += bucketSize) {
      const chunk = members.slice(k, k + bucketSize);
      buckets.push({ rx: tryCompile(combine(chunk.map((i) => rules[i]!.source), flags.includes("i")), flags), members: chunk });
    }
  }

  let top: RegExp | null = null;
  const only = byFlags.size === 1 ? [...byFlags][0] : undefined;
  if (only && buckets.length > 1 && buckets.every((b) => b.rx)) {
    const [flags, members] = only;
    top = tryCompile(combine(members.map((i) => rules[i]!.source), flags.includes("i")), flags);
  }
  return { top, buckets, always };
}

/** Indexes of the rules that may match `text`, ascending (original rule order). */
export function candidateRules(pre: Prefilter, text: string, ruleCount: number): number[] {
  if (pre.top && !pre.top.test(text)) return pre.always;
  const scan = new Uint8Array(ruleCount);
  for (const i of pre.always) scan[i] = 1;
  for (const b of pre.buckets) {
    if (!b.rx || b.rx.test(text)) for (const i of b.members) scan[i] = 1;
  }
  const out: number[] = [];
  for (let i = 0; i < ruleCount; i++) if (scan[i]) out.push(i);
  return out;
}
