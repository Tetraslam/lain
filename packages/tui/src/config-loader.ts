/**
 * Config loader for TUI — reuses the CLI config format.
 * Reads ~/.config/lain/config.json and credentials.json.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createProvider } from "@lain/agents";
import { DEFAULT_CONFIG, type LainConfig, type Provider, type AgentProvider } from "@lain/shared";

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".config", "lain");
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "config.json");
const GLOBAL_CREDENTIALS_FILE = path.join(GLOBAL_CONFIG_DIR, "credentials.json");

interface Credentials {
  anthropic?: { apiKey: string };
  bedrock?: { apiKey: string; region: string };
  openai?: { apiKey: string; baseUrl?: string };
}

export function loadConfig(): LainConfig {
  let config = { ...DEFAULT_CONFIG };
  if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_FILE, "utf-8"));
      config = { ...config, ...raw };
    } catch {}
  }
  // Walk up for workspace config
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, ".lain", "config.json");
    if (fs.existsSync(candidate)) {
      try {
        const raw = JSON.parse(fs.readFileSync(candidate, "utf-8"));
        config = { ...config, ...raw };
      } catch {}
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return config;
}

export function loadCredentials(): Credentials {
  if (!fs.existsSync(GLOBAL_CREDENTIALS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(GLOBAL_CREDENTIALS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function createProviderFromCredentials(config: LainConfig, credentials: Credentials): AgentProvider {
  const provider = config.defaultProvider;
  switch (provider) {
    case "anthropic":
      return createProvider({
        provider: "anthropic",
        model: config.defaultModel,
        apiKey: credentials.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY,
      });
    case "bedrock":
      return createProvider({
        provider: "bedrock",
        model: config.defaultModel,
        apiKey: credentials.bedrock?.apiKey || process.env.AWS_BEARER_TOKEN_BEDROCK,
        region: credentials.bedrock?.region || process.env.AWS_REGION || "us-west-2",
      });
    case "openai":
      return createProvider({
        provider: "openai",
        model: config.defaultModel,
        apiKey: credentials.openai?.apiKey || process.env.OPENAI_API_KEY,
      });
    default:
      return createProvider({ provider, model: config.defaultModel });
  }
}
