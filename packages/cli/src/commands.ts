import * as p from "@clack/prompts";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { Orchestrator } from "@lain/core";
import { Storage, Graph, Sync, Exporter, CanvasExporter, SynthesisEngine, Watcher, Corpus, connectMcpServers, buildToolCatalog, planMission, interviewMission, CURRENT_SCHEMA_VERSION, checkForUpdate, clearUpdateCache, addRecentDb, hasWebSearchTool, type InterviewTurn } from "@lain/core";
import {
  buildExtensionRegistry,
} from "@lain/extensions";
import {
  generateId,
  nowISO,
  estimateCost,
  slugify,
  SETTINGS_FIELDS,
  SETTINGS_SECTIONS,
  findSettingField,
  resolveSettingValue,
  applySettings,
  configPaths,
  normalizeToolSelection,
  resolveDisabledToolIds,
  enabledMcpServers,
  isGroupEnabled,
  isToolEnabled,
  toggleGroup,
  toggleTool,
  countActiveTools,
  type Strategy,
  type PlanDetail,
  type Provider,
  type LainConfig,
  type Mission,
  type SettingField,
  type ToolCatalog,
  type ToolSelection,
  type McpServerConfig,
} from "@lain/shared";
import type { ParsedArgs } from "./args.js";
import { getFlag, getBoolFlag, getNumFlag, getMultiFlag } from "./args.js";
import {
  loadConfig,
  loadCredentials,
  saveConfig,
  saveCredentials,
  saveWorkspaceConfig,
  configExists,
  removeMcpServer,
} from "./config.js";
import { findDb, createProviderFromCredentials, truncateStr } from "./commands/helpers.js";
import { banner, rule, section, kv, icon, c, bold, dim } from "./style.js";

