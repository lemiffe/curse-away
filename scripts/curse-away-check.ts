/**
 * Dev entry for the diagnostic CLI (runs from source via tsx):
 *
 *   pnpm check:text "some text to check"
 *   pnpm check:text --file path/to/text.txt
 */

import { main } from "../src/cli.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
