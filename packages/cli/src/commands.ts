import * as p from "@clack/prompts";
import * as fs from "fs";
import * as path from "path";
import { Orchestrator } from "@lain/core";
import { Storage, Graph, Sync, Exporter, Watcher } from "@lain/core";
import { createProvider } from "@lain/agents";
import {
  generateId,
  nowISO,
  type Strategy,
  type PlanDetail,
  type Provider,
  type LainConfig,
} from "@lain/shared";
import type { ParsedArgs } from "./args.js";
import { getFlag, getBoolFlag, getNumFlag } from "./args.js";
import {
  loadConfig,
  loadCredentials,
  saveConfig,
  saveCredentials,
  saveWorkspaceConfig,
  configExists,
} from "./config.js";

export async function run(args: ParsedArgs): Promise<void> {
  // Auto-init on first run (unless --non-interactive or this IS the init command)
  if (
    args.command !== "init" &&
    args.command !== "help" &&
    !configExists() &&
    !getBoolFlag(args.flags, "non-interactive")
  ) {
    console.log("First run detected. Let's set up lain.\n");
    await runInit(args);
  }

  switch (args.command) {
    case "explore":
      return runExplore(args);
    case "init":
      return runInit(args);
    case "status":
      return runStatus(args);
    case "show":
      return runShow(args);
    case "tree":
      return runTree(args);
    case "prune":
      return runPrune(args);
    case "extend":
      return runExtend(args);
    case "sync":
      return runSync(args);
    case "export":
      return runExport(args);
    case "config":
      return runConfig(args);
    case "watch":
      return runWatch(args);
    case "help":
      return runHelp();
    default:
      console.error(`Unknown command: ${args.command}`);
      return runHelp();
  }
}

// ============================================================================
// Init
// ============================================================================

async function runInit(args: ParsedArgs): Promise<void> {
  const nonInteractive = getBoolFlag(args.flags, "non-interactive");
  const isWorkspace = getBoolFlag(args.flags, "workspace");

  if (nonInteractive) {
    // Non-interactive init — use flags directly
    const provider = (getFlag(args.flags, "provider") || "anthropic") as Provider;
    const model = getFlag(args.flags, "model") || "claude-sonnet-4-20250514";
    const apiKey = getFlag(args.flags, "api-key");
    const region = getFlag(args.flags, "region");

    if (isWorkspace) {
      saveWorkspaceConfig(process.cwd(), {
        defaultProvider: provider,
        defaultModel: model,
      });
      console.log(`Workspace config created at .lain/config.json`);
    } else {
      saveConfig({ defaultProvider: provider, defaultModel: model });
      if (apiKey) {
        if (provider === "anthropic") {
          saveCredentials({ anthropic: { apiKey } });
        } else if (provider === "bedrock") {
          saveCredentials({ bedrock: { region: region || "us-east-1" } });
        }
      }
      console.log(`Global config saved to ~/.config/lain/`);
    }
    return;
  }

  // Interactive init with clack
  p.intro("lain setup");

  if (isWorkspace) {
    const result = await p.group({
      defaultModel: () =>
        p.text({
          message: "Default model for this workspace?",
          initialValue: "claude-sonnet-4-20250514",
        }),
      defaultN: () =>
        p.text({
          message: "Default branches per node (n)?",
          initialValue: "3",
        }),
      defaultM: () =>
        p.text({
          message: "Default depth (m)?",
          initialValue: "3",
        }),
    });

    if (p.isCancel(result)) {
      p.cancel("Setup cancelled.");
      return;
    }

    saveWorkspaceConfig(process.cwd(), {
      defaultModel: result.defaultModel as string,
      defaultN: parseInt(result.defaultN as string, 10),
      defaultM: parseInt(result.defaultM as string, 10),
    });

    p.outro("Workspace config created at .lain/config.json");
    return;
  }

  // Global init
  const result = await p.group({
    provider: () =>
      p.select({
        message: "Default LLM provider?",
        options: [
          { value: "anthropic", label: "Anthropic (direct API)" },
          { value: "bedrock", label: "Amazon Bedrock" },
          { value: "openai", label: "OpenAI / compatible" },
        ],
      }),
    model: () =>
      p.text({
        message: "Default model?",
        initialValue: "claude-sonnet-4-20250514",
      }),
    apiKey: ({ results }) => {
      if (results.provider === "bedrock") return Promise.resolve(undefined);
      return p.text({
        message: `API key for ${results.provider as string}?`,
        placeholder: "sk-... (or press enter to use env var)",
      });
    },
    region: ({ results }) => {
      if (results.provider !== "bedrock") return Promise.resolve(undefined);
      return p.text({
        message: "AWS region for Bedrock?",
        initialValue: "us-east-1",
      });
    },
  });

  if (p.isCancel(result)) {
    p.cancel("Setup cancelled.");
    return;
  }

  saveConfig({
    defaultProvider: result.provider as Provider,
    defaultModel: result.model as string,
  });

  const creds: Record<string, unknown> = {};
  if (result.provider === "anthropic" && result.apiKey) {
    creds.anthropic = { apiKey: result.apiKey };
  } else if (result.provider === "bedrock") {
    creds.bedrock = { region: result.region || "us-east-1" };
  } else if (result.provider === "openai" && result.apiKey) {
    creds.openai = { apiKey: result.apiKey };
  }
  if (Object.keys(creds).length > 0) {
    saveCredentials(creds as any);
  }

  p.outro("lain is ready. Run `lain \"your idea\" --n 3 --m 2` to start.");
}

