/**
 * Lain API server — thin HTTP layer over @lain/core.
 * Serves REST endpoints + SSE for streaming.
 * Run with: bun run src/server/index.ts
 */
import { Storage, Graph, Orchestrator, Sync, Exporter } from "@lain/core";
import { createProvider } from "@lain/agents";
import { ExtensionRegistry, freeformExtension, worldbuildingExtension, debateExtension, researchExtension } from "@lain/extensions";
import { generateId, type Strategy, type PlanDetail, type Provider, DEFAULT_CONFIG } from "@lain/shared";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PORT = Number(process.env.LAIN_PORT) || 3001;
const CWD = process.env.LAIN_CWD || process.cwd();

// Load config
function loadConfig() {
  const configPath = path.join(os.homedir(), ".config", "lain", "config.json");
  if (fs.existsSync(configPath)) {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, "utf-8")) }; } catch {}
  }
  return DEFAULT_CONFIG;
}

function loadCredentials(): Record<string, any> {
  const credPath = path.join(os.homedir(), ".config", "lain", "credentials.json");
  if (fs.existsSync(credPath)) {
    try { return JSON.parse(fs.readFileSync(credPath, "utf-8")); } catch {}
  }
  return {};
}

function makeAgent(config: any, credentials: any) {
  const provider = config.defaultProvider as Provider;
  if (provider === "bedrock") {
    return createProvider({
      provider: "bedrock",
      model: config.defaultModel,
      apiKey: credentials.bedrock?.apiKey || process.env.AWS_BEARER_TOKEN_BEDROCK,
      region: credentials.bedrock?.region || "us-west-2",
    });
  }
  if (provider === "anthropic") {
    return createProvider({ provider: "anthropic", model: config.defaultModel, apiKey: credentials.anthropic?.apiKey });
  }
  return createProvider({ provider, model: config.defaultModel });
}

function buildExtensions() {
  const reg = new ExtensionRegistry();
  reg.register(freeformExtension);
  reg.register(worldbuildingExtension);
  reg.register(debateExtension);
  reg.register(researchExtension);
  return reg;
}