export async function run(args: ParsedArgs): Promise<void> {
  // Global --version / -v
  if ((args.command === "help" || args.command === "explore") && getBoolFlag(args.flags, "version", "v") && args.positional.length === 0) {
    return runVersion();
  }

  // Auto-init on first run — but never for informational/lifecycle commands,
  // which must work on a fresh machine without dragging the user into setup.
  const NO_AUTOINIT = new Set(["init", "help", "config", "version", "doctor", "update", "uninstall"]);
  if (
    !NO_AUTOINIT.has(args.command) &&
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
    case "redirect":
      return runRedirect(args);
    case "extend":
      return runExtend(args);
    case "resume":
      return runResume(args);
    case "link":
      return runLink(args);
    case "synthesize":
      return runSynthesize(args);
    case "merge-synthesis":
      return runMergeSynthesis(args);
    case "conflicts":
      return runConflicts(args);
    case "sync":
      return runSync(args);
    case "export":
      return runExport(args);
    case "config":
      return runConfig(args);
    case "watch":
      return runWatch(args);
    case "extensions":
      return runExtensions(args);
    case "corpus":
      return runCorpus(args);
    case "mcp":
      return runMcp(args);
    case "tools":
      return runTools(args);
    case "mission":
      return runMission(args);
    case "version":
      return runVersion();
    case "doctor":
      return await runDoctor();
    case "update":
      return runUpdate();
    case "uninstall":
      return runUninstall();
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
    const model = getFlag(args.flags, "model") || "claude-sonnet-4-6";
    const apiKey = getFlag(args.flags, "api-key");
    const region = getFlag(args.flags, "region") || "us-west-2";
    const baseUrl = getFlag(args.flags, "base-url");

    if (isWorkspace) {
      saveWorkspaceConfig(process.cwd(), {
        defaultProvider: provider,
        defaultModel: model,
      });
      console.log(`Workspace config created at .lain/config.json`);
    } else {
      saveConfig({ defaultProvider: provider, defaultModel: model });
      if (provider === "anthropic" && apiKey) {
        saveCredentials({ anthropic: { apiKey } });
      } else if (provider === "bedrock" && apiKey) {
        saveCredentials({ bedrock: { apiKey, region } });
      } else if (provider === "openai" && apiKey) {
        saveCredentials({ openai: { apiKey, ...(baseUrl ? { baseUrl } : {}) } });
      } else if (provider === "openrouter" && apiKey) {
        saveCredentials({ openrouter: { apiKey, ...(baseUrl ? { baseUrl } : {}) } });
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
          initialValue: "claude-sonnet-4-6",
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
          { value: "openai", label: "OpenAI / compatible (ollama, together, …)" },
          { value: "openrouter", label: "OpenRouter" },
        ],
      }),
    model: () =>
      p.text({
        message: "Default model?",
        initialValue: "claude-sonnet-4-6",
      }),
    apiKey: ({ results }) =>
      p.text({
        message:
          results.provider === "bedrock"
            ? "Bedrock API key?"
            : `API key for ${results.provider as string}?`,
        placeholder:
          results.provider === "bedrock"
            ? "ABSK... (or press enter to use AWS_BEARER_TOKEN_BEDROCK env var)"
            : "sk-... (or press enter to use env var)",
      }),
    region: ({ results }) => {
      if (results.provider !== "bedrock") return Promise.resolve(undefined);
      return p.text({
        message: "AWS region for Bedrock?",
        initialValue: "us-west-2",
      });
    },
    baseUrl: ({ results }) => {
      if (results.provider !== "openai") return Promise.resolve(undefined);
      return p.text({
        message: "Base URL (for OpenAI-compatible endpoints; blank = OpenAI)?",
        placeholder: "https://api.openai.com/v1",
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

  const creds: Partial<import("@lain/shared").Credentials> = {};
  if (result.provider === "anthropic" && result.apiKey) {
    creds.anthropic = { apiKey: result.apiKey as string };
  } else if (result.provider === "bedrock" && result.apiKey) {
    creds.bedrock = { apiKey: result.apiKey as string, region: (result.region || "us-west-2") as string };
  } else if (result.provider === "openai" && result.apiKey) {
    creds.openai = { apiKey: result.apiKey as string, ...(result.baseUrl ? { baseUrl: result.baseUrl as string } : {}) };
  } else if (result.provider === "openrouter" && result.apiKey) {
    creds.openrouter = { apiKey: result.apiKey as string };
  }
  if (Object.keys(creds).length > 0) {
    saveCredentials(creds);
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
  const concurrency = getNumFlag(args.flags, "concurrency", "c") ?? config.concurrency;
  const corpusPath = getFlag(args.flags, "corpus");
  const missionRaw = args.flags["mission"];
  const missionJsonArg = getFlag(args.flags, "mission-json");
  // A prebuilt mission implies --mission, so agents can script the whole thing.
  const missionEnabled = missionRaw !== undefined && missionRaw !== false || !!missionJsonArg;
  const missionRefinement = typeof missionRaw === "string" ? missionRaw : undefined;
  const missionRounds = getNumFlag(args.flags, "mission-rounds") ?? config.defaultMissionRounds;
  const agentMaxSteps = getNumFlag(args.flags, "max-steps") ?? 50;

  // Generate a name from the seed
  const name = seed.length > 60 ? seed.slice(0, 57) + "..." : seed;
  const explorationId = generateId();
  let dbFileName = outputDb || `${slugify(name)}.db`;
  if (!outputDb && fs.existsSync(path.resolve(dbFileName))) {
    dbFileName = `${slugify(name)}-${explorationId.slice(0, 4)}.db`;
  }
  const dbPath = path.resolve(dbFileName);

  // Estimate cost
  const estimate = estimateCost(n, m, config.defaultModel, planDetail);
  console.log(
    `Creating exploration: ${n} branches x ${m} depth = ${estimate.totalNodes} nodes`
  );
  console.log(
    `  API calls: ${estimate.planCalls} plan + ${estimate.generateCalls} generate = ${estimate.planCalls + estimate.generateCalls} total`
  );
  console.log(
    `  Est. tokens: ~${(estimate.estimatedInputTokens / 1000).toFixed(0)}k input + ~${(estimate.estimatedOutputTokens / 1000).toFixed(0)}k output`
  );
  console.log(
    `  Est. cost: ~$${estimate.estimatedCostUsd.toFixed(3)} (${estimate.model})`
  );
  console.log(`Strategy: ${strategy} | Plan detail: ${planDetail} | Concurrency: ${concurrency} | DB: ${dbFileName}`);
  console.log(`Nodes are tool-using agents${corpusPath ? ` (corpus: ${corpusPath})` : ""}.`);

  // Create provider
  const provider = config.defaultProvider;
  const agent = createProviderFromCredentials(provider, config, credentials);

  // Resolve the per-run tool selection (config defaults + flag overrides) and
  // assemble the toolbelt. Only enabled MCP servers are connected.
  const extensionsForCatalog = buildExtensionRegistry();
  let mcpPool: McpPoolType | null = null;
  let disabledToolIds: string[] = [];
  {
    const belt = await assembleRunToolbelt(config, args, extensionsForCatalog, { hasCorpus: !!corpusPath, ext });
    mcpPool = belt.mcpPool;
    disabledToolIds = belt.disabledToolIds;
    if (mcpPool) {
      if (mcpPool.tools.length > 0) console.log(`MCP: ${mcpPool.tools.length} tool(s) from ${mcpPool.connections.length} server(s)`);
      for (const e of mcpPool.errors) console.warn(`  MCP "${e.name}" unavailable: ${e.error}`);
    }
    if (disabledToolIds.length > 0) console.log(`Tools: ${belt.activeCount} active (${disabledToolIds.length} disabled by selection)`);
  }
  // The research lens grounds claims in cited web sources — warn (don't block) if none is available.
  if (extensionsForCatalog.get(ext)?.requiresWebSearch) {
    const activeMcpIds = (mcpPool?.tools ?? []).map((tl) => tl.spec.name).filter((id) => !disabledToolIds.includes(id));
    if (!hasWebSearchTool(activeMcpIds)) {
      console.warn(`  ⚠ the "${ext}" lens cites real web sources, but no web-search tool is active. Citations will be sparse — add one (e.g. firecrawl) via \`lain mcp add\` or mcpServers in your config.`);
    }
  }

  // Mission planning — the cognitive-frontloading gate. Interactively, the
  // architect interviews you until the goal is unambiguous, then you approve the
  // contract before anything generates. Non-interactive (agents) auto-derive.
  let plannedMission: Mission | null = null;
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY
    && !getBoolFlag(args.flags, "non-interactive", "yes", "no-interview");
  if (missionEnabled) {
    if (missionJsonArg) {
      // Prebuilt mission (fully scriptable): a JSON file path or inline JSON.
      plannedMission = loadMissionJson(missionJsonArg, explorationId);
      console.log(`Using provided mission contract (${plannedMission.assertions.length} assertions).`);
    } else if (interactive) {
      plannedMission = await runMissionInterview(agent, explorationId, seed, n, ext, missionRefinement);
      if (!plannedMission) {
        console.log("Mission cancelled.");
        if (mcpPool) await mcpPool.close();
        return;
      }
    } else {
      process.stdout.write("Planning mission (contract-first, non-interactive)...");
      plannedMission = await planMission(agent, explorationId, seed, n, { extension: ext, refinement: missionRefinement });
      console.log(" done");
    }
  }

  // Create orchestrator with extensions
  const extensions = extensionsForCatalog;
  const orchestrator = new Orchestrator({
    dbPath,
    agent,
    concurrency,
    extensions,
    agentMaxSteps,
    agentMaxTokens: config.maxTokens,
    extraTools: mcpPool?.tools ?? [],
    disabledTools: disabledToolIds,
    onEvent: (event) => {
      switch (event.type) {
        case "node:generating":
          process.stdout.write(
            `  Generating ${event.nodeId}...`
          );
          break;
        case "node:agent-step": {
          const step = event.data as { kind?: string; name?: string; summary?: string } | undefined;
          if (step?.kind === "tool_call") {
            process.stdout.write(`\n    ↳ ${event.nodeId}: ${step.name}`);
          }
          break;
        }
        case "node:complete":
          const data = event.data as { title?: string } | undefined;
          console.log(`\n done — "${data?.title || "untitled"}"`);
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
        case "mission:fix": {
          const f = event.data as { critique?: string; assertions?: string[] } | undefined;
          console.log(`  ↻ revising ${event.nodeId} to close [${(f?.assertions ?? []).join(", ")}]: ${truncateStr(f?.critique ?? "", 70)}`);
          break;
        }
        case "mission:validated": {
          const r = event.data as { round?: number; satisfied?: boolean; results?: { id: string; status: string; evidence: string }[]; summary?: string } | undefined;
          const icon = (s: string) => (s === "met" ? "✓" : s === "partial" ? "~" : "✗");
          console.log(`\n  Validation round ${r?.round} — ${r?.satisfied ? "contract satisfied" : "gaps remain"}:`);
          for (const res of r?.results ?? []) console.log(`    ${icon(res.status)} ${res.id}  ${truncateStr(res.evidence, 64)}`);
          if (r?.summary && !r.satisfied) console.log(`    → next: ${r.summary}`);
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
      beforeExpand: async (exp) => {
        // Mission: persist the contract (planned/approved above) so the root's
        // branches are driven by its features.
        if (plannedMission) {
          orchestrator.getStorage().upsertMission({ ...plannedMission, explorationId: exp.id });
        }
        // Corpus ingestion.
        if (corpusPath) {
          const corpus = orchestrator.getCorpus();
          const resolved = path.resolve(corpusPath);
          if (corpus && fs.existsSync(resolved)) {
            const results = fs.statSync(resolved).isDirectory()
              ? await corpus.ingestDirectory(exp.id, resolved)
              : [await corpus.ingestFile(exp.id, resolved)];
            const chunks = results.reduce((a, r) => a + r.chunkCount, 0);
            console.log(`  Ingested ${results.length} source(s), ${chunks} chunk(s) into corpus.`);
          } else if (corpus) {
            console.warn(`  Corpus path not found, skipping: ${corpusPath}`);
          }
        }
      },
    });

    // Mission: independently validate the graph against the contract and
    // autonomously generate fix-branches until it's satisfied or rounds run out.
    if (missionEnabled) {
      console.log(`\nValidating against the contract...`);
      const report = await orchestrator.pursueMission(explorationId, { maxRounds: missionRounds });
      if (report) {
        const met = report.results.filter((r) => r.status === "met").length;
        console.log(`\nMission ${report.satisfied ? "satisfied ✓" : "incomplete"} — ${met}/${report.results.length} assertions met after ${report.round} round(s).`);
        console.log(`Run \`lain mission ${dbFileName}\` for the full report.`);
      }
    }

    console.log(`\nExploration complete: ${dbPath}`);
    console.log(`Run \`lain tree ${explorationId}\` or \`lain export ${dbFileName}\` to view.`);
  } finally {
    orchestrator.close();
    if (mcpPool) await mcpPool.close();
  }
}

/**
 * The interactive cognitive-frontloading gate: the architect interviews the
 * user until the goal is unambiguous, then the user approves the contract.
 * Returns the locked-in mission, or null if cancelled. Won't proceed without it.
 */
async function runMissionInterview(
  agent: ReturnType<typeof createProviderFromCredentials>,
  explorationId: string,
  seed: string,
  n: number,
  ext: string,
  refinement?: string
): Promise<Mission | null> {
  p.intro(`${c.accent("mission")} ${dim("— let's pin down the goal before exploring")}`);
  const history: InterviewTurn[] = [];
  if (refinement) history.push({ question: "Initial framing", answer: refinement });

  const showContract = (m: Mission) => {
    const lines = [
      `${bold("Intent")}  ${m.intent}`,
      "",
      bold("Contract"),
      ...m.assertions.map((a) => `  ${c.green(a.id)}  ${a.text}`),
    ];
    if (m.features.length) {
      lines.push("", bold("Branches"));
      for (const f of m.features) lines.push(`  ${c.blue(f.id)}  ${f.angle} ${dim(`[${f.assertions.join(", ")}]`)}`);
    }
    p.note(lines.join("\n"), "proposed mission");
  };

  for (let guard = 0; guard < 8; guard++) {
    const spin = p.spinner();
    spin.start(history.length === 0 ? "Thinking about what to ask…" : "Reconsidering the goal…");
    const res = await interviewMission(agent, explorationId, seed, n, history, { extension: ext });
    spin.stop(res.done ? "Goal is clear." : "A few questions first.");

    if (!res.done) {
      for (const q of res.questions) {
        const ans = await p.text({ message: q, placeholder: "enter to skip / no strong preference" });
        if (p.isCancel(ans)) { p.cancel("Mission cancelled."); return null; }
        history.push({ question: q, answer: typeof ans === "string" ? ans.trim() : "" });
      }
      continue;
    }

    showContract(res.mission);
    const ok = await p.confirm({ message: "Lock this in and start exploring?" });
    if (p.isCancel(ok)) { p.cancel("Mission cancelled."); return null; }
    if (ok) { p.outro(`Mission locked — ${res.mission.assertions.length} assertions to satisfy.`); return res.mission; }

    const change = await p.text({ message: "What should change about the goal or contract?" });
    if (p.isCancel(change)) { p.cancel("Mission cancelled."); return null; }
    history.push({ question: "Requested change", answer: typeof change === "string" ? change.trim() : "" });
  }
  // Safety net: never loop forever.
  p.outro("Finalizing mission.");
  return planMission(agent, explorationId, seed, n, { extension: ext, refinement: history.map((h) => h.answer).join(" · ") });
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
  addRecentDb(path.resolve(dbFile));
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

  const citations = storage.getCitationsForNode(nodeId);
  if (citations.length > 0) {
    console.log("\nSources:");
    for (const ct of citations) console.log(`  [${ct.idx}] ${ct.title || ct.url}\n      ${ct.url}`);
  }

  storage.close();
}

// ============================================================================
// Tree
// ============================================================================

async function runTree(args: ParsedArgs): Promise<void> {
  const explorationId = args.positional[0];
  const dbFile = getFlag(args.flags, "db") || findDb();
  addRecentDb(path.resolve(dbFile));
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
    printTree(root, nodes, "", true, true);
  }

  storage.close();
}

function printTree(
  node: ReturnType<Graph["getNode"]> & {},
  allNodes: ReturnType<Graph["getAllNodes"]>,
  prefix: string,
  isLast = true,
  isRoot = false
): void {
  const connector = isRoot ? "" : isLast ? "└── " : "├── ";
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

  const childPrefix = isRoot ? "" : prefix + (isLast ? "    " : "│   ");

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
  const agent = createProviderFromCredentials(provider, config, credentials);

  const orchestrator = new Orchestrator({
    dbPath: dbFile,
    agent,
    extensions: buildExtensionRegistry(),
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
// Resume (finish an interrupted exploration)
// ============================================================================

async function runResume(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const credentials = loadCredentials();
  const dbFile = getFlag(args.flags, "db") || args.positional[0] || findDb();
  const dbPath = path.resolve(dbFile);
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbFile}`);

  // Probe the db to report progress and decide whether to resume agentically.
  const probe = new Storage(dbPath);
  const exp = new Graph(probe).getAllExplorations()[0];
  if (!exp) { probe.close(); throw new Error("No explorations in this database."); }
  const allNodes = new Graph(probe).getAllNodes(exp.id);
  const pending = allNodes.filter((n) => n.status !== "complete" && n.status !== "pruned");
  const hasMission = !!probe.getMission(exp.id);
  const hasCorpus = probe.getCorpusSources(exp.id).length > 0;
  probe.close();

  const tags = [hasCorpus ? "corpus" : null, hasMission ? "mission" : null].filter(Boolean);
  console.log(`Resuming "${exp.name}" — ${pending.length} incomplete node(s)${tags.length ? ` (${tags.join(", ")})` : ""}`);

  const agent = createProviderFromCredentials(config.defaultProvider, config, credentials);
  const resumeRegistry = buildExtensionRegistry();
  let mcpPool: McpPoolType | null = null;
  let disabledToolIds: string[] = [];
  {
    const belt = await assembleRunToolbelt(config, args, resumeRegistry, { hasCorpus, ext: exp.extension });
    mcpPool = belt.mcpPool;
    disabledToolIds = belt.disabledToolIds;
    if (mcpPool && mcpPool.tools.length > 0) console.log(`MCP: ${mcpPool.tools.length} tool(s) from ${mcpPool.connections.length} server(s)`);
    if (disabledToolIds.length > 0) console.log(`Tools: ${belt.activeCount} active (${disabledToolIds.length} disabled by selection)`);
  }

  const orchestrator = new Orchestrator({
    dbPath,
    agent,
    disabledTools: disabledToolIds,
    concurrency: getNumFlag(args.flags, "concurrency", "c") ?? config.concurrency,
    extensions: buildExtensionRegistry(),
    agentMaxTokens: config.maxTokens,
    extraTools: mcpPool?.tools ?? [],
    onEvent: (event) => {
      if (event.type === "node:complete") {
        const data = event.data as { title?: string } | undefined;
        console.log(`  done ${event.nodeId} — "${data?.title || "untitled"}"`);
      }
    },
  });

  try {
    const { generated, created } = await orchestrator.resume(exp.id);
    if (generated === 0 && created === 0) {
      console.log("Nothing to resume — this exploration is already complete.");
    } else {
      console.log(`\nResume complete: generated ${generated} node(s)${created ? `, created ${created} new child node(s)` : ""}.`);
      console.log(`Run \`lain tree --db ${dbFile}\` to view.`);
    }
  } finally {
    orchestrator.close();
    if (mcpPool) await mcpPool.close();
  }
}

// ============================================================================
// Redirect (regenerate a node)
// ============================================================================

async function runRedirect(args: ParsedArgs): Promise<void> {
  const nodeId = args.positional[0];
  if (!nodeId)
    throw new Error("Usage: lain redirect <node-id> [--db file.db]");

  const config = loadConfig();
  const credentials = loadCredentials();
  const dbFile = getFlag(args.flags, "db") || findDb();

  const provider = config.defaultProvider;
  const agent = createProviderFromCredentials(provider, config, credentials);

  const orchestrator = new Orchestrator({
    dbPath: dbFile,
    agent,
    extensions: buildExtensionRegistry(),
    onEvent: (event) => {
      if (event.type === "node:generating") {
        process.stdout.write(`  Regenerating ${event.nodeId}...`);
      } else if (event.type === "node:complete") {
        const data = event.data as { title?: string } | undefined;
        console.log(` done — "${data?.title || "untitled"}"`);
      }
    },
  });

  const graph = orchestrator.getGraph();
  const node = graph.getNode(nodeId);
  if (!node) {
    orchestrator.close();
    throw new Error(`Node not found: ${nodeId}`);
  }

  const oldTitle = node.title;
  const updated = await orchestrator.redirectNode(node.explorationId, nodeId);
  console.log(`Redirected ${nodeId}: "${oldTitle}" → "${updated.title}"`);
  orchestrator.close();
}

// ============================================================================
// Link (add cross-link between nodes)
// ============================================================================

async function runLink(args: ParsedArgs): Promise<void> {
  const nodeA = args.positional[0];
  const nodeB = args.positional[1];
  if (!nodeA || !nodeB)
    throw new Error("Usage: lain link <node-a> <node-b> [--label 'description'] [--db file.db]");

  const dbFile = getFlag(args.flags, "db") || findDb();
  const label = getFlag(args.flags, "label");
  const storage = new Storage(dbFile);
  const graph = new Graph(storage);

  const a = graph.getNode(nodeA);
  const b = graph.getNode(nodeB);
  if (!a) { storage.close(); throw new Error(`Node not found: ${nodeA}`); }
  if (!b) { storage.close(); throw new Error(`Node not found: ${nodeB}`); }

  graph.addCrosslink(nodeA, nodeB, label);
  console.log(`Linked ${nodeA} ↔ ${nodeB}${label ? ` — "${label}"` : ""}`);
  storage.close();
}

// ============================================================================
// Synthesize
// ============================================================================

async function runSynthesize(args: ParsedArgs): Promise<void> {
  const dbFile = args.positional[0] || getFlag(args.flags, "db") || findDb();
  const autoMerge = getBoolFlag(args.flags, "auto-merge");

  const config = loadConfig();
  const credentials = loadCredentials();
  const provider = (getFlag(args.flags, "provider") || config.defaultProvider) as Provider;
  const agent = createProviderFromCredentials(provider, config, credentials);

  const storage = new Storage(dbFile);
  const graph = new Graph(storage);

  const explorations = graph.getAllExplorations();
  if (explorations.length === 0) {
    storage.close();
    throw new Error("No explorations in this database.");
  }
  const exp = explorations[0];

  const activeNodes = graph.getAllNodes(exp.id).filter((n) => n.status !== "pruned");
  console.log(`Synthesizing exploration "${exp.name}" (${activeNodes.length} active nodes)...`);

  const engine = new SynthesisEngine({ storage, agent });

  try {
    const synthesisId = await engine.synthesize(exp.id);
    const result = engine.getSynthesis(synthesisId);

    if (!result) {
      storage.close();
      throw new Error("Synthesis failed — no result returned.");
    }

    console.log(`\nSynthesis complete: ${synthesisId}`);
    console.log(`\n--- Summary ---\n${result.synthesis.content}\n`);

    const annotations = result.annotations;
    const byType: Record<string, typeof annotations> = {};
    for (const a of annotations) {
      (byType[a.type] ??= []).push(a);
    }

    for (const [type, items] of Object.entries(byType)) {
      console.log(`${type} (${items.length}):`);
      for (const a of items) {
        const nodes = [a.sourceNodeId, a.targetNodeId].filter(Boolean).join(" ↔ ");
        console.log(`  ${a.id}: ${nodes} — ${a.content ?? ""}`);
      }
    }

    if (autoMerge) {
      const { merged, skipped } = engine.mergeAll(synthesisId);
      console.log(`\nAuto-merged ${merged} annotations.${skipped > 0 ? ` ${skipped} contradiction/merge_suggestion annotations require individual review (--annotation <id>).` : ""}`);
    } else if (annotations.length > 0) {
      console.log(`\n${annotations.length} annotations staged. Run \`lain merge-synthesis ${synthesisId}\` to apply.`);
      console.log(`Or use --auto-merge to apply automatically.`);
    }
  } finally {
    storage.close();
  }
}

// ============================================================================
// Merge Synthesis
// ============================================================================

async function runMergeSynthesis(args: ParsedArgs): Promise<void> {
  const synthesisId = args.positional[0];
  const dbFile = getFlag(args.flags, "db") || findDb();
  const all = getBoolFlag(args.flags, "all");
  const annotationId = getFlag(args.flags, "annotation");
  const dismiss = getBoolFlag(args.flags, "dismiss");

  if (!synthesisId) {
    // List syntheses in this DB
    const storage = new Storage(dbFile);
    const graph = new Graph(storage);
    const explorations = graph.getAllExplorations();
    if (explorations.length === 0) {
      storage.close();
      throw new Error("No explorations in this database.");
    }

    const syntheses = storage.getSynthesesForExploration(explorations[0].id);
    if (syntheses.length === 0) {
      console.log("No syntheses found. Run `lain synthesize` first.");
    } else {
      for (const s of syntheses) {
        const annotations = storage.getAnnotationsForSynthesis(s.id);
        const unmerged = annotations.filter((a) => !a.merged).length;
        const status = s.merged ? "merged" : unmerged > 0 ? `${unmerged} pending` : "no annotations";
        console.log(`  ${s.id}  ${s.status}  ${status}  ${s.createdAt}`);
      }
    }
    storage.close();
    return;
  }

  const storage = new Storage(dbFile);
  const graph = new Graph(storage);
  const explorations = graph.getAllExplorations();
  const exp = explorations[0];

  try {
    if (dismiss && annotationId) {
      const engine = new SynthesisEngine({ storage, agent: null });
      engine.dismissAnnotation(annotationId);
      console.log(`Dismissed annotation ${annotationId}`);
    } else if (annotationId) {
      // Check if this annotation needs preview generation
      const annotation = storage.getAnnotation(annotationId);
      if (!annotation) throw new Error(`Annotation not found: ${annotationId}`);

      if (annotation.type === "contradiction" || annotation.type === "merge_suggestion") {
        // Generate preview via agent
        const config = loadConfig();
        const credentials = loadCredentials();
        const provider = (getFlag(args.flags, "provider") || config.defaultProvider) as Provider;
        const agent = createProviderFromCredentials(provider, config, credentials);
        const engine = new SynthesisEngine({ storage, agent });

        console.log(`Generating ${annotation.type === "contradiction" ? "resolution" : "synthesis"}...`);
        const preview = await engine.generateMergePreview(annotationId, exp.id);

        console.log(`\n--- Preview ---`);
        console.log(`Title: ${preview.title}`);
        console.log(`Parent: ${preview.parentId}`);
        console.log(`Crosslinks to: ${preview.crosslinkTo.join(", ")}`);
        console.log(`\n${preview.content}\n`);

        if (getBoolFlag(args.flags, "yes") || getBoolFlag(args.flags, "non-interactive")) {
          const nodeId = engine.applyMergePreview(annotationId, exp.id, preview);
          console.log(`Applied — created node ${nodeId}`);
        } else {
          console.log(`Run with --yes to apply, or use the TUI/web for interactive preview.`);
        }
      } else {
        const engine = new SynthesisEngine({ storage, agent: null });
        engine.mergeSingle(annotationId);
        console.log(`Merged annotation ${annotationId}`);
      }
    } else if (all || !annotationId) {
      const engine = new SynthesisEngine({ storage, agent: null });
      const { merged, skipped } = engine.mergeAll(synthesisId);
      console.log(`Merged ${merged} annotations from ${synthesisId}.`);
      if (skipped > 0) console.log(`${skipped} contradiction/merge_suggestion annotations skipped — use --annotation <id> for individual resolution.`);
    }
  } finally {
    storage.close();
  }
}

// ============================================================================
// Conflicts
// ============================================================================

async function runConflicts(args: ParsedArgs): Promise<void> {
  const dbFile = args.positional[0] || getFlag(args.flags, "db") || findDb();
  const resolve = getFlag(args.flags, "resolve"); // "theirs" or "ours"

  const storage = new Storage(dbFile);
  const graph = new Graph(storage);

  const explorations = graph.getAllExplorations();
  if (explorations.length === 0) {
    storage.close();
    throw new Error("No explorations in this database.");
  }

  const conflicts = graph.getConflicts(explorations[0].id);

  if (conflicts.length === 0) {
    console.log("No conflicts.");
    storage.close();
    return;
  }

  if (resolve) {
    // Batch resolve all conflicts
    for (const node of conflicts) {
      if (resolve === "theirs") {
        // Keep current content (file version), discard conflict
        storage.clearNodeConflict(node.id);
      } else if (resolve === "ours") {
        // Restore db version from conflict field, discard file version
        if (node.contentConflict) {
          storage.updateNodeFromSync(node.id, { content: node.contentConflict });
        }
        storage.clearNodeConflict(node.id);
      }
    }
    console.log(`Resolved ${conflicts.length} conflict(s) using "${resolve}" strategy.`);
    storage.close();
    return;
  }

  // List conflicts
  console.log(`${conflicts.length} conflict(s):\n`);
  for (const node of conflicts) {
    console.log(`  ${node.id} — "${node.title}"`);
    console.log(`    Current (from file): ${truncateStr(node.content || "", 100)}`);
    console.log(`    Conflict (from db):  ${truncateStr(node.contentConflict || "", 100)}`);
    console.log("");
  }
  console.log(`Resolve with: lain conflicts ${dbFile} --resolve theirs|ours`);
  storage.close();
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
  const isCanvas = getBoolFlag(args.flags, "canvas");

  const storage = new Storage(dbFile);
  const graph = new Graph(storage);

  const explorations = graph.getAllExplorations();
  if (explorations.length === 0) {
    storage.close();
    throw new Error("No explorations in this database.");
  }
  const exp = explorations[0];
  const baseName = path.basename(dbFile, ".db");

  if (isCanvas) {
    // Canvas export: .canvas file + markdown files it references
    const mdDir = out || path.join(path.dirname(dbFile), baseName);

    // First export markdown files so the canvas file nodes can reference them
    const exporter = new Exporter(storage);
    exporter.export(exp.id, mdDir);

    // Write .canvas alongside the markdown folder
    const canvasPath = out
      ? path.join(path.dirname(out), baseName + ".canvas")
      : path.join(path.dirname(dbFile), baseName + ".canvas");

    const canvasExporter = new CanvasExporter(storage);
    canvasExporter.export(exp.id, canvasPath, baseName);

    console.log(`Exported canvas to ${canvasPath}`);
    console.log(`Markdown files at ${mdDir}/`);
  } else {
    // Standard markdown export
    const outputDir = out || path.join(path.dirname(dbFile), baseName);
    const exporter = new Exporter(storage);
    exporter.export(exp.id, outputDir);
    console.log(`Exported to ${outputDir}/`);
  }

  storage.close();
}

// ============================================================================
// Config
// ============================================================================

/** Render a stored value for display (redacting secrets). */
function displaySettingValue(field: SettingField, raw: unknown): string {
  if (raw == null || raw === "") return dim("(unset)");
  if (field.type === "secret") {
    const s = String(raw);
    const tail = s.length > 4 ? s.slice(-4) : "";
    return c.green("●●●●") + dim(tail ? `…${tail}` : "") + dim("  set");
  }
  if (field.type === "boolean") return raw ? c.green("on") : dim("off");
  return c.fg(String(raw));
}

/** Load a prebuilt mission from a JSON file path or inline JSON (for scripting). */
function loadMissionJson(arg: string, explorationId: string): Mission {
  const raw = fs.existsSync(arg) ? fs.readFileSync(arg, "utf-8") : arg;
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`--mission-json: not valid JSON (and not a file path): ${arg.slice(0, 60)}`); }
  if (!parsed || typeof parsed.intent !== "string" || !Array.isArray(parsed.assertions)) {
    throw new Error('--mission-json must be an object with "intent" (string) and "assertions" (array of {id,text}).');
  }
  const assertions = parsed.assertions.map((a: any, i: number) => {
    if (!a || typeof a.text !== "string") throw new Error(`--mission-json: assertion ${i} needs a "text" string.`);
    return { id: typeof a.id === "string" && a.id ? a.id : `A${i + 1}`, text: a.text };
  });
  const features = Array.isArray(parsed.features)
    ? parsed.features.map((f: any, i: number) => ({
        id: typeof f.id === "string" && f.id ? f.id : `F${i + 1}`,
        angle: String(f.angle ?? ""),
        assertions: Array.isArray(f.assertions) ? f.assertions.map(String) : [],
      }))
    : [];
  return { explorationId, intent: parsed.intent, assertions, features, createdAt: new Date().toISOString() };
}

async function runConfig(args: ParsedArgs): Promise<void> {
  const subcommand = args.positional[0] || "list";
  const isLocal = getBoolFlag(args.flags, "local");
  const asJson = getBoolFlag(args.flags, "json");

  // ---- config path ----
  if (subcommand === "path") {
    const paths = configPaths(process.cwd());
    if (asJson) { console.log(JSON.stringify(paths, null, 2)); return; }
    console.log(kv("global", paths.global));
    console.log(kv("workspace", paths.workspace || dim("(none)")));
    console.log(kv("credentials", paths.credentials));
    return;
  }

  // ---- config list ----
  if (subcommand === "list") {
    const config = loadConfig();
    const credentials = loadCredentials();
    if (asJson) {
      const out: Record<string, unknown> = {};
      for (const f of SETTINGS_FIELDS) {
        const v = resolveSettingValue(f, config, credentials);
        out[f.key] = f.type === "secret" ? (v ? "***set***" : null) : v ?? null;
      }
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    console.log("");
    for (const sec of SETTINGS_SECTIONS) {
      console.log("  " + section(sec.title) + (sec.description ? "  " + dim(sec.description) : ""));
      for (const f of SETTINGS_FIELDS.filter((x) => x.section === sec.id)) {
        const v = resolveSettingValue(f, config, credentials);
        console.log("    " + c.muted(f.key.padEnd(34)) + displaySettingValue(f, v));
      }
      console.log("");
    }
    console.log(dim("  set with: ") + c.fg("lain config set <key> <value>") + dim("   (--local for workspace)"));
    return;
  }

  // ---- config get <key> ----
  if (subcommand === "get") {
    const key = args.positional[1];
    if (!key) throw new Error("Usage: lain config get <key>");
    const field = findSettingField(key);
    if (!field) throw new Error(`Unknown setting: ${key}\nRun 'lain config list' to see all keys.`);
    const v = resolveSettingValue(field, loadConfig(), loadCredentials());
    if (asJson) { console.log(JSON.stringify(field.type === "secret" ? (v ? "***set***" : null) : v ?? null)); return; }
    console.log(displaySettingValue(field, v));
    return;
  }

  // ---- config set <key> <value> ----
  if (subcommand === "set") {
    const key = args.positional[1];
    const value = args.positional.slice(2).join(" ");
    if (!key || args.positional.length < 3) throw new Error("Usage: lain config set <key> <value>  (--local for workspace)");
    if (!findSettingField(key)) {
      throw new Error(`Unknown setting: ${key}\nRun 'lain config list' to see all keys.`);
    }
    const result = applySettings([{ key, value }], { scope: isLocal ? "workspace" : "global", cwd: process.cwd() });
    if (result.errors.length) throw new Error(`Invalid value for ${key}: ${result.errors[0].error}`);
    const field = findSettingField(key)!;
    const shown = field.type === "secret" ? "(hidden)" : value;
    console.log(`${icon.ok()} set ${c.fg(key)} = ${c.accent(shown)} ${dim(isLocal ? "(workspace)" : field.store === "credentials" ? "(credentials)" : "(global)")}`);
    return;
  }

  // ---- config unset <key> ----
  if (subcommand === "unset") {
    const key = args.positional[1];
    if (!key) throw new Error("Usage: lain config unset <key>");
    if (!findSettingField(key)) throw new Error(`Unknown setting: ${key}`);
    applySettings([{ key, value: null }], { scope: isLocal ? "workspace" : "global", cwd: process.cwd() });
    console.log(`${icon.ok()} unset ${c.fg(key)} ${dim(isLocal ? "(workspace)" : "")}`);
    return;
  }

  throw new Error("Usage: lain config <list|get|set|unset|path>");
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
// Extensions
// ============================================================================

async function runExtensions(args: ParsedArgs): Promise<void> {
  const subcommand = args.positional[0]; // "list", "add", "remove", "auth", "config"

  if (!subcommand || subcommand === "list") {
    const registry = buildExtensionRegistry();
    console.log("Built-in extensions:");
    for (const ext of registry.getAll()) {
      const ops = ext.operations?.map((o) => o.name).join(", ") || "none";
      const hasPrompt = ext.systemPrompt ? "yes" : "no";
      console.log(`  ${ext.name} v${ext.version} — prompts: ${hasPrompt}, custom ops: ${ops}`);
      if (ext.configSchema && ext.configSchema.length > 0) {
        console.log(`    config: ${ext.configSchema.map((f) => f.key).join(", ")}`);
      }
    }
    return;
  }

  // Placeholder for add/remove/auth/config — will be implemented when npm-based extensions are needed
  switch (subcommand) {
    case "add":
      console.log("Extension installation from npm is not yet implemented. Built-in extensions are available: freeform, worldbuilding, debate, research");
      break;
    case "remove":
      console.log("Extension removal is not yet implemented.");
      break;
    case "auth":
      console.log("Extension auth is not yet implemented.");
      break;
    case "config":
      console.log("Extension config is not yet implemented.");
      break;
    default:
      throw new Error(`Unknown extensions subcommand: ${subcommand}. Use: list, add, remove, auth, config`);
  }
}

// ============================================================================
// Mission — intent contract + shared knowledge library
// ============================================================================

async function runMission(args: ParsedArgs): Promise<void> {
  const dbFile = getFlag(args.flags, "db") ?? args.positional[0] ?? findDb();
  const dbPath = path.resolve(dbFile);
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbFile}`);
  const storage = new Storage(dbPath);
  try {
    const graph = new Graph(storage);
    const exp = graph.getAllExplorations()[0];
    if (!exp) throw new Error("No explorations in this database.");
    const mission = storage.getMission(exp.id);
    const findings = storage.getFindings(exp.id);

    if (!mission || mission.assertions.length === 0) {
      console.log(`No mission set for "${exp.name}". Create one with \`lain "<seed>" --mission\`.`);
    } else {
      console.log(`Mission — ${exp.name}\n`);
      console.log(`Intent:\n  ${mission.intent}\n`);

      const report = storage.getLatestMissionReport(exp.id);
      const statusById = new Map((report?.results ?? []).map((r) => [r.id, r]));
      const icon = (s?: string) => (s === "met" ? "✓" : s === "partial" ? "~" : s === "unmet" ? "✗" : "·");

      console.log(`Validation contract:`);
      for (const a of mission.assertions) {
        const r = statusById.get(a.id);
        console.log(`  ${icon(r?.status)} ${a.id}  ${a.text}`);
        if (r?.evidence) console.log(`       ${r.evidence}`);
      }

      if (mission.features.length) {
        console.log(`\nFeatures (decomposition):`);
        for (const f of mission.features) console.log(`  ${f.id}  ${f.angle}  [${f.assertions.join(", ")}]`);
      }

      if (report) {
        const met = report.results.filter((r) => r.status === "met").length;
        console.log(`\nLatest validation: ${report.satisfied ? "satisfied ✓" : "incomplete"} — ${met}/${report.results.length} met after ${report.round} round(s).`);
        if (report.summary) console.log(`  ${report.summary}`);
      } else {
        console.log(`\n(no validation run yet)`);
      }
    }

    console.log(`\nShared knowledge library (${findings.length} findings):`);
    if (findings.length === 0) {
      console.log("  (none yet)");
    } else {
      for (const f of findings) {
        console.log(`  • ${f.content}${f.tags.length ? `  [${f.tags.join(", ")}]` : ""}${f.nodeId ? `  (${f.nodeId})` : ""}`);
      }
    }
  } finally {
    storage.close();
  }
}