// ============================================================================
// Explore
// ============================================================================

async function runExplore(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const credentials = loadCredentials();

  // Get seed text
  let seed = args.positional[0];
  const seedFile = getFlag(args.flags, "seed");
  if (seedFile) {
    if (!fs.existsSync(seedFile)) {
      throw new Error(`Seed file not found: ${seedFile}`);
    }
    seed = fs.readFileSync(seedFile, "utf-8").trim();
  }
  if (!seed) {
    throw new Error(
      "No seed provided. Usage: lain \"your idea\" --n 3 --m 2"
    );
  }

  const n = getNumFlag(args.flags, "n", "branches") ?? config.defaultN;
  const m = getNumFlag(args.flags, "m", "depth") ?? config.defaultM;
  const strategy = (getFlag(args.flags, "strategy") ?? config.defaultStrategy) as Strategy;
  const planDetail = (getFlag(args.flags, "plan") ?? config.defaultPlanDetail) as PlanDetail;
  const ext = getFlag(args.flags, "ext", "extension") ?? config.defaultExtension;
  const outputDb = getFlag(args.flags, "output", "o", "db");

  // Generate a name from the seed
  const name = seed.length > 60 ? seed.slice(0, 57) + "..." : seed;
  const explorationId = generateId();
  const dbFileName = outputDb || `${slugify(name)}.db`;
  const dbPath = path.resolve(dbFileName);

  // Estimate cost
  let totalNodes = 0;
  for (let d = 1; d <= m; d++) {
    totalNodes += Math.pow(n, d);
  }
  console.log(
    `Creating exploration: ${n} branches x ${m} depth = ${totalNodes} nodes to generate`
  );
  console.log(`Strategy: ${strategy} | Plan detail: ${planDetail} | DB: ${dbFileName}`);

  // Create provider
  const provider = config.defaultProvider;
  const apiKey = getProviderApiKey(provider, credentials);

  const agent = createProvider({
    provider,
    model: config.defaultModel,
    apiKey,
  });

  // Create orchestrator
  const orchestrator = new Orchestrator({
    dbPath,
    agent,
    onEvent: (event) => {
      switch (event.type) {
        case "node:generating":
          process.stdout.write(
            `  Generating ${event.nodeId}...`
          );
          break;
        case "node:complete":
          const data = event.data as { title?: string } | undefined;
          console.log(` done — "${data?.title || "untitled"}"`);
          break;
        case "plan:complete": {
          const planData = event.data as { directions?: string[] } | undefined;
          if (planData?.directions) {
            console.log(`  Plan for ${event.nodeId}:`);
            for (const d of planData.directions) {
              console.log(`    - ${d}`);
            }
          }
          break;
        }
        case "error": {
          const errData = event.data as { error?: string } | undefined;
          console.error(`\n  Error: ${errData?.error}`);
          break;
        }
      }
    },
  });

  try {
    const exploration = await orchestrator.explore({
      id: explorationId,
      name,
      seed,
      n,
      m,
      strategy,
      planDetail,
      extension: ext,
    });

    console.log(`\nExploration complete: ${dbPath}`);
    console.log(`Run \`lain tree ${explorationId}\` or \`lain export ${dbFileName}\` to view.`);
  } finally {
    orchestrator.close();
  }
}