// Find all .db files
function discoverDbs(): { path: string; name: string; explorations: any[] }[] {
  const results: any[] = [];
  try {
    for (const entry of fs.readdirSync(CWD)) {
      if (!entry.endsWith(".db")) continue;
      const full = path.join(CWD, entry);
      try {
        const s = new Storage(full);
        const g = new Graph(s);
        const exps = g.getAllExplorations().map((e) => ({
          ...e,
          nodeCount: g.getAllNodes(e.id).filter((n) => n.status !== "pruned").length,
        }));
        s.close();
        if (exps.length > 0) results.push({ path: full, name: entry, explorations: exps });
      } catch {}
    }
  } catch {}
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

// ============================================================================
// Server
// ============================================================================

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === "OPTIONS") return cors();

    // ---- Discovery ----
    if (p === "/api/explorations" && req.method === "GET") {
      return json(discoverDbs());
    }

    // ---- Get exploration data ----
    if (p.match(/^\/api\/exploration\/[^/]+$/) && req.method === "GET") {
      const dbFile = decodeURIComponent(p.split("/").pop()!);
      const dbPath = path.join(CWD, dbFile);
      if (!fs.existsSync(dbPath)) return json({ error: "Not found" }, 404);

      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exps = g.getAllExplorations();
      if (exps.length === 0) { s.close(); return json({ error: "No explorations" }, 404); }
      const exp = exps[0];
      const nodes = g.getAllNodes(exp.id);
      const crosslinks = g.getCrosslinks(exp.id);
      s.close();

      return json({ exploration: exp, nodes, crosslinks });
    }

    // ---- Get single node ----
    if (p.match(/^\/api\/node\/[^/]+\/[^/]+$/) && req.method === "GET") {
      const parts = p.split("/");
      const nodeId = decodeURIComponent(parts.pop()!);
      const dbFile = decodeURIComponent(parts.pop()!);
      const dbPath = path.join(CWD, dbFile);
      if (!fs.existsSync(dbPath)) return json({ error: "Not found" }, 404);

      const s = new Storage(dbPath);
      const g = new Graph(s);
      const node = g.getNode(nodeId);
      const crosslinks = node ? g.getCrosslinksForNode(nodeId) : [];
      const ancestors = node ? g.getAncestorChain(nodeId) : [];
      s.close();

      return json({ node, crosslinks, ancestors });
    }

    // ---- Create exploration (with SSE streaming) ----
    if (p === "/api/create" && req.method === "POST") {
      const body = await req.json() as {
        seed: string; n?: number; m?: number; extension?: string;
        strategy?: string; planDetail?: string;
      };

      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = makeAgent(config, credentials);
      const extensions = buildExtensions();

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

          try {
            const orchestrator = new Orchestrator({
              dbPath, agent, concurrency: 5, streaming: true, extensions,
              onEvent: (event) => {
                send(event.type, { nodeId: event.nodeId, data: event.data });
              },
            });

            await orchestrator.explore({
              id: expId, name: seed, seed, n, m, strategy, planDetail, extension: ext,
            });
            orchestrator.close();

            send("complete", { dbFile: dbFileName, explorationId: expId });
          } catch (err: any) {
            send("error", { message: err.message });
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
      const dbPath = path.join(CWD, dbFile);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      g.pruneNode(nodeId);
      s.close();
      return json({ ok: true });
    }

    // ---- Extend ----
    if (p === "/api/extend" && req.method === "POST") {
      const { dbFile, nodeId, n } = await req.json() as { dbFile: string; nodeId: string; n?: number };
      const dbPath = path.join(CWD, dbFile);
      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = makeAgent(config, credentials);
      const extensions = buildExtensions();

      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exp = g.getAllExplorations()[0];
      s.close();
      if (!exp) return json({ error: "No exploration" }, 404);

      const orchestrator = new Orchestrator({ dbPath: dbPath, agent, streaming: true, extensions });
      const newNodes = await orchestrator.extendNode(exp.id, nodeId, n || exp.n);
      orchestrator.close();
      return json({ nodes: newNodes });
    }

    // ---- Redirect ----
    if (p === "/api/redirect" && req.method === "POST") {
      const { dbFile, nodeId } = await req.json() as { dbFile: string; nodeId: string };
      const dbPath = path.join(CWD, dbFile);
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
      const dbPath = path.join(CWD, dbFile);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      g.addCrosslink(sourceId, targetId, label);
      s.close();
      return json({ ok: true });
    }

    // ---- Export ----
    if (p === "/api/export" && req.method === "POST") {
      const { dbFile } = await req.json() as { dbFile: string };
      const dbPath = path.join(CWD, dbFile);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exp = g.getAllExplorations()[0];
      if (!exp) { s.close(); return json({ error: "No exploration" }, 404); }

      const outputDir = path.join(CWD, path.basename(dbFile, ".db"));
      new Exporter(s).export(exp.id, outputDir);
      s.close();
      return json({ ok: true, outputDir });
    }

    // ---- Sync ----
    if (p === "/api/sync" && req.method === "POST") {
      const { dbFile } = await req.json() as { dbFile: string };
      const dbPath = path.join(CWD, dbFile);
      const s = new Storage(dbPath);
      const g = new Graph(s);
      const exp = g.getAllExplorations()[0];
      if (!exp) { s.close(); return json({ error: "No exploration" }, 404); }

      const dir = path.join(CWD, path.basename(dbFile, ".db"));
      const result = new Sync(s).sync(exp.id, dir);
      s.close();
      return json(result);
    }

    return json({ error: "Not found" }, 404);
  },
});

console.log(`lain API server running on http://localhost:${PORT}`);
