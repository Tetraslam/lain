#!/usr/bin/env bun

import { createApp } from "./app.js";

// DB path is optional — the app will discover it automatically
const dbPath = process.argv[2];

createApp(dbPath).catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