// ============================================================================
// Status
// ============================================================================

async function runStatus(args: ParsedArgs): Promise<void> {
  // Find all .db files in current directory
  const files = fs.readdirSync(".").filter((f) => f.endsWith(".db"));
  if (files.length === 0) {
    console.log("No exploration databases found in current directory.");
    return;
  }

  for (const file of files) {
    try {
      const storage = new Storage(file);
      const graph = new Graph(storage);
      const explorations = graph.getAllExplorations();

      for (const exp of explorations) {
        const nodes = graph.getAllNodes(exp.id);
        const complete = nodes.filter((n) => n.status === "complete").length;
        const pending = nodes.filter((n) => n.status === "pending").length;
        const pruned = nodes.filter((n) => n.status === "pruned").length;

        console.log(
          `${file} | ${exp.id} | "${exp.name}" | ${complete} complete, ${pending} pending, ${pruned} pruned`
        );
      }
      storage.close();
    } catch {
      // Skip files that aren't valid lain databases
    }
  }
}

// ============================================================================
// Show
// ============================================================================

async function runShow(args: ParsedArgs): Promise<void> {
  const nodeId = args.positional[0];
  if (!nodeId) throw new Error("Usage: lain show <node-id> [--db file.db]");

  const dbFile = getFlag(args.flags, "db") || findDb();
  const storage = new Storage(dbFile);
  const graph = new Graph(storage);

  const node = graph.getNode(nodeId);
  if (!node) {
    storage.close();
    throw new Error(`Node not found: ${nodeId}`);
  }

  console.log(`# ${node.title || node.id}`);
  console.log(`ID: ${node.id} | Depth: ${node.depth} | Status: ${node.status}`);
  if (node.model) console.log(`Model: ${node.model} (${node.provider})`);
  if (node.planSummary) console.log(`Direction: ${node.planSummary}`);
  console.log("");
  if (node.content) console.log(node.content);

  const crosslinks = storage.getCrosslinksForNode(nodeId);
  if (crosslinks.length > 0) {
    console.log("\nCross-links:");
    for (const cl of crosslinks) {
      const otherId = cl.sourceId === nodeId ? cl.targetId : cl.sourceId;
      console.log(`  - ${otherId}${cl.label ? ": " + cl.label : ""}`);
    }
  }

  storage.close();
}

// ============================================================================
// Tree
// ============================================================================

async function runTree(args: ParsedArgs): Promise<void> {
  const explorationId = args.positional[0];
  const dbFile = getFlag(args.flags, "db") || findDb();
  const storage = new Storage(dbFile);
  const graph = new Graph(storage);

  let exp;
  if (explorationId) {
    exp = graph.getExploration(explorationId);
  } else {
    const all = graph.getAllExplorations();
    exp = all[0]; // Default to most recent
  }

  if (!exp) {
    storage.close();
    throw new Error("No exploration found.");
  }

  const nodes = graph.getAllNodes(exp.id);
  const root = nodes.find((n) => n.parentId === null);

  console.log(`Exploration: ${exp.name} (${exp.id})`);
  console.log(`Seed: ${exp.seed}`);
  console.log(`Params: n=${exp.n}, m=${exp.m}, strategy=${exp.strategy}`);
  console.log("");

  if (root) {
    printTree(root, nodes, "");
  }

  storage.close();
}

