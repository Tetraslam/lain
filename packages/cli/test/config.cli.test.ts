// Integration tests for `lain config` — the CLI surface of the settings system.
//
// These spawn the real CLI in a sandboxed HOME so they exercise the full path
// (parse → applySettings → config/credentials files on disk → read back) and,
// crucially, verify the config hierarchy (workspace overrides global) and that
// secrets are routed to credentials.json and redacted on read. Subprocess +
// temp HOME is deliberate: the config module captures ~/.config/lain at import,
// so an in-process test would clobber the developer's real config.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts");

let home: string;
let work: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lain-cfg-home-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "lain-cfg-work-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

function lain(args: string[], cwd = work) {
  const r = spawnSync("bun", [CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home, NO_COLOR: "1" },
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

const globalConfig = () => JSON.parse(fs.readFileSync(path.join(home, ".config/lain/config.json"), "utf-8"));
const globalCreds = () => JSON.parse(fs.readFileSync(path.join(home, ".config/lain/credentials.json"), "utf-8"));

describe("lain config", () => {
  it("reports the resolved config paths under the sandbox HOME", () => {
    const { code, out } = lain(["config", "path", "--json"]);
    expect(code).toBe(0);
    const paths = JSON.parse(out);
    expect(paths.global).toBe(path.join(home, ".config/lain/config.json"));
    expect(paths.credentials).toBe(path.join(home, ".config/lain/credentials.json"));
  });

  it("round-trips a config value (set → file → get)", () => {
    expect(lain(["config", "set", "defaultModel", "my-model-x"]).code).toBe(0);
    expect(globalConfig().defaultModel).toBe("my-model-x");
    expect(lain(["config", "get", "defaultModel", "--json"]).out).toBe(JSON.stringify("my-model-x"));
  });

  it("coerces numbers and rejects out-of-spec values", () => {
    expect(lain(["config", "set", "concurrency", "4"]).code).toBe(0);
    expect(globalConfig().concurrency).toBe(4); // stored as a number, not "4"
    expect(typeof globalConfig().concurrency).toBe("number");

    const bad = lain(["config", "set", "concurrency", "not-a-number"]);
    expect(bad.code).not.toBe(0);
    expect(bad.err.toLowerCase()).toContain("invalid");
  });

  it("validates select fields against their options", () => {
    expect(lain(["config", "set", "defaultProvider", "openai"]).code).toBe(0);
    expect(globalConfig().defaultProvider).toBe("openai");
    const bad = lain(["config", "set", "defaultProvider", "not-a-provider"]);
    expect(bad.code).not.toBe(0);
  });

  it("rejects unknown keys", () => {
    const r = lain(["config", "set", "totallyMadeUp", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.err.toLowerCase()).toContain("unknown setting");
  });

  it("routes secrets to credentials.json and redacts them on read", () => {
    expect(lain(["config", "set", "credentials.openai.apiKey", "sk-secret-123"]).code).toBe(0);
    // Secret must land in credentials.json, never in config.json.
    expect(globalCreds().openai.apiKey).toBe("sk-secret-123");
    const cfgPath = path.join(home, ".config/lain/config.json");
    if (fs.existsSync(cfgPath)) expect(fs.readFileSync(cfgPath, "utf-8")).not.toContain("sk-secret-123");
    // And reading it back is redacted.
    expect(lain(["config", "get", "credentials.openai.apiKey", "--json"]).out).toBe(JSON.stringify("***set***"));
  });

  it("honors the config hierarchy: workspace overrides global", () => {
    lain(["config", "set", "defaultModel", "global-model"]);
    lain(["config", "set", "defaultModel", "workspace-model", "--local"]);
    // Workspace file written under cwd/.lain, global untouched.
    expect(JSON.parse(fs.readFileSync(path.join(work, ".lain/config.json"), "utf-8")).defaultModel).toBe("workspace-model");
    expect(globalConfig().defaultModel).toBe("global-model");
    // Reading from the workspace cwd resolves to the workspace value.
    expect(lain(["config", "get", "defaultModel", "--json"], work).out).toBe(JSON.stringify("workspace-model"));
    // Reading from a different cwd (no workspace) falls back to global.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "lain-elsewhere-"));
    expect(lain(["config", "get", "defaultModel", "--json"], elsewhere).out).toBe(JSON.stringify("global-model"));
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it("unsets a value back to its default", () => {
    lain(["config", "set", "defaultModel", "temp-model"]);
    expect(globalConfig().defaultModel).toBe("temp-model");
    expect(lain(["config", "unset", "defaultModel"]).code).toBe(0);
    expect(globalConfig().defaultModel ?? undefined).toBeUndefined();
  });

  it("adds and removes MCP servers — remove must actually drop the key", () => {
    lain(["config", "set", "defaultProvider", "openai"]); // create config so `mcp` doesn't auto-init
    expect(lain(["mcp", "add", "srv", "https://example.com/mcp"]).code).toBe(0);
    expect(globalConfig().mcpServers.srv.url).toBe("https://example.com/mcp");
    expect(lain(["mcp", "list"]).out).toContain("srv");
    expect(lain(["mcp", "remove", "srv"]).code).toBe(0);
    // Regression guard: a deep-merge save would leave the key behind.
    expect(globalConfig().mcpServers?.srv).toBeUndefined();
  });

  it("lists all settings as JSON with secrets masked", () => {
    lain(["config", "set", "credentials.openai.apiKey", "sk-zzz"]);
    const { code, out } = lain(["config", "list", "--json"]);
    expect(code).toBe(0);
    const all = JSON.parse(out);
    expect(all).toHaveProperty("defaultProvider");
    expect(all["credentials.openai.apiKey"]).toBe("***set***");
  });
});