// ============================================================================
// MCP — remote Model Context Protocol servers (extra agent tools)
// ============================================================================

/** Redact any embedded secret-looking path segment / token for display. */
function redactUrl(url: string): string {
  return url
    .replace(/(fc-|sk-|key-|tok_|Bearer\s+)[A-Za-z0-9_-]{6,}/gi, "$1***")
    .replace(/\/[A-Za-z0-9_-]{24,}(\/|$)/g, "/***$1");
}

async function runMcp(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0] ?? "list";
  const config = loadConfig();
  const servers = config.mcpServers ?? {};

  if (sub === "list") {
    const names = Object.keys(servers);
    if (names.length === 0) {
      console.log("No MCP servers configured. Add one with `lain mcp add <name> <url>`.");
      return;
    }
    console.log("MCP servers:");
    for (const name of names) {
      const s = servers[name];
      const auth = s.headers && Object.keys(s.headers).length ? `  [auth: ${Object.keys(s.headers).join(", ")}]` : "";
      console.log(`  ${name}${s.disabled ? " (disabled)" : ""}  ${redactUrl(s.url)}${auth}`);
    }
    return;
  }

  if (sub === "add") {
    const name = args.positional[1];
    const url = args.positional[2];
    if (!name || !url) {
      throw new Error(
        "Usage: lain mcp add <name> <url> [--header 'K: V']... [--bearer <token>] [--api-key <key>] [--api-key-header <name>]"
      );
    }
    const headers: Record<string, string> = {};
    // Repeatable raw headers: --header "Authorization: Bearer xyz"
    for (const h of getMultiFlag(args.flags, "header", "H")) {
      const idx = h.indexOf(":");
      if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    }
    // Convenience: --bearer <token>  → Authorization: Bearer <token>
    const bearer = getFlag(args.flags, "bearer", "token");
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
    // Convenience: --api-key <key> [--api-key-header X-API-Key] (defaults to X-API-Key)
    const apiKey = getFlag(args.flags, "api-key", "apikey");
    if (apiKey) headers[getFlag(args.flags, "api-key-header") ?? "X-API-Key"] = apiKey;

    const next = { ...servers, [name]: { url, ...(Object.keys(headers).length ? { headers } : {}) } };
    saveConfig({ mcpServers: next });
    const authNote = Object.keys(headers).length ? ` (auth: ${Object.keys(headers).join(", ")})` : "";
    console.log(`Added MCP server "${name}"${authNote}. Test it with \`lain mcp test ${name}\`.`);
    return;
  }

  if (sub === "remove") {
    const name = args.positional[1];
    if (!name || !servers[name]) throw new Error(`No MCP server named "${name}".`);
    removeMcpServer(name); // not saveConfig — a merge would never drop the key
    console.log(`Removed MCP server "${name}".`);
    return;
  }

  if (sub === "test") {
    const name = args.positional[1];
    const toTest = name ? { [name]: servers[name] } : servers;
    if (name && !servers[name]) throw new Error(`No MCP server named "${name}".`);
    if (Object.keys(toTest).length === 0) { console.log("No MCP servers to test."); return; }
    console.log("Connecting to MCP server(s)...");
    const pool = await connectMcpServers(toTest);
    for (const conn of pool.connections) {
      console.log(`\n${conn.name} — ${conn.tools.length} tools:`);
      for (const t of conn.tools) console.log(`  ${t.spec.name}  ${truncateStr(t.spec.description, 70)}`);
    }
    for (const err of pool.errors) console.error(`  ✗ ${err.name}: ${err.error}`);
    await pool.close();
    return;
  }

  throw new Error(`Unknown mcp subcommand: ${sub}. Use: list, add, remove, test`);
}