function printTree(
  node: ReturnType<Graph["getNode"]> & {},
  allNodes: ReturnType<Graph["getAllNodes"]>,
  prefix: string,
  isLast = true
): void {
  const connector = prefix === "" ? "" : isLast ? "└── " : "├── ";
  const status =
    node.status === "pruned"
      ? " [pruned]"
      : node.status === "pending"
        ? " [pending]"
        : "";
  console.log(
    `${prefix}${connector}${node.title || node.id}${status}`
  );

  const children = allNodes
    .filter((n) => n.parentId === node.id)
    .sort((a, b) => a.branchIndex - b.branchIndex);

  const childPrefix = prefix === "" ? "" : prefix + (isLast ? "    " : "│   ");

  children.forEach((child, i) => {
    printTree(child, allNodes, childPrefix, i === children.length - 1);
  });
}

// ============================================================================
// Prune
// ============================================================================

async function runPrune(args: ParsedArgs): Promise<void> {
  const nodeId = args.positional[0];
  if (!nodeId) throw new Error("Usage: lain prune <node-id> [--db file.db]");

  const dbFile = getFlag(args.flags, "db") || findDb();
  const storage = new Storage(dbFile);
  const graph = new Graph(storage);

  graph.pruneNode(nodeId);
  console.log(`Pruned ${nodeId} and all descendants.`);
  storage.close();
}

// ============================================================================
// Extend
// ============================================================================

async function runExtend(args: ParsedArgs): Promise<void> {
  const nodeId = args.positional[0];
  if (!nodeId)
    throw new Error("Usage: lain extend <node-id> --n 3 [--db file.db]");

  const config = loadConfig();
  const credentials = loadCredentials();
  const dbFile = getFlag(args.flags, "db") || findDb();
  const n = getNumFlag(args.flags, "n", "branches") ?? config.defaultN;

  const provider = config.defaultProvider;
  const apiKey = getProviderApiKey(provider, credentials);
  const agent = createProvider({
    provider,
    model: config.defaultModel,
    apiKey,
  });

  const orchestrator = new Orchestrator({
    dbPath: dbFile,
    agent,
    onEvent: (event) => {
      if (event.type === "node:generating") {
        process.stdout.write(`  Generating ${event.nodeId}...`);
      } else if (event.type === "node:complete") {
        const data = event.data as { title?: string } | undefined;
        console.log(` done — "${data?.title || "untitled"}"`);
      }
    },
  });

  // Find the exploration
  const graph = orchestrator.getGraph();
  const node = graph.getNode(nodeId);
  if (!node) {
    orchestrator.close();
    throw new Error(`Node not found: ${nodeId}`);
  }

  const newNodes = await orchestrator.extendNode(
    node.explorationId,
    nodeId,
    n
  );
  console.log(`Created ${newNodes.length} new children under ${nodeId}.`);
  orchestrator.close();
}

// ============================================================================
// Sync
// ============================================================================

async function runSync(args: ParsedArgs): Promise<void> {
  const dbFile = args.positional[0] || getFlag(args.flags, "db") || findDb();
  const push = getBoolFlag(args.flags, "push");
  const pull = getBoolFlag(args.flags, "pull");
  const statusOnly = getBoolFlag(args.flags, "status");

  const storage = new Storage(dbFile);
  const sync = new Sync(storage);
  const graph = new Graph(storage);

  const explorations = graph.getAllExplorations();
  if (explorations.length === 0) {
    storage.close();
    throw new Error("No explorations in this database.");
  }
  const exp = explorations[0];

  // Default output dir: same name as db, without extension
  const baseName = path.basename(dbFile, ".db");
  const dir = path.join(path.dirname(dbFile), baseName);

  if (statusOnly) {
    const result = sync.status(exp.id, dir);
    console.log(`Sync status for ${exp.id}:`);
    if (result.fileChanged.length > 0)
      console.log(`  File changed: ${result.fileChanged.join(", ")}`);
    if (result.dbChanged.length > 0)
      console.log(`  DB changed: ${result.dbChanged.join(", ")}`);
    if (result.conflicts.length > 0)
      console.log(`  Conflicts: ${result.conflicts.join(", ")}`);
    if (result.deleted.length > 0)
      console.log(`  Deleted: ${result.deleted.join(", ")}`);
    if (
      result.fileChanged.length === 0 &&
      result.dbChanged.length === 0 &&
      result.conflicts.length === 0 &&
      result.deleted.length === 0
    ) {
      console.log("  Everything is in sync.");
    }
    storage.close();
    return;
  }

  let result;
  if (push) {
    result = sync.push(exp.id, dir);
    console.log(`Pushed ${result.pushed.length} nodes to ${dir}/`);
  } else if (pull) {
    result = sync.pull(exp.id, dir);
    console.log(`Pulled ${result.pulled.length} nodes from ${dir}/`);
    if (result.pruned.length > 0)
      console.log(`  Pruned: ${result.pruned.length} (files deleted)`);
  } else {
    result = sync.sync(exp.id, dir);
    console.log(`Sync complete:`);
    if (result.pushed.length > 0)
      console.log(`  Pushed: ${result.pushed.length}`);
    if (result.pulled.length > 0)
      console.log(`  Pulled: ${result.pulled.length}`);
    if (result.conflicts.length > 0)
      console.log(`  Conflicts: ${result.conflicts.length} (run \`lain conflicts ${dbFile}\`)`);
    if (result.pruned.length > 0)
      console.log(`  Pruned: ${result.pruned.length}`);
  }

  storage.close();
}

