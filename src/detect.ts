/**
 * Optional language detection, backed by `tinyld` (install it alongside curse-away:
 * `pnpm add tinyld`). Works in Node and the browser. For smaller browser bundles
 * use `curse-away/detect-light` (tinyld light model, ~70 KB vs ~600 KB).
 *
 *   import { setLanguageDetector } from "curse-away";
 *   import { tinyldDetector } from "curse-away/detect";
 *   setLanguageDetector(tinyldDetector);
 *
 * Detected languages only take effect when their list is registered
 * (see `curse-away/languages`). This module deliberately holds no state of its own.
 */

import { detect } from "tinyld";

import type { LanguageDetector } from "./types.js";

/** Bare ISO-639-1 code for `text` (`"es"`), or `null` when tinyld is unsure. */
export const tinyldDetector: LanguageDetector = (text) => {
  const code = detect(text);
  return code ? code : null;
};
