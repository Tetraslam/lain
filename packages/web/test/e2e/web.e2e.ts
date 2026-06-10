#!/usr/bin/env bun
//
// Headless web E2E for the lain web UI.
//
//   bun packages/web/test/e2e/web.e2e.ts
//
// By default it builds a tiny fixture .db (no API key needed — just Storage),
// spawns the source server against it, and drives a headless Chromium through
// the core flows (home renders, exploration lists, settings modal, no console
// errors). Set LAIN_E2E_URL to point at an already-running server instead
// (e.g. the compiled binary's `lain serve`), in which case it won't spawn one.
//
import { chromium } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { Storage, Graph } from "@lain/core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_NAME = "fixture: testing the web ui";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

function buildFixtureDb(dir: string): void {
  const s = new Storage(path.join(dir, "fixture.db"));
  const g = new Graph(s);
  g.createExploration({
    id: "fixture01", name: FIXTURE_NAME, seed: FIXTURE_NAME,
    n: 2, m: 1, strategy: "bf", planDetail: "sentence", extension: "freeform",
  });
  s.close();
}

async function waitForServer(url: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

async function main() {
  const externalUrl = process.env.LAIN_E2E_URL;
  let proc: ChildProcess | undefined;
  let baseUrl = externalUrl ?? "";
  let workspace = "";

  if (!externalUrl) {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lain-e2e-"));
    buildFixtureDb(workspace);
    const port = 3100 + Math.floor(Math.random() * 600);
    baseUrl = `http://localhost:${port}`;
    const serverEntry = path.resolve(HERE, "../../src/server/index.ts");
    proc = spawn("bun", [serverEntry], {
      env: { ...process.env, LAIN_PORT: String(port), LAIN_CWD: workspace },
      stdio: "ignore",
    });
    await waitForServer(`${baseUrl}/api/explorations`);
  }
  console.log(`web E2E → ${baseUrl}${externalUrl ? " (external)" : " (self-spawned)"}`);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    // ---- Home renders (React actually hydrates, not just served HTML) ----
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForSelector("#root > *", { timeout: 10000 });
    check("document title is 'lain'", (await page.title()) === "lain");
    const h1 = (await page.textContent("h1"))?.toLowerCase() ?? "";
    check("brand <h1> renders 'lain'", h1.includes("lain"), `got "${h1}"`);

    // ---- Exploration discovery (list or empty state) ----
    const cards = await page.$$eval(".card-title", (els) => els.map((e) => e.textContent ?? ""));
    if (!externalUrl) {
      check("fixture exploration is listed", cards.some((c) => c.includes("fixture")), cards.join(", "));
    } else {
      const hasEmpty = (await page.$(".home-empty")) !== null;
      check("home shows a list or empty state", cards.length > 0 || hasEmpty);
    }

    // ---- Settings modal opens (',' shortcut) + renders the schema ----
    await page.keyboard.press(",");
    await page.waitForSelector(".modal-content", { timeout: 5000 });
    await page.waitForSelector(".setting-row", { timeout: 5000 });
    const modalText = (await page.textContent(".modal-content")) ?? "";
    check("settings modal renders provider/model fields", /provider/i.test(modalText));
    await page.keyboard.press("Escape");

    // ---- No console / page errors (ignore favicon noise) ----
    const realErrors = consoleErrors.filter((e) => !/favicon|404/i.test(e));
    check("no console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    proc?.kill("SIGTERM");
  }

  if (failures > 0) { console.error(`\n✗ web E2E: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✓ web E2E passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
