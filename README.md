# Curse-away

Regex-based, multilingual profanity **detection**, **masking**, and **substitution** for
JavaScript and TypeScript — in Node and in the browser. Import it into any codebase and
pick how you want unsafe text handled. A TypeScript port of Pythanity (curse-away for Python).

## Install

Curse-away is not on npm yet, so install it straight from GitHub.

```bash
# pnpm — pin a release tag (recommended)
pnpm add "github:lemiffe/curse-away#v1.0.1"

# npm
npm install "github:lemiffe/curse-away#v1.0.1"

# optional language auto-detection
pnpm add tinyld
```

Installing from GitHub builds the package on install (via its `prepare` script), so the
first install takes a few seconds. To upgrade, bump the tag and reinstall.

pnpm 10+ only runs build scripts of dependencies you allow, so pnpm projects need this
in their `package.json` (npm needs nothing extra):

```json
"pnpm": { "onlyBuiltDependencies": ["curse-away"] }
```
Once the package is published to npm, a plain `pnpm add curse-away` / `npm install curse-away`
will work.

## Usage

```ts
import { mask, maskFull, safeSubstitute, dropProfanity, containsProfanity } from "curse-away";

mask("that is shit");             // 'that is s**t'   — keep first & last
maskFull("that is shit");         // 'that is ****'   — star everything
safeSubstitute("that is shit");   // 'that is sheet'  — rule's safe word
dropProfanity("that is shit");    // 'that is'        — remove the word
containsProfanity("all clean");   // false
```

Four transforms, one rule list. `safeSubstitute` uses each rule's replacement word;
`mask` / `maskFull` / `dropProfanity` act on the matched span.

CommonJS works too: `const { mask } = require("curse-away");`

### Reuse or customise with a `Filter`

```ts
import { Filter, parseRules } from "curse-away";

const f = new Filter(
  parseRules(["/badword/\tnice"]),  // same line format + anchoring as the bundled lists
  { exceptions: ["trainers"] },     // protect innocent words rules over-match
);
f.mask(text);
f.find(text);                       // Match[] for diagnostics
```

