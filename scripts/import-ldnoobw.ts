/**
 * Generate `data/profanity-<lang>.txt` from the LDNOOBW word lists.
 *
 * Source: https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words
 *
 * Each term is converted into an obfuscation-tolerant, word-anchored regex rule, e.g.:
 *
 *     ass  ->  \b[a4]+[ ._-]*[s5]+[ ._-]*[s5]+\b <TAB> <safe>
 *
 * - leetspeak digit classes for common letters (a->[a4], e->[e3], i->[i1], o->[o0], ...)
 * - optional `[ ._-]*` between letters (defeats "a.s.s" / "a s s"); each letter is 1+
 * - `\b` anchors so a pattern can't bridge innocent word gaps (upgraded to letter-only
 *   boundaries at load time — see the README)
 * - terms are folded with the same normalization as the text (accents stripped, Cyrillic
 *   transliterated, Hangul decomposed), otherwise non-Latin / accented rules never match
 *
 * The `safe` substitute is a placeholder (default "bleep") to curate per language later;
 * it only affects `safeSubstitute()`, not mask / drop / detection.
 *
 * Usage:
 *
 *     pnpm import:ldnoobw [--safe bleep] [--exclude en de]
 *
 * English is excluded by default so this never clobbers the hand-curated profanity-en.txt.
 * Only per-language counts are printed — never the term content. Run `pnpm gen:data`
 * (or any build/test) afterwards to regenerate the bundled modules.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeWithMap } from "../src/normalize.js";

const REPO = "LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words";
const REPO_API = `https://api.github.com/repos/${REPO}`;
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

// Digit-only leetspeak classes (kept digit-only so \b anchoring stays reliable).
const LEET: Record<string, string> = {
  a: "[a4]", b: "[b8]", e: "[e3]", g: "[g9]", i: "[i1]",
  l: "[l1]", o: "[o0]", s: "[s5]", t: "[t7]", z: "[z2]",
};

async function get(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "curse-away-import" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

async function defaultBranch(): Promise<string> {
  return (JSON.parse(await get(REPO_API)) as { default_branch?: string }).default_branch ?? "master";
}

async function languageFiles(): Promise<string[]> {
  const entries = JSON.parse(await get(`${REPO_API}/contents/`)) as { name?: string; type?: string }[];
  const names: string[] = [];
  for (const e of entries) {
    const name = e.name ?? "";
    if (e.type !== "file") continue;
    if (name.includes(".") || name === name.toUpperCase() || !/^\p{L}/u.test(name)) {
      continue; // skip README.md, LICENSE, etc.
    }
    names.push(name);
  }
  return names;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

export function termToRegex(term: string): string | null {
  // Fold the term exactly like the text it will be matched against (accents stripped,
  // Cyrillic transliterated, Hangul decomposed, ...); otherwise the rule can never match.
  const tokens: string[] = [];
  for (const ch of normalizeWithMap(term).normalized) {
    // Letters, digits and (spacing) marks such as Thai / Devanagari vowel signs.
    if (!/[\p{L}\p{N}\p{M}]/u.test(ch)) continue; // separators handle spaces/punctuation
    const lower = ch.toLowerCase();
    tokens.push(LEET[lower] ?? escapeRegex(lower));
  }
  if (tokens.length === 0) return null;
  const body = tokens.map((tok) => `${tok}+`).join("[ ._-]*");
  return `\\b${body}\\b`;
}

export function convert(text: string, safe: string): string[] {
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const term = line.trim();
    if (!term || term.startsWith("#")) continue;
    const rx = termToRegex(term);
    if (!rx || seen.has(rx)) continue;
    seen.add(rx);
    rules.push(`/${rx}/\t${safe}`);
  }
  return rules;
}

function parseArgs(argv: string[]): { safe: string; exclude: string[] } {
  let safe = "bleep";
  let exclude = ["en"];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--safe" && argv[i + 1]) safe = argv[++i]!;
    else if (argv[i] === "--exclude") {
      exclude = [];
      while (argv[i + 1] && !argv[i + 1]!.startsWith("--")) exclude.push(argv[++i]!);
    }
  }
  return { safe, exclude };
}

async function main(argv: string[]): Promise<number> {
  const { safe, exclude } = parseArgs(argv);
  mkdirSync(DATA_DIR, { recursive: true });
  const rawBase = `https://raw.githubusercontent.com/${REPO}/${await defaultBranch()}/`;

  let total = 0;
  for (const name of await languageFiles()) {
    if (exclude.includes(name)) {
      console.log(`skip ${name} (excluded)`);
      continue;
    }
    let raw: string;
    try {
      raw = await get(rawBase + encodeURIComponent(name));
    } catch (exc) {
      console.log(`FAIL ${name}: ${(exc as Error).message}`);
      continue;
    }
    const rules = convert(raw, safe);
    if (rules.length === 0) {
      console.log(`skip ${name} (no terms)`);
      continue;
    }
    const header =
      `# Auto-generated from the LDNOOBW '${name}' list (${REPO}).\n` +
      "# Obfuscation-tolerant, word-anchored, digit leetspeak classes.\n" +
      `# safe-substitute placeholder = '${safe}' (curate per language).\n`;
    writeFileSync(join(DATA_DIR, `profanity-${name}.txt`), header + rules.join("\n") + "\n", "utf8");
    total += rules.length;
    console.log(`wrote profanity-${name}.txt (${rules.length} rules)`);
  }
  console.log(`done: ${total} rules written`);
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
