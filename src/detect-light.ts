/**
 * Optional, lightweight language detection backed by `tinyld/light` (~70 KB; use
 * `curse-away/detect` for the more accurate ~600 KB model). Install tinyld alongside
 * curse-away: `pnpm add tinyld`. Works in Node and the browser.
 *
 *   import { setLanguageDetector } from "curse-away";
 *   import { tinyldDetector } from "curse-away/detect-light";
 *   setLanguageDetector(tinyldDetector);
 *
 * Detected languages only take effect when their list is registered
 * (see `curse-away/languages`). This module deliberately holds no state of its own.
 */

import { detect } from "tinyld/light";

import type { LanguageDetector } from "./types.js";

/** Bare ISO-639-1 code for `text` (`"es"`), or `null` when tinyld is unsure. */
export const tinyldDetector: LanguageDetector = (text) => {
  const code = detect(text);
  return code ? code : null;
};
