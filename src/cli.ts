/**
 * Diagnostic CLI: trace curse-away filtering for a string or a file.
 *
 *   npx curse-away-check "some text to check"
 *   npx curse-away-check --file path/to/text.txt
 *
 * (in this repo: `pnpm check:text "some text"` / `pnpm check:text --file path.txt`)
 *
 * Shows the detected language and the lists applied, all four transforms, the matched
 * spans (with the rule that fired), and finally any phonetic (sound-alike) profanity.
 * All bundled languages are loaded; language detection is used when `tinyld` is installed.
 */

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import {
  availableLanguages,
  detectLanguage,
  getFilter,
  registerLanguage,
  resolveLanguages,
  setLanguageDetector,
} from "./index.js";
import { all } from "./languages.js";

const USAGE = 'usage: curse-away-check "text to check" | --file <path>';

async function enableDetection(): Promise<void> {
  try {
    const { tinyldDetector } = await import("./detect.js");
    setLanguageDetector(tinyldDetector);
  } catch {
    // tinyld not installed: English (+ explicit languages) only.
  }
}

export function buildReport(text: string): string {
  const detected = detectLanguage(text);
  const langs = resolveLanguages(text, { multilingual: true }); // the diagnostic always detects
  const f = getFilter(...langs);
  const lists = langs.map((l) => `profanity-${l}.txt`);

  // Time the full filtering pass (find + phonetic + all four transforms).
  const t0 = performance.now();
  const matches = f.find(text);
  const phon = f.phoneticHits(text);
  const masked = f.mask(text);
  const maskedFull = f.maskFull(text);
  const substituted = f.safeSubstitute(text);
  const dropped = f.dropProfanity(text);
  const elapsedMs = performance.now() - t0;

  const out: string[] = [];
  out.push(`detected language : ${detected ?? "(none - defaulting to en)"}`);
  out.push(`languages applied : ${langs.join(", ")}`);
  out.push(`lists loaded      : ${lists.join(", ")}  (${availableLanguages().length} registered)`);
  out.push(
    `processed in      : ${elapsedMs.toFixed(2)} ms  (${text.length} chars, ` +
      "find + phonetic + 4 transforms)",
  );

  out.push("");
  out.push(`matches (${matches.length}):`);
  for (const m of matches) {
    out.push(`  '${m.text}' [${m.start}:${m.end}] -> safe '${m.safe}'   /${m.pattern.source}/`);
  }

  if (phon.length) {
    out.push("");
    out.push(`matched phonetic profanity: ${phon.join(", ")}`);
  }

  out.push("");
  out.push(`original        : ${text}\n`);
  out.push(`mask            : ${masked}\n`);
  out.push(`maskFull        : ${maskedFull}\n`);
  out.push(`safeSubstitute  : ${substituted}\n`);
  out.push(`dropProfanity   : ${dropped}`);
  return out.join("\n");
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "-h" || argv[0] === "--help") {
    console.log(USAGE);
    return 0;
  }
  let text: string;
  if (argv[0] === "-f" || argv[0] === "--file") {
    if (!argv[1]) {
      console.error(USAGE);
      return 2;
    }
    try {
      text = readFileSync(argv[1], "utf8");
    } catch (err) {
      console.error(`curse-away-check: cannot read ${argv[1]}: ${(err as Error).message}`);
      return 1;
    }
  } else if (argv.length > 0) {
    text = argv.join(" "); // unquoted multi-word input is fine too
  } else {
    console.error(USAGE);
    return 2;
  }
  registerLanguage(...all);
  await enableDetection();
  console.log(buildReport(text));
  return 0;
}

