/**
 * @lain/shared — config loading and credential management.
 *
 * Single source of truth for config/credential loading, used by CLI, TUI, and web server.
 * Resolves: global (~/.config/lain/) > workspace (.lain/) > built-in defaults.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { LainConfig, Provider } from "./index.js";
import { DEFAULT_CONFIG } from "./index.js";

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".config", "lain");
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "config.json");
const GLOBAL_CREDENTIALS_FILE = path.join(GLOBAL_CONFIG_DIR, "credentials.json");

// ============================================================================
// Types
// ============================================================================

export interface Credentials {
  anthropic?: { apiKey: string };
  bedrock?: { apiKey: string; region: string };
  openai?: { apiKey: string; baseUrl?: string };
  openrouter?: { apiKey: string; baseUrl?: string };
}

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Load merged config from global > workspace > defaults.
 */
export function loadConfig(cwd?: string): LainConfig {
  let config = { ...DEFAULT_CONFIG } as Record<string, unknown>;

  // Global config
  if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
    try {
      const globalRaw = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_FILE, "utf-8"));
      config = deepMerge(config, globalRaw);
    } catch {
      // Ignore corrupt config
    }
  }

  // Workspace config (walk up to find .lain/)
  const workspaceConfig = findWorkspaceConfig(cwd || process.cwd());
  if (workspaceConfig) {
    try {
      const wsRaw = JSON.parse(fs.readFileSync(workspaceConfig, "utf-8"));
      config = deepMerge(config, wsRaw);
    } catch {
      // Ignore corrupt config
    }
  }

  return config as unknown as LainConfig;
}

/**
 * Load credentials from ~/.config/lain/credentials.json.
 */
export function loadCredentials(): Credentials {
  if (!fs.existsSync(GLOBAL_CREDENTIALS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(GLOBAL_CREDENTIALS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

// ============================================================================
// Config Saving
// ============================================================================

export function saveConfig(config: Partial<LainConfig>): void {
  fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_FILE, "utf-8"));
    } catch {
      // Start fresh
    }
  }

  const merged = deepMerge(existing, config as Record<string, unknown>);
  fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n");
}

export function saveCredentials(credentials: Partial<Credentials>): void {
  fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });

  let existing: Credentials = {};
  if (fs.existsSync(GLOBAL_CREDENTIALS_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(GLOBAL_CREDENTIALS_FILE, "utf-8"));
    } catch {
      // Start fresh
    }
  }

  const merged = { ...existing, ...credentials };
  fs.writeFileSync(GLOBAL_CREDENTIALS_FILE, JSON.stringify(merged, null, 2) + "\n");
}

export function saveWorkspaceConfig(dir: string, config: Partial<LainConfig>): void {
  const lainDir = path.join(dir, ".lain");
  fs.mkdirSync(lainDir, { recursive: true });
  fs.writeFileSync(path.join(lainDir, "config.json"), JSON.stringify(config, null, 2) + "\n");
}

export function configExists(): boolean {
  return fs.existsSync(GLOBAL_CONFIG_FILE);
}

/**
 * Remove a single MCP server from the global config. This needs its own path
 * because saveConfig() deep-merges — re-saving the map minus a key would never
 * actually drop it. Deletes the exact key (handles names with dots). No-op if
 * absent.
 */
export function removeMcpServer(name: string): void {
  if (!fs.existsSync(GLOBAL_CONFIG_FILE)) return;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_FILE, "utf-8")); } catch { return; }
  const servers = obj.mcpServers;
  if (servers && typeof servers === "object") delete (servers as Record<string, unknown>)[name];
  fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(obj, null, 2) + "\n");
}

/** Delete a dotted path from a JSON file in place (no-op if absent or corrupt). */
function deletePathInFile(file: string, dotted: string): void {
  if (!fs.existsSync(file)) return;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return;
  }
  const parts = dotted.split(".");
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return;
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === "object") delete cur[parts[parts.length - 1]];
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

/** Remove a config key (global or workspace). */
export function unsetConfigPath(dotted: string, opts: { scope?: "global" | "workspace"; cwd?: string } = {}): void {
  const file = opts.scope === "workspace"
    ? path.join(opts.cwd || process.cwd(), ".lain", "config.json")
    : GLOBAL_CONFIG_FILE;
  deletePathInFile(file, dotted);
}

/** Remove a credentials key (always global). */
export function unsetCredentialPath(dotted: string): void {
  deletePathInFile(GLOBAL_CREDENTIALS_FILE, dotted);
}

/** Absolute paths of the config/credential files (for `config path` / settings UIs). */
export function configPaths(cwd?: string): { global: string; workspace: string | null; credentials: string } {
  return {
    global: GLOBAL_CONFIG_FILE,
    workspace: findWorkspaceConfig(cwd || process.cwd()),
    credentials: GLOBAL_CREDENTIALS_FILE,
  };
}

// ============================================================================
// Utilities
// ============================================================================

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

function findWorkspaceConfig(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, ".lain", "config.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached root
    dir = parent;
  }
}

export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
