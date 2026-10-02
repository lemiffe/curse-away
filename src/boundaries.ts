// Letter-only word boundaries shared by rule parsing (rules.ts) and the prefilter (filter.ts).
//
// \p{L} = any Unicode letter. Unlike \b these still match when the term touches a digit,
// underscore or leading symbol ("word123", "_word_", "@ss"), while refusing matches inside a
// longer word ("glass", "skyscraper"). JS's own \b is ASCII-only, so it would also break on
// accented or non-Latin text. The second lookbehind refuses to start right after a
// contraction ("isn't it", "we're"), so a separator-tolerant rule can't bridge from the
// contraction's tail into the next word.
export const LEFT = "(?<!\\p{L})(?<!\\p{L}['\\u2019])";
export const RIGHT = "(?!\\p{L})";

// Python's `\w` (Unicode word character) as translated by toJsPattern: JS's own \w is ASCII-only.
export const WORD_CLASS = "[\\p{L}\\p{N}_]";
