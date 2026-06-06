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
  run(args)
    .then(() => notifyIfUpdateAvailable(args.command))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}

/** Subtle, fail-silent "update available" nudge printed after a command. */
async function notifyIfUpdateAvailable(command: string): Promise<void> {
  if (command === "update" || command === "version" || command === "help") return;
  try {
    const { checkForUpdate } = await import("@lain/core");
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const status = await checkForUpdate(repoRoot);
    if (status.available) {
      // dim grey, to stderr so it never pollutes piped stdout
      process.stderr.write(`\n\x1b[2m↑ lain ${status.remote} is available — run \x1b[0m\x1b[36mlain update\x1b[0m\n`);
    }
  } catch {
    /* never let an update check break the CLI */
  }
}
