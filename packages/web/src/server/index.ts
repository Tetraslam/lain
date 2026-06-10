/**
 * Lain API server — thin HTTP layer over @lain/core.
 * Serves REST endpoints + SSE for streaming.
 * Run with: bun run src/server/index.ts
 */
import { Storage, Graph, Orchestrator, Sync, Exporter, SynthesisEngine, Corpus, checkForUpdate, collectDbFiles, addRecentDb, getDiscoveryDirs, addDiscoveryDir, removeDiscoveryDir, interviewMission, buildToolCatalog, type InterviewTurn } from "@lain/core";
import { createProvider } from "@lain/agents";
import { buildExtensionRegistry } from "@lain/extensions";
import { generateId, loadConfig, loadCredentials, saveConfig, buildSettingsView, applySettings, configPaths, normalizeToolSelection, removeMcpServer, resolveDisabledToolIds, type Strategy, type PlanDetail, type Provider, type Credentials, type LainConfig, type Mission, type SettingUpdate, type ToolSelection, type McpServerConfig } from "@lain/shared";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let PORT = Number(process.env.LAIN_PORT) || 3001;
let CWD = process.env.LAIN_CWD || process.cwd();
// When running inside the compiled single binary, the built web client is
// embedded as a string and injected via startServer(); otherwise we read from
// the dist/ directory on disk (source / dev).
let EMBEDDED_CLIENT: string | null = null;

function makeAgent(config: LainConfig, credentials: Credentials) {
  const provider = config.defaultProvider;
  const maxTokens = config.maxTokens;
  switch (provider) {
    case "bedrock":
      return createProvider({
        provider: "bedrock",
        model: config.defaultModel,
        apiKey: credentials.bedrock?.apiKey || process.env.AWS_BEARER_TOKEN_BEDROCK,
        region: credentials.bedrock?.region || "us-west-2",
        maxTokens,
      });
    case "anthropic":
      return createProvider({ provider: "anthropic", model: config.defaultModel, apiKey: credentials.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY, maxTokens });
    case "openai":
      return createProvider({ provider: "openai", model: config.defaultModel, apiKey: credentials.openai?.apiKey || process.env.OPENAI_API_KEY, baseUrl: credentials.openai?.baseUrl || process.env.OPENAI_BASE_URL, maxTokens });
    case "openrouter":
      return createProvider({ provider: "openrouter", model: config.defaultModel, apiKey: credentials.openrouter?.apiKey || process.env.OPENROUTER_API_KEY, baseUrl: credentials.openrouter?.baseUrl, maxTokens });
    default:
      return createProvider({ provider, model: config.defaultModel, maxTokens });
  }
}

// Find all .db files
function discoverDbs(): { path: string; name: string; explorations: any[] }[] {
  const results: any[] = [];
  // CWD (+parents) + user-configured dirs + recently-opened dbs.
  for (const full of collectDbFiles(CWD)) {
    try {
      const s = new Storage(full);
      const g = new Graph(s);
      const exps = g.getAllExplorations().map((e) => ({
        ...e,
        nodeCount: g.getAllNodes(e.id).filter((n) => n.status !== "pruned").length,
      }));
      s.close();
      if (exps.length > 0) results.push({ path: full, name: path.basename(full), explorations: exps });
    } catch {}
  }
  return results;
}

// JSON helper
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

/**
 * Validate that a dbFile path doesn't escape the CWD via traversal.
 * Returns the resolved path or null if invalid.
 */
function safeDbPath(dbFile: string): string | null {
  if (!dbFile.endsWith(".db")) return null;
  // 1) Within the CWD subtree (where new explorations are written).
  const inCwd = path.resolve(CWD, dbFile);
  if (inCwd.startsWith(CWD) && fs.existsSync(inCwd)) return inCwd;
  // 2) A discovered db (recents / configured dirs), matched by abs path or basename.
  const known = collectDbFiles(CWD);
  const abs = path.resolve(dbFile);
  if (known.includes(abs)) return abs;
  return known.find((f) => path.basename(f) === path.basename(dbFile)) ?? null;
}

// ============================================================================
// Server
// ============================================================================

