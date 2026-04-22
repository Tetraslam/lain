/**
 * Shared helpers for CLI commands.
 */
import * as fs from "fs";
import { createProvider } from "@lain/agents";
import type { LainConfig, Provider, Credentials } from "@lain/shared";

/**
 * Find a .db file in the current directory.
 */
export function findDb(): string {
  const files = fs.readdirSync(".").filter((f) => f.endsWith(".db"));
  if (files.length === 0) {
    throw new Error(
      "No .db file found in current directory. Specify one with --db <file>."
    );
  }
  if (files.length === 1) return files[0];
  throw new Error(
    `Multiple .db files found: ${files.join(", ")}. Specify one with --db <file>.`
  );
}

/**
 * Create an agent provider from config + credentials.
 */
export function createProviderFromCredentials(
  provider: Provider,
  config: LainConfig,
  credentials: Credentials
) {
  switch (provider) {
    case "anthropic":
      return createProvider({
        provider: "anthropic",
        model: config.defaultModel,
        apiKey: credentials.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY,
      });

    case "bedrock": {
      const bc = credentials.bedrock;
      return createProvider({
        provider: "bedrock",
        model: config.defaultModel,
        apiKey: bc?.apiKey || process.env.AWS_BEARER_TOKEN_BEDROCK,
        region: bc?.region || process.env.AWS_REGION || "us-west-2",
      });
    }

    case "openai":
      return createProvider({
        provider: "openai",
        model: config.defaultModel,
        apiKey: credentials.openai?.apiKey || process.env.OPENAI_API_KEY,
      });

    default:
      return createProvider({
        provider,
        model: config.defaultModel,
      });
  }
}

/**
 * Truncate a string for display.
 */
export function truncateStr(s: string, max: number): string {
  const oneLine = s.replace(/\n/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "..." : oneLine;
}
