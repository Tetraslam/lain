/**
 * Shared helpers for CLI commands.
 */
import * as fs from "fs";
import * as path from "path";
import { createProvider } from "@lain/agents";
import { isLainDb } from "@lain/core";
import type { LainConfig, Provider, Credentials } from "@lain/shared";

/**
 * Find the lain exploration db to operate on, when --db wasn't given.
 *
 * - $LAIN_DB wins if set (explicit, unambiguous).
 * - Otherwise scan `cwd` for *lain* explorations only: skip dotfiles and any
 *   .db that isn't actually a lain db (so unrelated sqlite files like
 *   `.claude-peers.db` are never offered). (issue #2)
 * - One match → use it. Multiple → use the most recently modified and say so
 *   (instead of erroring and forcing --db every time).
 */
export function findDb(cwd = "."): string {
  const envDb = process.env.LAIN_DB;
  if (envDb) {
    if (!fs.existsSync(envDb)) {
      throw new Error(`LAIN_DB points to a missing file: ${envDb}`);
    }
    return envDb;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(cwd);
  } catch {
    entries = [];
  }

  const dbFiles = entries.filter((f) => {
    if (!f.endsWith(".db") || f.startsWith(".")) return false; // skip dotfiles
    try { return fs.statSync(path.join(cwd, f)).isFile(); } catch { return false; }
  });
  const lainDbs = dbFiles.filter((f) => isLainDb(path.join(cwd, f)));

  if (lainDbs.length === 0) {
    if (dbFiles.length > 0) {
      throw new Error(
        `No lain exploration found here (ignored ${dbFiles.length} non-lain .db file(s)). ` +
          `Create one with \`lain "your idea"\`, or specify one with --db <file>.`
      );
    }
    throw new Error("No exploration found here. Create one with `lain \"your idea\"`, or specify --db <file>.");
  }

  if (lainDbs.length === 1) return path.join(cwd, lainDbs[0]);

  // Multiple valid explorations: pick the most recently modified.
  const picked = lainDbs
    .map((f) => ({ f, mtime: fs.statSync(path.join(cwd, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;
  process.stderr.write(
    `Multiple explorations here; using the most recent: ${picked} (override with --db <file> or LAIN_DB)\n`
  );
  return path.join(cwd, picked);
}

/**
 * Create an agent provider from config + credentials.
 */
export function createProviderFromCredentials(
  provider: Provider,
  config: LainConfig,
  credentials: Credentials
) {
  const maxTokens = config.maxTokens;
  switch (provider) {
    case "anthropic":
      return createProvider({
        provider: "anthropic",
        model: config.defaultModel,
        apiKey: credentials.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY,
        maxTokens,
      });

    case "bedrock": {
      const bc = credentials.bedrock;
      return createProvider({
        provider: "bedrock",
        model: config.defaultModel,
        apiKey: bc?.apiKey || process.env.AWS_BEARER_TOKEN_BEDROCK,
        region: bc?.region || process.env.AWS_REGION || "us-west-2",
        maxTokens,
      });
    }

    case "openai":
      return createProvider({
        provider: "openai",
        model: config.defaultModel,
        apiKey: credentials.openai?.apiKey || process.env.OPENAI_API_KEY,
        baseUrl: credentials.openai?.baseUrl || process.env.OPENAI_BASE_URL,
        maxTokens,
      });

    case "openrouter":
      return createProvider({
        provider: "openrouter",
        model: config.defaultModel,
        apiKey: credentials.openrouter?.apiKey || process.env.OPENROUTER_API_KEY,
        baseUrl: credentials.openrouter?.baseUrl,
        maxTokens,
      });

    default:
      return createProvider({
        provider,
        model: config.defaultModel,
        maxTokens,
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