async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === "OPTIONS") return cors();

    // ---- Discovery ----
    if (p === "/api/explorations" && req.method === "GET") {
      return json(discoverDbs());
    }

    // ---- Version + update check ----
    if (p === "/api/version" && req.method === "GET") {
      let update = { available: false, current: null as string | null, remote: null as string | null };
      try { update = await checkForUpdate(REPO_ROOT); } catch { /* fail-silent */ }
      return json({ update });
    }

    // ---- Discovery directories ----
    if (p === "/api/dirs" && req.method === "GET") {
      return json({ dirs: getDiscoveryDirs(), cwd: CWD });
    }

    // ---- Settings (schema-driven, secrets redacted) ----
    if (p === "/api/config" && req.method === "GET") {
      const view = buildSettingsView(loadConfig(CWD), loadCredentials());
      return json({ ...view, paths: configPaths(CWD) });
    }
    if (p === "/api/config" && req.method === "PUT") {
      const body = await req.json() as { updates: SettingUpdate[]; scope?: "global" | "workspace" };
      const result = applySettings(body.updates ?? [], { scope: body.scope ?? "global", cwd: CWD });
      const view = buildSettingsView(loadConfig(CWD), loadCredentials());
      return json({ ...result, ...view });
    }
    // Test a provider connection with a tiny live ping (uses pending edits if provided).
    if (p === "/api/config/test" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { provider?: Provider; model?: string; credentials?: Credentials };
      const config = loadConfig(CWD);
      const credentials = { ...loadCredentials(), ...(body.credentials ?? {}) };
      const provider = body.provider ?? config.defaultProvider;
      const model = body.model ?? config.defaultModel;
      try {
        const cred = (credentials as any)[provider] ?? {};
        const agent = createProvider({
          provider, model, maxTokens: 16,
          apiKey: cred.apiKey
            ?? (provider === "bedrock" ? process.env.AWS_BEARER_TOKEN_BEDROCK
              : provider === "anthropic" ? process.env.ANTHROPIC_API_KEY
              : provider === "openai" ? process.env.OPENAI_API_KEY
              : process.env.OPENROUTER_API_KEY),
          baseUrl: cred.baseUrl,
          region: cred.region || "us-west-2",
        });
        const reply = await agent.generateRaw("Reply with the single word: ok", "ping");
        return json({ ok: true, provider, model: agent.modelId, sample: reply.slice(0, 40) });
      } catch (err: any) {
        return json({ ok: false, provider, model, error: err.message }, 200);
      }
    }
    // ---- Tool catalog + selection ----
    // GET /api/tools?probe=1 → { catalog, selection }. Probe connects MCP servers
    // to enumerate their real tools (closed immediately after listing).
    if (p === "/api/tools" && req.method === "GET") {
      const config = loadConfig(CWD);
      const registry = buildExtensionRegistry();
      const probe = url.searchParams.get("probe") === "1";
      const { catalog, mcpPool } = await buildToolCatalog({
        hasCorpus: true,
        extensionGroups: registry.describeToolGroups(),
        mcpServers: config.mcpServers,
        probeMcp: probe,
      });
      if (mcpPool) await mcpPool.close();
      return json({ catalog, selection: normalizeToolSelection(config.tools) });
    }
    if (p === "/api/tools" && req.method === "PUT") {
      const body = await req.json() as { selection: ToolSelection };
      saveConfig({ tools: normalizeToolSelection(body.selection) });
      return json({ ok: true, selection: normalizeToolSelection(body.selection) });
    }

    // ---- MCP server management ----
    if (p === "/api/mcp" && req.method === "GET") {
      const config = loadConfig(CWD);
      return json({ servers: config.mcpServers ?? {} });
    }
    if (p === "/api/mcp" && req.method === "POST") {
      const body = await req.json() as { name: string; url: string; headers?: Record<string, string> };
      if (!body.name?.trim() || !body.url?.trim()) return json({ error: "name and url required" }, 400);
      const config = loadConfig(CWD);
      const servers = { ...(config.mcpServers ?? {}) };
      servers[body.name.trim()] = { url: body.url.trim(), ...(body.headers && Object.keys(body.headers).length ? { headers: body.headers } : {}) };
      saveConfig({ mcpServers: servers });
      // Probe just-added server so the UI can confirm + show its tools.
      const { mcpPool } = await buildToolCatalog({ mcpServers: { [body.name.trim()]: servers[body.name.trim()] }, probeMcp: true });
      const conn = mcpPool?.connections[0];
      const err = mcpPool?.errors[0];
      if (mcpPool) await mcpPool.close();
      return json({ ok: !err, server: body.name.trim(), toolCount: conn?.tools.length ?? 0, error: err?.error });
    }
    if (p === "/api/mcp" && req.method === "DELETE") {
      const body = await req.json() as { name: string };
      removeMcpServer(body.name); // not saveConfig — a merge would never drop the key
      return json({ ok: true });
    }

    if (p === "/api/dirs" && req.method === "POST") {
      const { dir } = await req.json() as { dir: string };
      if (!dir?.trim()) return json({ error: "dir required" }, 400);
      const resolved = addDiscoveryDir(dir.trim());
      if (!fs.existsSync(resolved)) { removeDiscoveryDir(resolved); return json({ error: `Not found: ${resolved}` }, 400); }
      return json({ ok: true, dirs: getDiscoveryDirs() });
    }
    if (p === "/api/dirs" && req.method === "DELETE") {
      const { dir } = await req.json() as { dir: string };
      removeDiscoveryDir(dir);
      return json({ ok: true, dirs: getDiscoveryDirs() });
    }

    // ---- Get exploration data ----
    if (p.match(/^\/api\/exploration\/[^/]+$/) && req.method === "GET") {
      const dbFile = decodeURIComponent(p.split("/").pop()!);
      const dbPath = safeDbPath(dbFile);
      if (!dbPath) return json({ error: "Not found" }, 404);
      addRecentDb(dbPath);

      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exps = g.getAllExplorations();
      if (exps.length === 0) { s.close(); return json({ error: "No explorations" }, 404); }
      const exp = exps[0];
      const nodes = g.getAllNodes(exp.id);
      const crosslinks = g.getCrosslinks(exp.id);
      // Gather node annotations + citations (per node id)
      const nodeAnnotations: Record<string, any[]> = {};
      const citations: Record<string, any[]> = {};
      for (const node of nodes) {
        const anns = s.getNodeAnnotations(node.id);
        if (anns.length > 0) nodeAnnotations[node.id] = anns;
        const cites = s.getCitationsForNode(node.id);
        if (cites.length > 0) citations[node.id] = cites;
      }
      s.close();

      return json({ exploration: exp, nodes, crosslinks, nodeAnnotations, citations });
    }

    // ---- Get single node ----
    if (p.match(/^\/api\/node\/[^/]+\/[^/]+$/) && req.method === "GET") {
      const parts = p.split("/");
      const nodeId = decodeURIComponent(parts.pop()!);
      const dbFile = decodeURIComponent(parts.pop()!);
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);

      const s = new Storage(dbPath);
      const g = new Graph(s);
      const node = g.getNode(nodeId);
      const crosslinks = node ? g.getCrosslinksForNode(nodeId) : [];
      const ancestors = node ? g.getAncestorChain(nodeId) : [];
      s.close();

      return json({ node, crosslinks, ancestors });
    }

    // ---- Create exploration (with SSE streaming) ----
    // Mission clarification interview — one stateless turn. The client keeps the
    // running history and re-posts it; returns either more questions or the
    // finalized contract (the cognitive-frontloading gate before any generation).
    if (p === "/api/mission/interview" && req.method === "POST") {
      const body = await req.json() as {
        seed: string; n?: number; extension?: string; history?: InterviewTurn[];
      };
      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = makeAgent(config, credentials);
      const result = await interviewMission(
        agent, "pending", body.seed, body.n || config.defaultN,
        body.history ?? [], { extension: body.extension || config.defaultExtension },
      );
      return json(result);
    }

    if (p === "/api/create" && req.method === "POST") {
      // Accept either JSON (text-only) or multipart/form-data (with file uploads).
      const contentType = req.headers.get("content-type") || "";
      let body: {
        seed: string; n?: number; m?: number; extension?: string;
        strategy?: string; planDetail?: string;
        corpusSources?: { name: string; text: string }[];
        mission?: Mission | null; missionRounds?: number;
        toolSelection?: ToolSelection | null; saveToolsDefault?: boolean;
      };
      let uploadedFiles: File[] = [];

      if (contentType.includes("multipart/form-data")) {
        const form = await req.formData();
        const missionRaw = form.get("mission");
        const selRaw = form.get("toolSelection");
        body = {
          seed: String(form.get("seed") ?? ""),
          n: Number(form.get("n")) || undefined,
          m: Number(form.get("m")) || undefined,
          extension: (form.get("extension") as string) || undefined,
          mission: typeof missionRaw === "string" && missionRaw ? JSON.parse(missionRaw) as Mission : null,
          toolSelection: typeof selRaw === "string" && selRaw ? JSON.parse(selRaw) as ToolSelection : null,
          saveToolsDefault: form.get("saveToolsDefault") === "true",
        };
        uploadedFiles = form.getAll("files").filter((v): v is File => typeof v !== "string");
      } else {
        body = await req.json();
      }

      // Persist the per-run selection as the new default if asked.
      if (body.toolSelection && body.saveToolsDefault) {
        saveConfig({ tools: normalizeToolSelection(body.toolSelection) });
      }

      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = makeAgent(config, credentials);
      const extensions = buildExtensionRegistry();

      const seed = body.seed;
      const n = body.n || config.defaultN;
      const m = body.m || config.defaultM;
      const ext = body.extension || config.defaultExtension;
      const strategy = (body.strategy || config.defaultStrategy) as Strategy;
      const planDetail = (body.planDetail || config.defaultPlanDetail) as PlanDetail;

      const slugName = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
      let dbFileName = `${slugName}.db`;
      if (fs.existsSync(path.join(CWD, dbFileName))) {
        dbFileName = `${slugName}-${generateId().slice(0, 4)}.db`;
      }
      const dbPath = path.join(CWD, dbFileName);
      const expId = generateId();

      // SSE streaming response
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: string, data: unknown) => {
            controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };

          // Resolve the run's tool selection (per-run override or config default),
          // connect only the enabled MCP servers, and compute disabled tool ids.
          const selection = normalizeToolSelection(body.toolSelection ?? config.tools);
          let mcpPool: Awaited<ReturnType<typeof buildToolCatalog>>["mcpPool"] = undefined;
          let disabledToolIds: string[] = [];
          {
            const enabledServers: Record<string, McpServerConfig> = {};
            for (const [name, cfg] of Object.entries(config.mcpServers ?? {})) {
              if (!cfg.disabled && !selection.disabledGroups.includes(`mcp:${name}`)) enabledServers[name] = cfg;
            }
            const built = await buildToolCatalog({
              hasCorpus: uploadedFiles.length > 0 || (body.corpusSources?.length ?? 0) > 0,
              extensionGroups: extensions.describeToolGroups([ext]),
              mcpServers: enabledServers,
              probeMcp: true,
            });
            mcpPool = built.mcpPool;
            disabledToolIds = resolveDisabledToolIds(built.catalog, selection);
            if (mcpPool && mcpPool.tools.length > 0) send("tools:mcp", { tools: mcpPool.tools.length, servers: mcpPool.connections.length });
          }

          try {
            const orchestrator = new Orchestrator({
              dbPath, agent, concurrency: config.concurrency, extensions,
              agentMaxTokens: config.maxTokens,
              extraTools: mcpPool?.tools ?? [],
              disabledTools: disabledToolIds,
              onEvent: (event) => {
                send(event.type, { nodeId: event.nodeId, data: event.data });
              },
            });

            await orchestrator.explore({
              id: expId, name: seed, seed, n, m, strategy, planDetail, extension: ext,
              beforeExpand: async () => {
                if (hasMission) {
                  orchestrator.getStorage().upsertMission({ ...body.mission!, explorationId: expId });
                  send("mission:set", { assertions: body.mission!.assertions.length, features: body.mission!.features.length });
                }
                const corpus = orchestrator.getCorpus();
                if (!corpus) return;
                let count = 0;
                for (const src of body.corpusSources ?? []) {
                  corpus.ingestText(expId, { name: src.name, text: src.text });
                  count++;
                }
                for (const file of uploadedFiles) {
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  await corpus.ingestBuffer(expId, file.name, bytes);
                  count++;
                }
                if (count > 0) send("corpus:ingested", { count });
              },
            });

            if (hasMission) {
              await orchestrator.pursueMission(expId, { maxRounds: body.missionRounds ?? 2 });
            }
            orchestrator.close();

            send("complete", { dbFile: dbFileName, explorationId: expId });
          } catch (err: any) {
            send("error", { message: err.message });
          } finally {
            if (mcpPool) await mcpPool.close();
          }

          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ---- Prune ----
    if (p === "/api/prune" && req.method === "POST") {
      const { dbFile, nodeId } = await req.json() as { dbFile: string; nodeId: string };
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      g.pruneNode(nodeId);
      s.close();
      return json({ ok: true });
    }

    // ---- Extend ----
    if (p === "/api/extend" && req.method === "POST") {
      const { dbFile, nodeId, n } = await req.json() as { dbFile: string; nodeId: string; n?: number };
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);
      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = makeAgent(config, credentials);
      const extensions = buildExtensionRegistry();

      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exp = g.getAllExplorations()[0];
      s.close();
      if (!exp) return json({ error: "No exploration" }, 404);

      const probe = new Storage(dbPath);
      const hasCorpus = new Corpus(probe).listSources(exp.id).length > 0;
      probe.close();

      // Honor the default tool selection: connect only enabled MCP servers + drop disabled tools.
      const selection = normalizeToolSelection(config.tools);
      let mcpPool: Awaited<ReturnType<typeof buildToolCatalog>>["mcpPool"] = undefined;
      let disabledToolIds: string[] = [];
      {
        const enabledServers: Record<string, McpServerConfig> = {};
        for (const [name, cfg] of Object.entries(config.mcpServers ?? {})) {
          if (!cfg.disabled && !selection.disabledGroups.includes(`mcp:${name}`)) enabledServers[name] = cfg;
        }
        const built = await buildToolCatalog({
          hasCorpus, extensionGroups: extensions.describeToolGroups([exp.extension]),
          mcpServers: enabledServers, probeMcp: true,
        });
        mcpPool = built.mcpPool;
        disabledToolIds = resolveDisabledToolIds(built.catalog, selection);
      }

      const orchestrator = new Orchestrator({
        dbPath: dbPath, agent, extensions,
        agentMaxTokens: config.maxTokens,
        extraTools: mcpPool?.tools ?? [], disabledTools: disabledToolIds,
      });
      const newNodes = await orchestrator.extendNode(exp.id, nodeId, n || exp.n);
      orchestrator.close();
      if (mcpPool) await mcpPool.close();
      return json({ nodes: newNodes });
    }

    // ---- Corpus: list ----
    if (p.match(/^\/api\/corpus\/[^/]+$/) && req.method === "GET") {
      const dbFile = decodeURIComponent(p.split("/").pop()!);
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exp = g.getAllExplorations()[0];
      if (!exp) { s.close(); return json({ error: "No exploration" }, 404); }
      const sources = new Corpus(s).listSources(exp.id).map((src) => ({
        id: src.id, name: src.name, kind: src.kind, byteSize: src.byteSize,
      }));
      s.close();
      return json({ sources });
    }

    // ---- Corpus: upload (multipart files) ----
    if (p === "/api/corpus/upload" && req.method === "POST") {
      const form = await req.formData();
      const dbFile = String(form.get("dbFile") ?? "");
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exp = g.getAllExplorations()[0];
      if (!exp) { s.close(); return json({ error: "No exploration" }, 404); }
      const corpus = new Corpus(s);
      const ingested: { name: string; chunks: number }[] = [];
      try {
        for (const value of form.getAll("files")) {
          if (typeof value === "string") continue;
          const file = value as File;
          const bytes = new Uint8Array(await file.arrayBuffer());
          const res = await corpus.ingestBuffer(exp.id, file.name, bytes);
          ingested.push({ name: res.source.name, chunks: res.chunkCount });
        }
        return json({ ok: true, ingested });
      } catch (err: any) {
        return json({ error: err.message }, 500);
      } finally {
        s.close();
      }
    }

    // ---- Redirect ----
    if (p === "/api/redirect" && req.method === "POST") {
      const { dbFile, nodeId } = await req.json() as { dbFile: string; nodeId: string };
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);
      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = makeAgent(config, credentials);

      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exp = g.getAllExplorations()[0];
      s.close();
      if (!exp) return json({ error: "No exploration" }, 404);

      const orchestrator = new Orchestrator({ dbPath: dbPath, agent });
      const updated = await orchestrator.redirectNode(exp.id, nodeId);
      orchestrator.close();
      return json({ node: updated });
    }

    // ---- Link ----
    if (p === "/api/link" && req.method === "POST") {
      const { dbFile, sourceId, targetId, label } = await req.json() as { dbFile: string; sourceId: string; targetId: string; label?: string };
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      g.addCrosslink(sourceId, targetId, label);
      s.close();
      return json({ ok: true });
    }

    // ---- Export ----
    if (p === "/api/export" && req.method === "POST") {
      const { dbFile } = await req.json() as { dbFile: string };
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exp = g.getAllExplorations()[0];
      if (!exp) { s.close(); return json({ error: "No exploration" }, 404); }

      const outputDir = path.join(CWD, path.basename(dbFile, ".db"));
      new Exporter(s).export(exp.id, outputDir);
      s.close();
      return json({ ok: true, outputDir });
    }

    // ---- Edit node ----
    if (p === "/api/edit" && req.method === "POST") {
      const { dbFile, nodeId, content } = await req.json() as { dbFile: string; nodeId: string; content: string };
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      const node = g.getNode(nodeId);
      if (!node) { s.close(); return json({ error: "Node not found" }, 404); }
      s.updateNodeContent(nodeId, node.title || nodeId, content, node.model || "manual", node.provider || "manual");
      s.close();
      return json({ ok: true });
    }

    // ---- Sync ----
    if (p === "/api/sync" && req.method === "POST") {
      const { dbFile } = await req.json() as { dbFile: string };
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exp = g.getAllExplorations()[0];
      if (!exp) { s.close(); return json({ error: "No exploration" }, 404); }

      const dir = path.join(CWD, path.basename(dbFile, ".db"));
      const result = new Sync(s).sync(exp.id, dir);
      s.close();
      return json(result);
    }

    // ---- Synthesis: list ----
    if (p.match(/^\/api\/syntheses\//) && req.method === "GET") {
      const dbFile = decodeURIComponent(p.split("/api/syntheses/")[1]);
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exp = g.getAllExplorations()[0];
      if (!exp) { s.close(); return json({ error: "No exploration" }, 404); }

      const engine = new SynthesisEngine({ storage: s, agent: null });
      const syntheses = engine.getSyntheses(exp.id);
      const result = syntheses.map((synth) => {
        const data = engine.getSynthesis(synth.id);
        return {
          ...synth,
          annotations: data?.annotations ?? [],
        };
      });
      s.close();
      return json(result);
    }

    // ---- Synthesis: run ----
    if (p === "/api/synthesize" && req.method === "POST") {
      const { dbFile } = await req.json() as { dbFile: string };
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);
      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = makeAgent(config, credentials);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exp = g.getAllExplorations()[0];
      if (!exp) { s.close(); return json({ error: "No exploration" }, 404); }

      try {
        const engine = new SynthesisEngine({ storage: s, agent });
        const synthesisId = await engine.synthesize(exp.id);
        const result = engine.getSynthesis(synthesisId);
        s.close();
        return json(result);
      } catch (err: any) {
        s.close();
        return json({ error: err.message }, 500);
      }
    }

    // ---- Synthesis: compute diff ----
    if (p === "/api/synthesis-diff" && req.method === "POST") {
      const { dbFile, annotationId } = await req.json() as { dbFile: string; annotationId: string };
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);
      const s = new Storage(dbPath);
      const engine = new SynthesisEngine({ storage: s, agent: null });
      try {
        const diff = engine.computeDiff(annotationId);
        s.close();
        return json(diff);
      } catch (err: any) {
        s.close();
        return json({ error: err.message }, 500);
      }
    }

    // ---- Synthesis: merge ----
    if (p === "/api/merge-synthesis" && req.method === "POST") {
      const { dbFile, synthesisId, annotationId, dismiss, preview } = await req.json() as {
        dbFile: string; synthesisId?: string; annotationId?: string; dismiss?: boolean; preview?: any;
      };
      const dbPath = safeDbPath(dbFile); if (!dbPath) return json({ error: "Invalid database path" }, 400);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exp = g.getAllExplorations()[0];

      try {
        if (dismiss && annotationId) {
          const engine = new SynthesisEngine({ storage: s, agent: null });
          engine.dismissAnnotation(annotationId);
          s.close();
          return json({ ok: true, action: "dismissed", annotationId });
        } else if (annotationId) {
          // Check annotation type — contradiction/merge_suggestion need preview
          const annotation = s.getAnnotation(annotationId);
          if (!annotation) { s.close(); return json({ error: "Annotation not found" }, 404); }

          if ((annotation.type === "contradiction" || annotation.type === "merge_suggestion") && !preview) {
            // Generate preview
            const config = loadConfig();
            const credentials = loadCredentials();
            const agent = makeAgent(config, credentials);
            const engine = new SynthesisEngine({ storage: s, agent });
            const mergePreview = await engine.generateMergePreview(annotationId, exp!.id);
            s.close();
            return json({ ok: true, action: "preview", preview: mergePreview });
          } else if (preview) {
            // Apply a previously generated preview
            const engine = new SynthesisEngine({ storage: s, agent: null });
            const nodeId = engine.applyMergePreview(annotationId, exp!.id, preview);
            s.close();
            return json({ ok: true, action: "applied", nodeId });
          } else {
            // crosslink / note: immediate merge
            const engine = new SynthesisEngine({ storage: s, agent: null });
            engine.mergeSingle(annotationId);
            s.close();
            return json({ ok: true, action: "merged", annotationId });
          }
        } else if (synthesisId) {
          const engine = new SynthesisEngine({ storage: s, agent: null });
          const { merged, skipped } = engine.mergeAll(synthesisId);
          s.close();
          return json({ ok: true, action: "mergedAll", merged, skipped });
        }
        s.close();
        return json({ error: "Provide synthesisId or annotationId" }, 400);
      } catch (err: any) {
        s.close();
        return json({ error: err.message }, 500);
      }
    }

    // ---- Static file serving (built web UI) ----
    const HTML_CACHE = "no-cache, no-store, must-revalidate";

    // Single-binary mode: the whole client is inlined into one HTML string.
    // It's a self-contained SPA, so any non-API route returns it.
    if (EMBEDDED_CLIENT !== null) {
      if (p.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return new Response(EMBEDDED_CLIENT, {
        headers: { "Content-Type": "text/html", "Cache-Control": HTML_CACHE },
      });
    }

    // Source / dev mode: serve the built files from dist/ on disk.
    const DIST_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
    const MIME_TYPES: Record<string, string> = {
      ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
      ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
      ".json": "application/json", ".woff": "font/woff", ".woff2": "font/woff2",
    };

    // index.html must NEVER be cached — otherwise a browser keeps serving a
    // stale app that points at old (now-gone) asset hashes after an update.
    // Content-hashed assets (js/css) are immutable, so cache them aggressively.
    const isHtml = p === "/" || p.endsWith(".html");
    const cacheHeader = isHtml ? HTML_CACHE : "public, max-age=31536000, immutable";
    let filePath = path.join(DIST_DIR, p === "/" ? "index.html" : p);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      return new Response(fs.readFileSync(filePath), {
        headers: { "Content-Type": contentType, "Cache-Control": cacheHeader },
      });
    }

    // SPA fallback: serve index.html for non-API routes (never cached).
    const indexPath = path.join(DIST_DIR, "index.html");
    if (!p.startsWith("/api/") && fs.existsSync(indexPath)) {
      return new Response(fs.readFileSync(indexPath), {
        headers: { "Content-Type": "text/html", "Cache-Control": HTML_CACHE },
      });
    }

    return json({ error: "Not found" }, 404);
}

export interface StartServerOptions {
  /** Port to listen on (default: $LAIN_PORT or 3001). */
  port?: number;
  /** Directory to discover/write explorations under (default: $LAIN_CWD or cwd). */
  cwd?: string;
  /** Pre-built single-file web client (for the compiled binary). */
  clientHtml?: string | null;
}

/** Start the lain web server. Returns the Bun server handle. */
export function startServer(opts: StartServerOptions = {}) {
  if (opts.port != null) PORT = opts.port;
  if (opts.cwd) CWD = path.resolve(opts.cwd);
  if (opts.clientHtml != null) EMBEDDED_CLIENT = opts.clientHtml;
  const server = Bun.serve({ port: PORT, fetch: handleRequest });
  console.log(`lain API server running on http://localhost:${PORT}`);
  return server;
}

// Auto-start when run directly (source / dev: `bun run src/server/index.ts`).
if (import.meta.main) startServer();
