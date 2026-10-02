/** A rule: a regex matching obfuscated forms, paired with its "safe" substitute word. */
export type Rule = readonly [pattern: RegExp, safe: string];

/** A word list for one language, as raw lines (see the README for the line format). */
export interface LanguageData {
  /** Language code, e.g. `"en"`, `"es"`. */
  code: string;
  /** `/regex/<TAB>safe word` lines (blank lines and lines without a TAB are ignored). */
  rules: readonly string[];
  /** One protected phrase per line (blank and `#` lines are ignored). */
  exceptions: readonly string[];
}

/** Double-Metaphone implementation: returns `[primary, secondary]` codes. */
export type DoubleMetaphoneFn = (word: string) => readonly [string, string] | string[];

/** Returns a language code (`"es"`, `"zh-cn"`) for `text`, or null/undefined if unsure. */
export type LanguageDetector = (text: string) => string | null | undefined;