// ============================================================================
// Export
// ============================================================================

async function runExport(args: ParsedArgs): Promise<void> {
  const dbFile = args.positional[0] || getFlag(args.flags, "db") || findDb();
  const out = getFlag(args.flags, "out");

  const storage = new Storage(dbFile);
  const graph = new Graph(storage);
  const exporter = new Exporter(storage);

  const explorations = graph.getAllExplorations();
  if (explorations.length === 0) {
    storage.close();
    throw new Error("No explorations in this database.");
  }
  const exp = explorations[0];

  const baseName = path.basename(dbFile, ".db");
  const outputDir = out || path.join(path.dirname(dbFile), baseName);

  exporter.export(exp.id, outputDir);
  console.log(`Exported to ${outputDir}/`);
  storage.close();
}

// ============================================================================
// Config
// ============================================================================

async function runConfig(args: ParsedArgs): Promise<void> {
  const subcommand = args.positional[0]; // "set" or "list"

  if (subcommand === "list") {
    const config = loadConfig();
    const isGlobal = getBoolFlag(args.flags, "global");
    const isLocal = getBoolFlag(args.flags, "local");

    // For now, just dump the merged config
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (subcommand === "set") {
    const key = args.positional[1];
    const value = args.positional[2];
    if (!key || !value) throw new Error("Usage: lain config set <key> <value>");

    const isLocal = getBoolFlag(args.flags, "local");

    // Map flat keys to nested config
    const updates: Record<string, unknown> = {};
    const parts = key.split(".");
    let current = updates;
    for (let i = 0; i < parts.length - 1; i++) {
      current[parts[i]] = {};
      current = current[parts[i]] as Record<string, unknown>;
    }

    // Try to parse as number/boolean
    let parsed: unknown = value;
    if (value === "true") parsed = true;
    else if (value === "false") parsed = false;
    else if (/^\d+$/.test(value)) parsed = parseInt(value, 10);

    current[parts[parts.length - 1]] = parsed;

    if (isLocal) {
      saveWorkspaceConfig(process.cwd(), updates as Partial<LainConfig>);
      console.log(`Set ${key} = ${value} (workspace)`);
    } else {
      saveConfig(updates as Partial<LainConfig>);
      console.log(`Set ${key} = ${value} (global)`);
    }
    return;
  }

  throw new Error("Usage: lain config <set|list>");
}

// ============================================================================
// Watch
// ============================================================================

async function runWatch(args: ParsedArgs): Promise<void> {
  const stopFlag = getBoolFlag(args.flags, "stop");
  const statusFlag = getBoolFlag(args.flags, "status");
  const dbFile = args.positional[0] || getFlag(args.flags, "db") || findDb();

  if (stopFlag) {
    const lockPath = dbFile + ".lock";
    if (fs.existsSync(lockPath)) {
      const pid = parseInt(fs.readFileSync(lockPath, "utf-8"), 10);
      try {
        process.kill(pid, "SIGTERM");
        console.log(`Stopped watcher (PID ${pid}).`);
      } catch {
        console.log("Watcher not running (stale lock file removed).");
      }
      fs.unlinkSync(lockPath);
    } else {
      console.log("No watcher running for this database.");
    }
    return;
  }

  if (statusFlag) {
    const lockPath = dbFile + ".lock";
    if (fs.existsSync(lockPath)) {
      const pid = fs.readFileSync(lockPath, "utf-8").trim();
      console.log(`Watcher running (PID ${pid}).`);
    } else {
      console.log("No watcher running.");
    }
    return;
  }

  const config = loadConfig();
  const storage = new Storage(dbFile);
  const graph = new Graph(storage);
  const explorations = graph.getAllExplorations();
  storage.close();

  if (explorations.length === 0) {
    throw new Error("No explorations in this database.");
  }
  const exp = explorations[0];

  const baseName = path.basename(dbFile, ".db");
  const dir = path.join(path.dirname(dbFile), baseName);

  console.log(`Watching ${dir}/ for changes (Ctrl+C to stop)...`);

  const watcher = new Watcher({
    dbPath: dbFile,
    explorationId: exp.id,
    dir,
    debounceMs: config.watch.debounceMs,
    onDelete: config.watch.onDelete,
    onEvent: (event) => {
      const ts = new Date(event.timestamp).toLocaleTimeString();
      switch (event.type) {
        case "sync:file-changed":
          console.log(`[${ts}] Synced: ${event.nodeId}`);
          break;
        case "sync:conflict":
          console.log(`[${ts}] Conflict: ${event.nodeId}`);
          break;
        case "sync:complete":
          // quiet
          break;
        case "error":
          const data = event.data as { error?: string } | undefined;
          console.error(`[${ts}] Error: ${data?.error}`);
          break;
      }
    },
  });

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nStopping watcher...");
    await watcher.stop();
    process.exit(0);
  });

  await watcher.start();
}