// ============================================================================
// Tools — the agent toolbelt catalog + selection
// ============================================================================

/** Build the full tool catalog from config (probing MCP only if asked). */
async function buildCliCatalog(config: LainConfig, probe: boolean): Promise<{ catalog: ToolCatalog; close?: () => Promise<void> }> {
  const registry = buildExtensionRegistry();
  const { catalog, mcpPool } = await buildToolCatalog({
    hasCorpus: true, // catalog is descriptive; corpus tools listed regardless
    extensionGroups: registry.describeToolGroups(),
    mcpServers: config.mcpServers,
    probeMcp: probe,
  });
  return { catalog, close: mcpPool ? () => mcpPool.close() : undefined };
}

async function runTools(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0] ?? "list";
  const config = loadConfig();
  const selection = normalizeToolSelection(config.tools);

  if (sub === "list") {
    const probe = getBoolFlag(args.flags, "probe");
    const { catalog, close } = await buildCliCatalog(config, probe);
    const active = countActiveTools(catalog, selection);
    console.log("");
    console.log("  " + section("Agent toolbelt") + "  " + dim(`${active} tool(s) active by default`));
    for (const g of catalog.groups) {
      const on = isGroupEnabled(selection, g.id);
      const head = on ? icon.ok("●") : icon.dot("○");
      const meta = g.kind === "mcp" && !g.probed && !g.error ? dim("  (run --probe to list tools)") : "";
      const err = g.error ? c.red(`  ✗ ${g.error}`) : "";
      console.log(`  ${head} ${bold(c.fg(g.title))} ${dim(g.id)}${meta}${err}`);
      for (const tool of g.tools) {
        const ton = isToolEnabled(selection, g.id, tool.id);
        const mark = !on ? dim("·") : ton ? c.green("✓") : c.red("✗");
        console.log(`      ${mark} ${c.fg(tool.id.padEnd(26))} ${dim(truncateStr(tool.description, 64))}`);
      }
    }
    console.log("");
    console.log(dim("  toggle defaults: ") + c.fg("lain tools disable <id> | enable <id>") + dim("   (id = a group or a tool)"));
    if (close) await close();
    return;
  }

  if (sub === "enable" || sub === "disable") {
    const id = args.positional[1];
    if (!id) throw new Error(`Usage: lain tools ${sub} <group-or-tool-id>`);
    const enable = sub === "enable";
    // Resolve whether the id is a group or a tool by consulting the catalog.
    const { catalog, close } = await buildCliCatalog(config, false);
    if (close) await close();
    const group = catalog.groups.find((g) => g.id === id);
    let next: ToolSelection;
    if (group) {
      next = toggleGroup(selection, id, enable);
    } else {
      const known = catalog.groups.some((g) => g.tools.some((t) => t.id === id))
        || /^mcp_/.test(id); // mcp tool ids may not be in an unprobed catalog
      if (!known) throw new Error(`Unknown tool or group "${id}". Run 'lain tools list' (or '--probe' for MCP tools).`);
      next = toggleTool(selection, id, enable);
    }
    saveConfig({ tools: next });
    console.log(`${icon.ok()} ${enable ? "enabled" : "disabled"} ${c.fg(id)} ${dim("(default)")}`);
    return;
  }

  if (sub === "reset") {
    saveConfig({ tools: { disabledGroups: [], disabledTools: [] } });
    console.log(`${icon.ok()} reset tool selection — all tools enabled by default`);
    return;
  }

  throw new Error(`Unknown tools subcommand: ${sub}. Use: list, enable, disable, reset`);
}

