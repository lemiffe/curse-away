/**
 * Unicode normalization used to make profanity matching robust against accents, emoji,
 * and Cyrillic look-alikes.
 *
 * The key export is {@link normalizeWithMap}: it returns the normalized text AND a
 * parallel array mapping each normalized character back to its originating index in the
 * input. That index map lets the filter match on the normalized view but apply masking /
 * substitution to the ORIGINAL text, so the caller's accents, case and emoji survive
 * everywhere except inside a matched span.
 *
 * Indexes are UTF-16 code-unit offsets (what `String.prototype.slice` uses), so astral
 * characters such as emoji are handled correctly.
 */

import { COMBINING_CLASS } from "./combining.js";

// Latin characters that do NOT decompose under NFKD — explicit replacements.
const SPECIALS: Record<string, string> = {
  "ß": "ss", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE",
  "ø": "o", "Ø": "O", "þ": "th", "Þ": "TH", "ð": "d", "Ð": "D",
  "đ": "d", "Đ": "D", "ł": "l", "Ł": "L", "ħ": "h", "Ħ": "H",
  "ı": "i", "ŧ": "t", "Ŧ": "T", "ŉ": "n", "ĸ": "k", "ſ": "s",
  "£": "", "€": "E",
};

// Cyrillic -> Latin.
const CYR: Record<string, string> = {
  "ж": "zh", "ч": "ch", "щ": "sht", "ш": "sh", "ю": "yu", "а": "a", "б": "b",
  "в": "v", "г": "g", "д": "d", "е": "e", "з": "z", "и": "i", "й": "j",
  "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r",
  "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c", "ъ": "y",
  "ь": "x", "я": "q",
  "Ж": "Zh", "Ч": "Ch", "Щ": "Sht", "Ш": "Sh", "Ю": "Yu", "А": "A", "Б": "B",
  "В": "V", "Г": "G", "Д": "D", "Е": "E", "З": "Z", "И": "I", "Й": "J",
  "К": "K", "Л": "L", "М": "M", "Н": "N", "О": "O", "П": "P", "Р": "R",
  "С": "S", "Т": "T", "У": "U", "Ф": "F", "Х": "H", "Ц": "c", "Ъ": "Y",
  "Ь": "X", "Я": "Q",
};

const EMOJI_CLASS =
  "\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2300}-\\u{23FF}\\u{2B00}-\\u{2BFF}" +
  "\\u{1F1E6}-\\u{1F1FF}\\u{FE00}-\\u{FE0F}\\u{200D}";
const EMOJI_CHAR = new RegExp(`^[${EMOJI_CLASS}]$`, "u");
const EMOJI_ALL = new RegExp(`[${EMOJI_CLASS}]`, "gu");
// Only marks with a nonzero combining class (like Python's unicodedata.combining), not all
// of \p{M}: spacing vowel signs (Devanagari, Thai, …) must survive, as they do in pythanity.
const COMBINING = new RegExp(`[${COMBINING_CLASS}]`, "gu");

function stripMarks(ch: string): string {
  return ch.normalize("NFKD").replace(COMBINING, "");
}

/** Normalize a single character to its ASCII-ish form (may be "" or multi-char). */
function foldChar(ch: string): string {
  const folded = ch in SPECIALS ? SPECIALS[ch]! : stripMarks(ch);
  let out = "";
  for (const c of folded) out += CYR[c] ?? c;
  return out;
}

/** Strip diacritics to ASCII (NFKD + specials). */
export function removeAccents(text: string): string {
  if (!text) return text;
  let out = "";
  for (const ch of text) out += ch in SPECIALS ? SPECIALS[ch]! : stripMarks(ch);
  return out;
}

/** Transliterate Cyrillic to Latin. */
export function cyrToLatin(text: string): string {
  if (!text) return text;
  let out = "";
  for (const ch of text) out += CYR[ch] ?? ch;
  return out;
}

/** Delete emoji / pictographs / variation selectors / ZWJ (keeps ° and punctuation). */
export function removeEmoji(text: string): string {
  if (!text) return text;
  return text.replace(EMOJI_ALL, "");
}

export interface NormalizedText {
  /** The normalized text that rules are matched against. */
  normalized: string;
  /** `indexMap[i]` is the UTF-16 index in the input that produced `normalized[i]`. */
  indexMap: number[];
}

/**
 * Return the normalized text and its index map.
 *
 * Emoji are dropped (produce no normalized chars); folds like `ж` -> `zh` map every
 * produced char back to the single source index. Case is preserved (matching is
 * case-insensitive).
 */
export function normalizeWithMap(text: string): NormalizedText {
  const { normalized, indexMap } = normalizeForMatch(text);
  return { normalized, indexMap: indexMap ?? Array.from(normalized, (_, i) => i) };
}

const NON_ASCII = /[^\x00-\x7f]/;
// Folds of non-ASCII characters, memoized (chat text repeats the same emoji / accents).
const FOLD_CACHE = new Map<string, string>();
const FOLD_CACHE_MAX = 4096;

function cachedFold(ch: string): string {
  let folded = FOLD_CACHE.get(ch);
  if (folded === undefined) {
    folded = EMOJI_CHAR.test(ch) ? "" : foldChar(ch);
    if (FOLD_CACHE.size < FOLD_CACHE_MAX) FOLD_CACHE.set(ch, folded);
  }
  return folded;
}

/**
 * {@link normalizeWithMap} for the matcher's hot path: identical output, but plain-ASCII
 * text (which normalizes to itself) is returned as-is with `indexMap: null` meaning
 * "identity", and ASCII characters inside other text skip the Unicode work.
 * @internal
 */
export function normalizeForMatch(text: string): { normalized: string; indexMap: number[] | null } {
  if (!text) return { normalized: "", indexMap: [] };
  if (!NON_ASCII.test(text)) return { normalized: text, indexMap: null };
  let normalized = "";
  const indexMap: number[] = [];
  for (let i = 0; i < text.length; ) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      normalized += text[i];
      indexMap.push(i);
      i++;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    // Iterate UTF-16 units of the fold so indexMap stays parallel to `normalized`.
    const folded = cachedFold(ch);
    for (let k = 0; k < folded.length; k++) indexMap.push(i);
    normalized += folded;
    i += ch.length;
  }
  return { normalized, indexMap };
}