// ============================================================================
// Help
// ============================================================================

function runHelp(): void {
  console.log(`lain — graph-based ideation engine

Usage:
  lain "<idea>" [options]         Start a new exploration
  lain explore --seed <file> [options]

Options:
  -n, --branches <n>     Branches per node (default: 3)
  -m, --depth <m>        Max depth (default: 3)
  --strategy <bf|df>     Breadth-first or depth-first (default: bf)
  --plan <level>         Plan detail: brief, sentence, detailed, none (default: sentence)
  --ext <name>           Extension to use (default: freeform)
  --db <file>            Database file to use
  -o, --output <file>    Output database filename

Commands:
  init                   Set up global config (--workspace for local, --non-interactive for agents)
  status                 Show explorations in current directory
  show <node-id>         Display a node
  tree [exploration-id]  Print tree structure
  prune <node-id>        Prune a node and descendants
  extend <node-id>       Generate more children (--n <count>)
  sync <file.db>         Bidirectional sync (--push, --pull, --status)
  export <file.db>       One-shot export to markdown (--out <dir>)
  config set <k> <v>     Set config value (--local for workspace)
  config list            Show effective config (--global, --local)
  watch <file.db>        Auto-sync on file changes (--stop, --status)
  help                   Show this help

Non-interactive mode (for agents):
  lain init --non-interactive --provider anthropic --api-key sk-...
  lain "idea" -n 3 -m 2 --db output.db
  lain export output.db --out ./my-exploration
  lain sync output.db --push
`);
}

// ============================================================================
// Helpers
// ============================================================================

function findDb(): string {
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

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

function getProviderApiKey(
  provider: Provider,
  credentials: ReturnType<typeof loadCredentials>
): string | undefined {
  switch (provider) {
    case "anthropic":
      return credentials.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
    case "bedrock":
      return undefined; // Bedrock uses AWS credentials
    case "openai":
      return credentials.openai?.apiKey || process.env.OPENAI_API_KEY;
    default:
      return undefined;
  }
}
