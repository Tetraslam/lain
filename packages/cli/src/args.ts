import type { Strategy, PlanDetail, Provider } from "@lain/shared";

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

/**
 * Minimal arg parser. Supports:
 *   lain "seed text" --branches 5 --depth 3
 *   lain explore --seed file.md --n 4 --m 6
 *   lain status
 *   lain init --non-interactive --provider anthropic --api-key sk-...
 *   etc.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  let command = "";

  const commands = new Set([
    "explore",
    "interactive",
    "init",
    "status",
    "show",
    "tree",
    "prune",
    "extend",
    "redirect",
    "link",
    "synthesize",
    "merge-synthesis",
    "sync",
    "conflicts",
    "export",
    "config",
    "extensions",
    "corpus",
    "mcp",
    "mission",
    "watch",
    "tui",
    "serve",
    "help",
  ]);

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        // Collect repeated string flags (e.g. multiple --header) into an array.
        const existing = flags[key];
        if (typeof existing === "string") flags[key] = [existing, next];
        else if (Array.isArray(existing)) existing.push(next);
        else flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      // Short flags: -n 5, -m 3
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      if (!command && commands.has(arg)) {
        command = arg;
      } else {
        positional.push(arg);
      }
      i++;
    }
  }

  // If no recognized command but there's a positional arg, it's a seed phrase
  // e.g., lain "what if we built cities underwater" --branches 5
  if (!command && positional.length > 0) {
    command = "explore";
  }

  if (!command) {
    command = "help";
  }

  return { command, positional, flags };
}

type FlagMap = Record<string, string | boolean | string[]>;

export function getFlag(flags: FlagMap, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = flags[key];
    if (typeof val === "string") return val;
    if (Array.isArray(val) && val.length > 0) return val[0];
  }
  return undefined;
}

/** Return ALL values for a (possibly repeated) flag, e.g. multiple --header. */
export function getMultiFlag(flags: FlagMap, ...keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const val = flags[key];
    if (typeof val === "string") out.push(val);
    else if (Array.isArray(val)) out.push(...val);
  }
  return out;
}

export function getBoolFlag(flags: FlagMap, ...keys: string[]): boolean {
  for (const key of keys) {
    if (flags[key] === true) return true;
    if (flags[key] === "true") return true;
  }
  return false;
}

export function getNumFlag(flags: FlagMap, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const val = getFlag(flags, key);
    if (typeof val === "string") {
      const n = parseInt(val, 10);
      if (!isNaN(n)) return n;
    }
  }
  return undefined;
}
