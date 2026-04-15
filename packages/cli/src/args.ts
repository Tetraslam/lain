import type { Strategy, PlanDetail, Provider } from "@lain/shared";

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
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
  const flags: Record<string, string | boolean> = {};
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
    "watch",
    "help",
  ]);

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
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

export function getFlag(flags: Record<string, string | boolean>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = flags[key];
    if (typeof val === "string") return val;
  }
  return undefined;
}

export function getBoolFlag(flags: Record<string, string | boolean>, ...keys: string[]): boolean {
  for (const key of keys) {
    if (flags[key] === true) return true;
    if (flags[key] === "true") return true;
  }
  return false;
}

export function getNumFlag(flags: Record<string, string | boolean>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const val = flags[key];
    if (typeof val === "string") {
      const n = parseInt(val, 10);
      if (!isNaN(n)) return n;
    }
  }
  return undefined;
}
