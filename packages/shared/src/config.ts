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