type McpPoolType = Awaited<ReturnType<typeof connectMcpServers>>;

/**
 * Assemble the agentic toolbelt for a run: connect only the enabled MCP servers,
 * probe their tools, and resolve config defaults + CLI flag overrides into the
 * set of disabled tool ids. Shared by explore/resume/extend so tool selection is
 * honored everywhere. Caller owns the returned mcpPool (must close it).
 */
async function assembleRunToolbelt(
  config: LainConfig,
  args: ParsedArgs,
  registry: ReturnType<typeof buildExtensionRegistry>,
  opts: { hasCorpus: boolean; ext: string },
): Promise<{ mcpPool: McpPoolType | null; disabledToolIds: string[]; activeCount: number }> {
  // Catalog-independent pre-selection (so we connect only enabled servers).
  let preSel = normalizeToolSelection(config.tools);
  for (const id of getMultiFlag(args.flags, "disable-tool")) preSel = toggleTool(preSel, id, false);
  for (const id of getMultiFlag(args.flags, "enable-tool")) preSel = toggleTool(preSel, id, true);
  for (const id of getMultiFlag(args.flags, "disable-group")) preSel = toggleGroup(preSel, id, false);
  if (getBoolFlag(args.flags, "no-mcp")) {
    for (const name of Object.keys(config.mcpServers ?? {})) preSel = toggleGroup(preSel, `mcp:${name}`, false);
  }
  const enabledServers: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(config.mcpServers ?? {})) {
    if (!cfg.disabled && isGroupEnabled(preSel, `mcp:${name}`)) enabledServers[name] = cfg;
  }
  const built = await buildToolCatalog({
    hasCorpus: opts.hasCorpus,
    extensionGroups: registry.describeToolGroups([opts.ext]),
    mcpServers: enabledServers,
    probeMcp: true,
  });
  const runSel = resolveRunSelection(config, args, built.catalog);
  return {
    mcpPool: built.mcpPool ?? null,
    disabledToolIds: resolveDisabledToolIds(built.catalog, runSel),
    activeCount: countActiveTools(built.catalog, runSel),
  };
}

