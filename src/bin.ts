// Entry point for the `curse-away-check` bin (see ./cli.ts).
import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
