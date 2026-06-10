// Integration tests for the web API — the HTTP surface of config, tools, and
// MCP. The server is spawned in a sandboxed HOME (it captures ~/.config/lain at
// import) against a temp workspace holding a fixture .db, so these verify the
// real read/write paths without touching the developer's config.
import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Storage, Graph } from "@lain/core";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/server/index.ts");

let home: string;
let work: string;
let proc: ReturnType<typeof Bun.spawn>;
let base: string;

const api = (p: string, init?: RequestInit) => fetch(`${base}${p}`, init);
const putJson = (p: string, body: unknown) =>
  api(p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const postJson = (p: string, body: unknown) =>
  api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lain-api-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "lain-api-work-"));
  const s = new Storage(path.join(work, "fixture.db"));
  new Graph(s).createExploration({
    id: "apifix01", name: "api fixture exploration", seed: "seed",
    n: 2, m: 1, strategy: "bf", planDetail: "sentence", extension: "freeform",
  });
  s.close();

  const port = 3700 + Math.floor(Math.random() * 500);
  base = `http://localhost:${port}`;
  proc = Bun.spawn(["bun", SERVER], {
    env: { ...process.env, HOME: home, LAIN_PORT: String(port), LAIN_CWD: work },
    stdout: "ignore", stderr: "ignore",
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await api("/api/explorations")).ok) break; } catch {}
    await Bun.sleep(200);
  }
});

afterAll(() => {
  proc?.kill();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

const globalConfig = () => JSON.parse(fs.readFileSync(path.join(home, ".config/lain/config.json"), "utf-8"));
const globalCreds = () => JSON.parse(fs.readFileSync(path.join(home, ".config/lain/credentials.json"), "utf-8"));
const fieldValue = (view: any, key: string) => view.fields.find((f: any) => f.key === key);

test("GET /api/explorations discovers the workspace db", async () => {
  const dbs = await (await api("/api/explorations")).json();
  const fixture = dbs.find((d: any) => d.name === "fixture.db");
  expect(fixture).toBeTruthy();
  expect(fixture.explorations[0].name).toBe("api fixture exploration");
});

test("GET /api/config returns the schema view + sandboxed paths", async () => {
  const view = await (await api("/api/config")).json();
  expect(Array.isArray(view.fields)).toBe(true);
  expect(Array.isArray(view.sections)).toBe(true);
  expect(view.paths.global).toBe(path.join(home, ".config/lain/config.json"));
});

test("PUT /api/config persists a value and reflects it on read", async () => {
  const res = await (await putJson("/api/config", { updates: [{ key: "defaultModel", value: "web-set-model" }], scope: "global" })).json();
  expect(res.applied).toContain("defaultModel");
  expect(res.errors.length).toBe(0);
  expect(globalConfig().defaultModel).toBe("web-set-model");
  expect(fieldValue(await (await api("/api/config")).json(), "defaultModel").value).toBe("web-set-model");
});

test("PUT /api/config routes secrets to credentials + redacts on read", async () => {
  await putJson("/api/config", { updates: [{ key: "credentials.openai.apiKey", value: "sk-web-secret" }] });
  expect(globalCreds().openai.apiKey).toBe("sk-web-secret");
  const field = fieldValue(await (await api("/api/config")).json(), "credentials.openai.apiKey");
  expect(field.isSet).toBe(true);
  expect(field.value).toBe(""); // never leaked over the wire
});

test("PUT /api/config rejects invalid values", async () => {
  const res = await (await putJson("/api/config", { updates: [{ key: "defaultProvider", value: "not-a-provider" }] })).json();
  expect(res.errors.length).toBeGreaterThan(0);
  expect(res.applied).not.toContain("defaultProvider");
});

test("GET /api/tools returns a catalog + selection", async () => {
  const t = await (await api("/api/tools")).json();
  expect(Array.isArray(t.catalog?.groups ?? t.catalog)).toBe(true);
  expect(t.selection).toBeTruthy();
});

test("POST/GET/DELETE /api/mcp manages servers", async () => {
  // Refused-fast localhost URL so the probe fails immediately (no network wait).
  const add = await (await postJson("/api/mcp", { name: "probe-test", url: "http://127.0.0.1:1/mcp" })).json();
  expect(add.server).toBe("probe-test");
  expect(globalConfig().mcpServers["probe-test"].url).toBe("http://127.0.0.1:1/mcp");

  const list = await (await api("/api/mcp")).json();
  expect(list.servers["probe-test"]).toBeTruthy();

  await api("/api/mcp", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "probe-test" }) });
  const after = await (await api("/api/mcp")).json();
  expect(after.servers["probe-test"]).toBeUndefined();
});
