#!/usr/bin/env node

import { parseArgs } from "./args.js";
import { run } from "./commands.js";

const args = parseArgs(process.argv.slice(2));
run(args).catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