/**
 * Resolve the effective per-run tool selection: config defaults, then CLI-flag
 * overrides (--enable-tool/--disable-tool/--disable-group/--no-mcp/--only-tools).
 */
function resolveRunSelection(config: LainConfig, args: ParsedArgs, catalog: ToolCatalog): ToolSelection {
  let sel = normalizeToolSelection(config.tools);
  for (const id of getMultiFlag(args.flags, "disable-tool")) sel = toggleTool(sel, id, false);
  for (const id of getMultiFlag(args.flags, "enable-tool")) sel = toggleTool(sel, id, true);
  for (const id of getMultiFlag(args.flags, "disable-group")) sel = toggleGroup(sel, id, false);
  if (getBoolFlag(args.flags, "no-mcp")) {
    for (const g of catalog.groups) if (g.kind === "mcp") sel = toggleGroup(sel, g.id, false);
  }
  // Allowlist: disable everything not named (matches groups or tools).
  const only = getMultiFlag(args.flags, "only-tools").flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  if (only.length) {
    const allow = new Set(only);
    for (const g of catalog.groups) {
      if (allow.has(g.id)) continue;
      for (const tool of g.tools) if (!allow.has(tool.id)) sel = toggleTool(sel, tool.id, false);
      if (g.tools.length === 0 && !allow.has(g.id)) sel = toggleGroup(sel, g.id, false);
    }
  }
  return sel;
}

