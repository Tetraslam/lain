#!/usr/bin/env node

import { parseArgs } from "./args.js";
import { run } from "./commands.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import * as path from "path";

const args = parseArgs(process.argv.slice(2));

// Intercept TUI and serve commands — these launch separate processes
if (args.command === "tui") {
  const tuiEntry = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../tui/dist/index.js"
  );
  const tuiArgs = args.positional.length > 0 ? args.positional : [];
  const child = spawn("bun", [tuiEntry, ...tuiArgs], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else if (args.command === "serve") {
  const serverEntry = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../web/src/server/index.ts"
  );
  const port = args.flags["port"] || "3001";
  const cwd = args.positional[0] || process.cwd();
  console.log(`Starting lain web server on http://localhost:${port}`);
  console.log(`Serving explorations from: ${cwd}`);
  console.log(`Open http://localhost:${port} in your browser.`);
  const child = spawn("bun", [serverEntry], {
    stdio: "inherit",
    env: { ...process.env, LAIN_PORT: String(port), LAIN_CWD: cwd },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  run(args).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
