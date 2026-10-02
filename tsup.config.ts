import { readFileSync } from "node:fs";

import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const define = { __VERSION__: JSON.stringify(version) };

export default defineConfig([
  {
    // Library entries: ESM + CJS + type declarations, usable in Node and browsers.
    entry: {
      index: "src/index.ts",
      languages: "src/languages.ts",
      detect: "src/detect.ts",
      "detect-light": "src/detect-light.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    target: "es2020",
    platform: "neutral",
    treeshake: true,
    define,
    // double-metaphone is ESM-only; bundle it so the CJS build works too.
    noExternal: ["double-metaphone"],
    external: ["tinyld", "tinyld/light"],
  },
  {
    // `curse-away-check` CLI (Node only).
    entry: { cli: "src/bin.ts" },
    format: ["cjs"],
    target: "node18",
    platform: "node",
    noExternal: ["double-metaphone"],
    external: ["tinyld"],
    banner: { js: "#!/usr/bin/env node" },
    define,
  },
]);