// ============================================================================
// Corpus — multimodal source material for agentic explorations
// ============================================================================

async function runCorpus(args: ParsedArgs): Promise<void> {
  const subcommand = args.positional[0] ?? "list";
  const dbFile = getFlag(args.flags, "db") ?? findDb();
  const dbPath = path.resolve(dbFile);
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbFile}`);

  const storage = new Storage(dbPath);
  try {
    const graph = new Graph(storage);
    const explorations = graph.getAllExplorations();
    if (explorations.length === 0) throw new Error("No explorations in this database.");
    const explorationId = getFlag(args.flags, "id") ?? explorations[0].id;
    if (!explorations.some((e) => e.id === explorationId)) {
      throw new Error(`Exploration not found: ${explorationId}`);
    }
    const corpus = new Corpus(storage);

    if (subcommand === "add") {
      const paths = args.positional.slice(1);
      if (paths.length === 0) throw new Error("Usage: lain corpus add <file|dir>... [--db <file>] [--id <exploration>]");
      let sources = 0;
      let chunks = 0;
      for (const p0 of paths) {
        const resolved = path.resolve(p0);
        if (!fs.existsSync(resolved)) {
          console.warn(`  Skipping (not found): ${p0}`);
          continue;
        }
        const results = fs.statSync(resolved).isDirectory()
          ? await corpus.ingestDirectory(explorationId, resolved)
          : [await corpus.ingestFile(explorationId, resolved)];
        for (const r of results) {
          sources++;
          chunks += r.chunkCount;
          console.log(`  + ${r.source.name} [${r.source.kind}] — ${r.chunkCount} chunk(s)`);
        }
      }
      console.log(`\nIngested ${sources} source(s), ${chunks} chunk(s) into ${explorationId}.`);
      return;
    }

    if (subcommand === "list") {
      const sources = corpus.listSources(explorationId);
      if (sources.length === 0) {
        console.log(`No corpus sources for ${explorationId}. Add some with \`lain corpus add <files>\`.`);
        return;
      }
      console.log(`Corpus for ${explorationId} (${sources.length} sources):`);
      for (const s of sources) {
        const size = s.byteSize ? `${(s.byteSize / 1024).toFixed(1)}kb` : "?";
        console.log(`  ${s.name} [${s.kind}] ${size}`);
      }
      return;
    }

    if (subcommand === "search") {
      const query = args.positional.slice(1).join(" ");
      if (!query) throw new Error("Usage: lain corpus search <query> [--db <file>]");
      const hits = corpus.search(explorationId, query, getNumFlag(args.flags, "limit") ?? 6);
      if (hits.length === 0) {
        console.log(`No matches for "${query}".`);
        return;
      }
      for (const h of hits) {
        console.log(`\n[${h.score.toFixed(2)}] ${h.sourceName} (${h.sourceKind})`);
        console.log(`  ${truncateStr(h.chunk.text, 200)}`);
      }
      return;
    }

    throw new Error(`Unknown corpus subcommand: ${subcommand}. Use: add, list, search`);
  } finally {
    storage.close();
  }
}

// ============================================================================
// Distribution & lifecycle: version / doctor / update / uninstall
// ============================================================================

/** Resolve the lain repo root from this bundled file's location. */
function repoRoot(): string {
  // dist file lives at <repo>/packages/cli/dist/index.js
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** True when running as the compiled single binary (version baked in at build). */
export function isCompiledBinary(): boolean {
  return !!process.env.LAIN_VERSION;
}

function lainVersion(): string {
  // Baked in at binary-compile time (scripts/build-binary.ts).
  if (process.env.LAIN_VERSION) return process.env.LAIN_VERSION;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot(), "packages/cli/package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function gitInfo(root: string): { commit: string; branch: string } | null {
  // Baked in at binary-compile time — git isn't available inside the binary.
  if (process.env.LAIN_COMMIT) {
    return { commit: process.env.LAIN_COMMIT, branch: process.env.LAIN_BRANCH || "release" };
  }
  const opts = { encoding: "utf-8" as const, stdio: ["ignore", "pipe", "ignore"] as const };
  try {
    const commit = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], opts).trim();
    const branch = execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], opts).trim();
    return { commit, branch };
  } catch {
    return null;
  }
}

function runVersion(): void {
  const root = repoRoot();
  const git = gitInfo(root);
  console.log(banner(lainVersion()));
  console.log(kv("commit", git ? `${git.branch} ${c.cyan(git.commit)}` : dim("not a git checkout")));
  console.log(kv("schema", `v${CURRENT_SCHEMA_VERSION}`));
  console.log(kv("runtime", `bun ${process.versions.bun ?? "?"}`));
  if (isCompiledBinary()) console.log(kv("build", dim(`single binary (${process.platform}-${process.arch})`)));
  else console.log(kv("source", dim(root)));
  console.log("");
}

