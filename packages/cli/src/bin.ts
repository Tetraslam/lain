#!/usr/bin/env bun
//
// Single-binary entry point for `lain` (compiled with `bun build --compile`).
//
// Unlike src/index.ts (the source/dev entry, which spawns `bun` on the TUI/web
// source files), this entry statically imports every surface so they're all
// bundled into one self-contained executable — no `bun`, no node_modules, no
// dist on disk. The build script (scripts/build-binary.ts) compiles THIS file.
//
import { parseArgs } from "./args.js";
import { run } from "./commands.js";

const args = parseArgs(process.argv.slice(2));

async function main(): Promise<void> {
  if (args.command === "tui") {
    const { createApp } = await import("@lain/tui");
    await createApp(args.positional[0]);
    return;
  }

  if (args.command === "serve") {
    const { startServer } = await import("@lain/web/server");
    const { EMBEDDED_CLIENT } = await import("@lain/web/embedded");
    const port = Number(args.flags["port"]) || 3001;
    const cwd = args.positional[0] || process.cwd();
    console.log(`Starting lain web server on http://localhost:${port}`);
    console.log(`Serving explorations from: ${cwd}`);
    console.log(`Open http://localhost:${port} in your browser.`);
    startServer({ port, cwd, clientHtml: EMBEDDED_CLIENT });
    return; // Bun.serve keeps the process alive
  }

  await run(args);
}

main().catch((err: any) => {
  console.error(`Error: ${err?.message ?? err}`);
  process.exit(1);
});
