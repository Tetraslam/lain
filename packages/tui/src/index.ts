#!/usr/bin/env node

import { createApp } from "./app.js";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("Usage: lain-tui <file.db>");
  process.exit(1);
}

createApp(dbPath).catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