You can also pass `[regex, safeWord]` pairs directly (`new Filter([[/badword/i, "nice"]])`),
but note that JavaScript's own `\b` / `\w` are ASCII-only — `parseRules` gives you
Unicode-aware, letter-only word boundaries (see [Development](#development)). Filters copy
the regexes they are given, so reusing a regex elsewhere (or one from `Match.pattern`)
never affects matching.

### Languages

English is bundled. Every other language is opt-in, so browser bundles only carry the
lists you use:

```ts
import { registerLanguage, mask } from "curse-away";
import { es, fr } from "curse-away/languages";   // or: import { all } ... registerLanguage(...all)

registerLanguage(es, fr);
mask(text);                         // English only (the default)
mask(text, "es");                   // English + Spanish  (shorthand for { lang: "es" })
```

The module-level helpers are **English-only by default**. Every helper (`mask`,
`maskFull`, `safeSubstitute`, `dropProfanity`, `containsProfanity`,
`containsPhoneticProfanity`, `resolveLanguages`) takes an optional second argument —
a language code or `{ multilingual, lang }`:

| Call | Lists applied |
|---|---|
| `mask(text)` | English |
| `mask(text, "es")` / `mask(text, { lang: "es" })` | English + Spanish |
| `mask(text, { multilingual: true })` | English + the auto-detected language (if registered) |
| `mask(text, { multilingual: false, lang: "es" })` | English (multilingual forced off) |

English always stays on, since English swears leak into every language.

### Language auto-detection

With `multilingual: true` (and no `lang`), the helpers detect the text's language and add
its list, if registered. Detection uses [tinyld](https://github.com/komodojp/tinyld), an
optional peer dependency:

```ts
import { mask, setLanguageDetector } from "curse-away";
import { tinyldDetector } from "curse-away/detect";        // ~600 KB, more accurate
// import { tinyldDetector } from "curse-away/detect-light"; // ~70 KB, for browsers

setLanguageDetector(tinyldDetector);
mask(text, { multilingual: true });
```

Or pass any `(text) => languageCode | null` function of your own. Without
`multilingual: true` the detector is never called.

## How matching works

Text is normalized (accents, emoji, Cyrillic look-alikes) **only to find matches**, and
rules tolerate leetspeak and separators (`b.a.d`, `b4d`) — every transform is applied back
to the *original* text via span-mapping, so your casing, accents and emoji survive
everywhere except inside a match. Normalization and matching mirror pythanity exactly, so
both libraries flag the same spans.

## Performance

Built for high-volume traffic such as chat. On a chat-like stream (mostly 2–10 words, 20%
at 30–40 words, ~10% containing profanity), Node 24 / V8:

| Filter | Throughput | Latency p50 / p90 / p99 |
|---|---|---|
| English | ~30,000 msg/s | ~11 µs / ~70 µs / ~290 µs |
| English + one language | ~24,000 msg/s | |

How: rules are combined into prefilter regexes (with their shared word-boundary
lookarounds factored out), so a clean message is cleared by **one** regex test instead of
one scan per rule; only rules whose bucket matches are scanned individually. Plain-ASCII
text skips normalization, and recent results are cached (`cacheSize`, default 512 texts).
Results are identical to a plain rule-by-rule scan (and to pythanity).

Tips for web clients:

- **Warm up** at start-up, e.g. `requestIdleCallback(() => getFilter("en").warmUp())`.
  V8 compiles regexes lazily: the first message otherwise costs ~0.15 s, the next few a
  few ms; after `warmUp()` (≈0.3 s, off the critical path) the first message costs ~13 ms.
- **Pass `lang`** when you already know it (per user / room) instead of
  `{ multilingual: true }`: detection (~0.3 ms per message with tinyld) costs far more than
  filtering. If you do auto-detect, skip short messages:
  `setLanguageDetector(tinyldDetector, { minLength: 30 })`.
- **Register only the languages you need.** Filtering against all 28 lists at once is
  ~20x slower than English alone.
- Very busy UIs can run the filter in a Web Worker to keep the main thread free.
- `pnpm bench` (in this repo) measures throughput on your machine.

## Compatibility

- **Node** 18+ (ESM `import` and CommonJS `require` both work).
- **Browsers**: any engine with RegExp lookbehind and Unicode property escapes — Chrome/Edge
  62+, Firefox 78+, Safari 16.4+. Library entries use no Node APIs.
- **Bundlers**: ESM, tree-shakable (`sideEffects: false`); unused languages are dropped.
- Registered languages and the language detector are per module instance. Use either the
  ESM or the CommonJS build within one app — if both get loaded, register in each.

## Detection

- `containsProfanity(text)` — any rule matches.
- `containsPhoneticProfanity(text)` — Double-Metaphone check for sound-alike evasions.

## Development

```bash
Install dependencies:
pnpm install

Run a test on a sentence:
pnpm check:text "phrase with profanity"

Run a test on a file:
pnpm check:text --file path/to/file.txt

Run test suite:
pnpm test

Type-check / build (ESM + CJS + .d.ts into dist/):
pnpm typecheck
pnpm build

Benchmark chat-style throughput (--op mask|maskFull|safeSubstitute|dropProfanity|containsProfanity|find):
pnpm bench
```

The diagnostic is also installed as a bin for projects that depend on curse-away:
`npx curse-away-check "phrase"` / `npx curse-away-check --file path/to/file.txt`.

Word lists live in `data/` (`profanity-<lang>.txt`, `exceptions-<lang>.txt`) and are
compiled into `src/data/*.ts` + `src/languages.ts` by `pnpm gen:data`, which `build`,
`test` and `typecheck` run automatically. `pnpm import:ldnoobw` regenerates the
non-English lists from LDNOOBW (English is hand-curated and never overwritten).

Rules are `/regex/<TAB>safe word` lines; exceptions are one phrase per line.
Each rule is automatically anchored to whole words using letter-only boundaries, so it never
matches inside a longer word ("glass") but still catches `word123`, `_word_` or a leading
symbol like `@`. Prefix a rule with `~` (`~/regex/<TAB>safe word`) to let it match inside
words, e.g. for compounds. A rule's own outer `\b` is upgraded to these boundaries; rules
starting with `^` or a lookbehind are left as-is. Rules use Python-flavoured regex shared
with pythanity; Python-only constructs (possessive quantifiers like `?+`, `(?P<…>)` groups,
`\A`/`\Z`, bare literal braces) are translated to JavaScript automatically, and `\w`, `\d`,
`\b` keep Python's Unicode meaning. `src/combining.ts` (which combining marks normalization
strips) is generated from Python's Unicode tables by `python scripts/gen-combining.py`.
`tests/corpora.test.ts` runs the rules over clean corpora to catch false positives and over a
base64-encoded dirty corpus to catch misses — extend the corpora before shipping rule changes.