async function runDoctor(): Promise<void> {
  const root = repoRoot();
  const ok = (b: boolean) => (b ? icon.ok() : icon.err());
  console.log(banner(lainVersion()));
  console.log(rule("doctor"));

  const bunOk = !!process.versions.bun;
  console.log(`  ${ok(bunOk)} bun runtime ${dim(process.versions.bun ?? "(not running under bun!)")}`);

  if (isCompiledBinary()) {
    // Single binary: no toolchain or dist on disk — it's all baked in.
    console.log(`  ${icon.ok()} single binary ${dim(`(${process.platform}-${process.arch}, ${lainVersion()})`)}`);
  } else {
    let pnpmOk = false;
    try { execFileSync("pnpm", ["--version"], { stdio: "ignore" }); pnpmOk = true; } catch {}
    console.log(`  ${ok(pnpmOk)} pnpm available`);

    const distOk = fs.existsSync(path.join(root, "packages/cli/dist/index.js"));
    console.log(`  ${ok(distOk)} build present ${dim(distOk ? "(dist/)" : "(run `lain update`)")}`);
  }

  const cfgOk = configExists();
  console.log(`  ${ok(cfgOk)} global config ${dim(cfgOk ? "(~/.config/lain)" : "(run `lain init`)")}`);

  if (cfgOk) {
    const config = loadConfig();
    const creds = loadCredentials();
    const prov = config.defaultProvider;
    const hasKey =
      (prov === "bedrock" && (creds.bedrock?.apiKey || process.env.AWS_BEARER_TOKEN_BEDROCK)) ||
      (prov === "anthropic" && (creds.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY)) ||
      (prov === "openai" && (creds.openai?.apiKey || process.env.OPENAI_API_KEY)) ||
      (prov === "openrouter" && (creds.openrouter?.apiKey || process.env.OPENROUTER_API_KEY));
    console.log(`  ${ok(!!hasKey)} ${c.accent(prov)} credentials ${dim(`(model: ${config.defaultModel})`)}`);
    const mcpCount = Object.keys(config.mcpServers ?? {}).length;
    console.log(`  ${icon.dot()} ${mcpCount} MCP server(s) configured`);
  }

  if (isCompiledBinary()) {
    const git = gitInfo(root);
    console.log(`  ${icon.dot()} ${dim(`release ${git?.commit ?? ""} — update with`)} ${c.cyan("lain update")}`);
    console.log("");
    return;
  }

  const git = gitInfo(root);
  console.log(`  ${icon.dot()} ${git ? `git ${git.branch} @ ${c.cyan(git.commit)}` : dim("not a git checkout (self-update unavailable)")}`);

  const update = await checkForUpdate(root);
  if (update.available) console.log(`  ${c.yellow("↑")} update available (${update.remote}) — run ${c.cyan("lain update")}`);
  else if (git) console.log(`  ${icon.ok()} up to date`);
  console.log("");
}

const INSTALL_ONE_LINER = "curl -fsSL https://tetraslam.github.io/lain/install | bash";

function runUpdate(): void {
  const root = repoRoot();
  if (isCompiledBinary()) {
    // Single binary: re-run the installer, which fetches the latest binary.
    console.log("Updating lain (re-running the installer for the latest binary)...");
    try {
      execFileSync("bash", ["-c", INSTALL_ONE_LINER], { stdio: "inherit" });
      console.log(`\nUpdated. Your explorations (.db) and config are untouched.`);
    } catch (err: any) {
      console.error(`Update failed: ${err.message}\nRe-run manually:\n  ${INSTALL_ONE_LINER}`);
    }
    return;
  }
  if (!gitInfo(root)) {
    console.error("lain isn't a git checkout here, so `update` can't pull. Reinstall from source.");
    return;
  }
  console.log("Updating lain (git pull + rebuild)...");
  try {
    console.log(execFileSync("git", ["-C", root, "pull", "--ff-only"], { encoding: "utf-8" }).trim());
    execFileSync("pnpm", ["-C", root, "install"], { stdio: "inherit" });
    execFileSync("pnpm", ["-C", root, "build"], { stdio: "inherit" });
    clearUpdateCache(); // so the next check re-fetches against the new HEAD
    const git = gitInfo(root);
    console.log(`\nUpdated to ${lainVersion()}${git ? ` (${git.commit})` : ""}. Your explorations (.db) and config are untouched.`);
  } catch (err: any) {
    console.error(`Update failed: ${err.message}`);
  }
}

function runUninstall(): void {
  const binDir = process.env.LAIN_BIN_DIR || path.join(os.homedir(), ".local", "bin");
  const launcher = path.join(binDir, "lain");
  console.log("To uninstall lain:\n");
  if (fs.existsSync(launcher)) {
    console.log(`  rm ${launcher}            # remove the launcher`);
  }
  console.log(`  rm -rf ${repoRoot()}   # remove the source checkout (optional)`);
  console.log(`  rm -rf ~/.config/lain      # remove config + credentials (optional — deletes your keys)`);
  console.log(`\nYour exploration .db files live wherever you created them and are never touched.`);
  console.log(`(Run \`bash ${path.join(repoRoot(), "uninstall.sh")}\` to remove the launcher automatically.)`);
}

// ============================================================================
// Help
// ============================================================================

function runHelp(): void {
  console.log(banner(lainVersion()));
  console.log(`${section("Usage")}
  ${c.accent('lain "<idea>"')} [options]         Start a new exploration
  lain explore --seed <file> [options]

${section("Options")}
  -n, --branches <n>     Branches per node (default: 3)
  -m, --depth <m>        Max depth (default: 3)
  --strategy <bf|df>     Breadth-first or depth-first (default: bf)
  --plan <level>         Plan detail: brief, sentence, detailed, none (default: sentence)
  --ext <name>           Extension to use (default: freeform)
  --db <file>            Database file to use
  -o, --output <file>    Output database filename
  -c, --concurrency <n>  Max parallel agent calls (default: 5)
  --corpus <path>        Ingest a file/dir as source material before generating
  --mission [intent]     Interview → validation contract → pursue it autonomously
  --mission-json <j>     Use a prebuilt mission (JSON file or inline) — scriptable
  --mission-rounds <n>   Max validate→fix rounds for a mission (default: 2)
  --non-interactive      Skip the mission interview; auto-derive the contract (also --yes)
  --max-steps <n>        Max agent tool round-trips per node (default: 50)
  --disable-tool <id>    Drop a tool for this run (repeatable; also --enable-tool)
  --disable-group <id>   Drop a whole group, e.g. corpus / ext:worldbuilding / mcp:firecrawl
  --only-tools <ids>     Allowlist: enable ONLY these tools/groups (comma-separated)
  --no-mcp               Don't connect any MCP servers for this run

${section("Commands")}
  init                   Set up global config (--workspace for local, --non-interactive for agents)
  status                 Show explorations in current directory
  show <node-id>         Display a node
  tree [exploration-id]  Print tree structure
  prune <node-id>        Prune a node and descendants
  redirect <node-id>     Regenerate a node with fresh content
  extend <node-id>       Generate more children (--n <count>)
  resume [file.db]       Finish an interrupted run (generates any pending nodes)
  link <node-a> <node-b> Add a cross-link (--label 'description')
  synthesize [file.db]   Run synthesis pass (--auto-merge to apply immediately)
  merge-synthesis <id>   Apply synthesis annotations (--annotation <id>, --dismiss)
  conflicts [file.db]    List/resolve sync conflicts (--resolve theirs|ours)
  sync <file.db>         Bidirectional sync (--push, --pull, --status)
  export <file.db>       One-shot export to markdown (--out <dir>, --canvas for .canvas)
  config list            Show all settings, sectioned (--json)
  config get <key>       Read one setting
  config set <k> <v>     Set a setting (validated; --local for workspace)
  config unset <key>     Clear a setting (--local for workspace)
  config path            Show config/credential file locations
  watch <file.db>        Auto-sync on file changes (--stop, --status)
  extensions [list]      List available extensions
  corpus add <path>...   Ingest files/dirs as source material (--db, --id)
  corpus list            List corpus sources (--db, --id)
  corpus search <query>  Search the corpus (--db, --id, --limit)
  mcp add <name> <url>   Add a remote MCP server (--header 'K: V')
  mcp list               List configured MCP servers
  mcp test [name]        Connect + list a server's tools
  mcp remove <name>      Remove an MCP server
  tools list             Show the agent toolbelt (--probe to list MCP tools)
  tools enable/disable   Toggle a group or tool by id (default selection)
  tools reset            Re-enable all tools by default
  mission [file.db]      Show the intent contract + shared knowledge library
  tui [file.db]          Launch interactive TUI
  serve [dir]            Start web API server (--port <n>, default 3001)
  version                Show version, schema, and build info (also --version)
  doctor                 Diagnose install, config, and credentials
  update                 Update lain in place (git pull + rebuild; dbs untouched)
  uninstall              How to remove lain
  help                   Show this help

${section("Extensions")} ${dim("(use with --ext <name>)")}
  freeform               No constraints, pure divergent thinking (default)
  worldbuilding          Structured worldbuilding (geography, cultures, history, magic)
  debate                 Adversarial argumentation (pro/con/steelman/critique)
  research               Academic exploration with citations and methodology

Non-interactive mode (for agents):
  lain init --non-interactive --provider anthropic --api-key sk-...
  lain init --non-interactive --provider bedrock --api-key ABSK... --region us-west-2
  lain "idea" -n 3 -m 2 --db output.db
   lain export output.db --out ./my-exploration
   lain export output.db --canvas
   lain sync output.db --push
`);
}

