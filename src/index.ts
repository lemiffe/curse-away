/**
 * curse-away — regex-based multilingual profanity detection, masking and substitution.
 *
 * Quick start:
 *
 *   import { mask, maskFull, safeSubstitute, dropProfanity, containsProfanity } from "curse-away";
 *
 *   mask("that is shit");             // 'that is s**t'  — keep first/last
 *   maskFull("that is shit");         // 'that is ****'
 *   safeSubstitute("that is shit");   // 'that is sheet' (rule's safe word)
 *   dropProfanity("that is shit");    // 'that is'
 *   containsProfanity("all clean");   // false
 *
 * English is bundled. Other languages are opt-in (`curse-away/languages`) so browser
 * bundles stay small. The module-level helpers are English-only by default; pass a language
 * (`mask(text, "es")`) or `{ multilingual: true }` to also apply the explicit / auto-detected
 * language (`curse-away/detect`). English swears leak into every language, so it stays on.
 * Build a {@link Filter} directly for full control.
 */

import en from "./data/en.js";
import { Filter } from "./filter.js";
import { buildFilter } from "./rules.js";
import type { LanguageData, LanguageDetector } from "./types.js";

export {
  Filter,
  Match,
  DEFAULT_PHONETIC_CODES,
  buildExceptions,
  hasBlockedPhonetic,
  maskPartial,
  phoneticHits,
} from "./filter.js";
export type { FilterOptions } from "./filter.js";
export { buildFilter, parseLines, parseRules, SUBSTRING_MARKER, toJsPattern } from "./rules.js";
export type { ParseRulesOptions } from "./rules.js";
export { cyrToLatin, normalizeWithMap, removeAccents, removeEmoji } from "./normalize.js";
export type { NormalizedText } from "./normalize.js";
export type { DoubleMetaphoneFn, LanguageData, LanguageDetector, Rule } from "./types.js";

declare const __VERSION__: string;
/** Package version (injected from package.json at build time). */
export const VERSION: string = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

const languages = new Map<string, LanguageData>([[en.code, en]]);
const filters = new Map<string, Filter>();
let detector: LanguageDetector | null = null;
let detectMinLength = 3;

/** Make one or more word lists available (e.g. from `curse-away/languages`). */
export function registerLanguage(...data: LanguageData[]): void {
  for (const lang of data) languages.set(lang.code, lang);
  filters.clear();
}

/** Languages with a registered list, sorted. English is always present. */
export function availableLanguages(): string[] {
  return [...languages.keys()].sort();
}

export interface LanguageDetectorOptions {
  /**
   * Only run the detector on texts at least this many characters long (after trimming);
   * shorter texts use English plus the explicit `lang`. Default 3 (as pythanity).
   * Detection usually costs far more than filtering (~0.3 ms per call with tinyld) and
   * is unreliable on a few words, so for chat traffic something like 25–40 is a good
   * trade-off.
   */
  minLength?: number;
}

/**
 * Register (or clear, with `null`) the function used to auto-detect a text's language.
 * Without one, the module-level helpers use English only unless `lang` is given.
 */
export function setLanguageDetector(
  fn: LanguageDetector | null,
  options: LanguageDetectorOptions = {},
): void {
  detector = fn;
  detectMinLength = Math.max(1, options.minLength ?? 3);
}

/** Best-effort bare language code for `text` (`"es"`), or `null` if unavailable/unsure. */
export function detectLanguage(text: string): string | null {
  const t = (text ?? "").trim();
  if (!detector || t.length < detectMinLength) return null;
  let code: string | null | undefined;
  try {
    code = detector(t);
  } catch {
    return null;
  }
  return code ? code.split("-")[0]!.toLowerCase() : null;
}

/** Per-call language options for the module-level helpers. */
export interface LanguageOptions {
  /**
   * Also filter against a second language: the explicit `lang`, or else the auto-detected
   * one (see {@link setLanguageDetector}). When false, only English is used and no
   * detection runs. Defaults to `true` when `lang` is given, otherwise `false`.
   */
  multilingual?: boolean;
  /** The extra language to apply (e.g. `"es"`); skips auto-detection. */
  lang?: string | null;
}

/** A language code (shorthand for `{ lang }`) or {@link LanguageOptions}. */
export type LanguageArg = string | null | undefined | LanguageOptions;

function toOptions(arg: LanguageArg): { multilingual: boolean; lang: string | null } {
  if (arg == null) return { multilingual: false, lang: null };
  if (typeof arg === "string") return { multilingual: true, lang: arg };
  const lang = arg.lang ?? null;
  return { multilingual: arg.multilingual ?? lang !== null, lang };
}

/**
 * The languages to filter against: always English, plus — when multilingual — the
 * explicit `lang` or the auto-detected one (if a list for it is registered).
 *
 *   resolveLanguages(text)                          // ["en"]
 *   resolveLanguages(text, "es")                    // ["en", "es"]
 *   resolveLanguages(text, { multilingual: true })  // ["en", <detected>] or ["en"]
 */
export function resolveLanguages(text: string, options?: LanguageArg): string[] {
  const { multilingual, lang } = toOptions(options);
  const langs = ["en"];
  if (!multilingual) return langs;
  let extra = lang || detectLanguage(text);
  if (extra) {
    extra = extra.split("-")[0]!.toLowerCase();
    if (extra !== "en" && languages.has(extra)) langs.push(extra);
  }
  return langs;
}

/** Return a cached combined {@link Filter} for the given languages (default `en`). */
export function getFilter(...langs: string[]): Filter {
  const key = (langs.length ? langs : ["en"]).join("|");
  let f = filters.get(key);
  if (!f) {
    const data = key.split("|").map((c) => languages.get(c)).filter((d) => d !== undefined);
    if (data.length === 0) {
      throw new Error(
        `No registered profanity lists for languages ${JSON.stringify(langs)} ` +
          `(register them via registerLanguage(), e.g. from "curse-away/languages")`,
      );
    }
    f = buildFilter(data);
    filters.set(key, f);
  }
  return f;
}

function filterFor(text: string, options?: LanguageArg): Filter {
  return getFilter(...resolveLanguages(text, options));
}

/** Mask each match, keeping first + last char. */
export function mask(text: string, options?: LanguageArg): string {
  return filterFor(text, options).mask(text);
}

/** Mask each match completely. */
export function maskFull(text: string, options?: LanguageArg): string {
  return filterFor(text, options).maskFull(text);
}

/** Replace each match with its rule's safe word. */
export function safeSubstitute(text: string, options?: LanguageArg): string {
  return filterFor(text, options).safeSubstitute(text);
}

/** Remove each match and tidy the leftover whitespace. */
export function dropProfanity(text: string, options?: LanguageArg): string {
  return filterFor(text, options).dropProfanity(text);
}

/** True if any rule matches. */
export function containsProfanity(text: string, options?: LanguageArg): boolean {
  return filterFor(text, options).containsProfanity(text);
}

/** True if a token or adjacent bigram sounds like blocked profanity (Double-Metaphone). */
export function containsPhoneticProfanity(text: string, options?: LanguageArg): boolean {
  return filterFor(text, options).containsPhoneticProfanity(text);
}
