# AGENTS.md

## Project Overview

**lain** is a graph-based ideation engine. You start with a seed idea, branch into n children, recurse to depth m, with an LLM agent expanding each node. Named after Lain Iwakura.

The graph is a DAG (directed acyclic graph) with a tree backbone. Nodes have a primary parent but can have cross-links to nodes in other branches. A synthesis pass traverses the full graph to identify connections, contradictions, and emergent patterns.

## Architecture

Monorepo with pnpm workspaces + turborepo. Runtime is **Bun** (not Node.js).

```
packages/
├── shared/       # Types, config defaults, ID generation
├── core/         # Graph engine, storage (bun:sqlite), orchestrator, synthesis, sync, export
├── agents/       # LLM provider abstraction, prompt engine, streaming
├── extensions/   # Plugin system + built-in extensions (freeform, worldbuilding, debate, research)
├── cli/          # CLI interface (clack prompts)
├── tui/          # TUI interface (OpenTUI)
└── web/          # Web interface (Vite + React + React Flow) + API server
```

## Critical Constraints

### Runtime & Build
- **Bun is required.** OpenTUI uses `import ... with { type: "file" }` and `bun:` protocol imports. Storage uses `bun:sqlite`.
- **pnpm** for package management. Never manually edit package.json deps — use `pnpm add` or `bun add`.
- Build via `turbo build`. Each package builds with `tsup` to `dist/`.
- Tests via `vitest` (run with `pnpm test` or `bun run test`).

### LLM Provider (Bedrock)
- Uses **AWS Bedrock** with a **bearer token** (NOT IAM credentials, NOT SigV4 signing).
- Auth header: `Authorization: Bearer <token>` against the Converse API at `https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse`.
- Region: `us-west-2`. Default model: `us.anthropic.claude-sonnet-4-6` (needs `us.` prefix for cross-region inference).
- `claude-opus-4-6-v1` is also mapped. Credentials stored at `~/.config/lain/credentials.json`.
- Streaming uses AWS Event Stream binary format (not newline-delimited JSON).
- The `@anthropic-ai/bedrock-sdk` does NOT support bearer token auth — we use raw `fetch`.

### Three-Surface Rule
**Every feature must work across CLI, TUI, and web UI.** If you implement something in one surface, implement it in all three. This has been a recurring failure point.

### CLI Agent-Friendliness
Every interactive CLI command must have a `--non-interactive` alternative with explicit flags. The CLI must be entirely usable by automated agents.

### Design Philosophy
- **Tokyo Night** color palette everywhere.
- Information-dense, beautiful, clear hierarchy. Anti-slop.
- Web UI: editorial/content-first (like a magazine), NOT graph-first. Three columns: left nav, center content (serif typography, generous whitespace), right metadata. Graph is an overlay toggle.
- TUI: think from first principles about how users interact. Optimal usage patterns, delightful.
- Graph layout: **radial** — root at center, children in concentric rings at even angles. No force-directed randomness.

## Code Conventions

### Types & IDs
- All types live in `packages/shared/src/index.ts` (LainNode, Exploration, SynthesisDiff, NodeAnnotation, etc.).
- Node IDs are deterministic, based on position in tree (e.g., `root`, `root-1`, `root-1-2`).
- Exploration IDs are nanoid-generated.

### Storage (packages/core/src/storage.ts)
- SQLite via `bun:sqlite`. Single `.db` file per exploration.
- Schema includes: `exploration`, `node`, `crosslink`, `synthesis`, `synthesis_annotation`, `node_annotations`, `sync_state` tables.
- All timestamps are ISO 8601 strings.

### Agent Layer (packages/agents/)
- `AgentProvider` interface: `generate()`, `plan()`, `synthesize()`, `generateRaw(system, user)`, `converse(request)` (tool-capable primitive), plus `modelId`/`providerName`.
- `generateRaw` is for clean prompt-only calls (used by merge preview generation). Do NOT hijack `synthesize()` with custom prompts.
- Prompt construction lives in `prompt-engine.ts`. Branching plan phase is separate from content generation.
- Sibling-awareness: each agent knows what siblings are exploring to diverge meaningfully.

### Extension System (packages/extensions/)
- Extensions inject system prompt fragments, add lifecycle hooks, define custom operations, provide validators.
- Built-in: freeform (default), worldbuilding, debate, research.
- Extensions are registered via a registry and participate in the orchestrator lifecycle.

### Synthesis (packages/core/src/synthesis.ts)
- `SynthesisEngine` produces typed annotations: crosslink, contradiction, note, merge_suggestion.
- Annotations are **staged** — never auto-applied unless explicitly requested.
- Merging: crosslinks create graph edges; notes attach as node annotations; contradictions/merge_suggestions generate resolution/synthesis nodes via agent preview with diff.
- `mergeAll` returns `{ merged, skipped }` — it skips types that need agent generation + user preview.

### Config Hierarchy
```
exploration db  >  workspace .lain/  >  global ~/.config/lain/  >  built-in defaults
```

### Settings system (schema-driven, all three surfaces)
`packages/shared/src/settings.ts` is the **single source of truth**: a declarative
`SETTINGS_FIELDS` (typed: string/secret/number/boolean/select, each with a
section, store, validation bounds, options/suggestions) + `SETTINGS_SECTIONS`.
Helpers: `coerceSettingValue` (validate), `resolveSettingValue`/`buildSettingsView`
(read, **secrets redacted** — `value:""` + `isSet`), `applySettings` (validate +
route each field to config vs credentials store, global or workspace).
Add a setting once here and it appears everywhere.
- **CLI**: `lain config list|get|set|unset|path` (validated, `--json`, `--local`).
- **Web**: `GET/PUT /api/config` (+ `POST /api/config/test` for a live provider
  ping); `SettingsModal.tsx` renders the schema (gear button / `,` / Cmd-S).
- **TUI**: `,` or palette → an in-place Settings overlay (↑/↓ move, ←/→ cycle
  selects, space toggles, enter edits text/secrets; saves immediately).
Config knobs include provider/model, per-provider credentials, generation
defaults, `maxTokens`, `concurrency`, `defaultAgentic`, `defaultMissionRounds`,
watch + synthesis. `maxTokens` is wired into provider creation on every surface.

### Tool catalog + selection (visible + configurable everywhere)
The agent toolbelt (built-in graph tools, corpus retrieval, each extension/lens,
each MCP server) is described by a uniform **catalog** and gated by a
**selection** — both in `packages/shared/src/tool-catalog.ts` (single source of
truth). `ToolSelection = { disabledGroups, disabledTools }` is a delta from
"everything on"; pure helpers (`toggleGroup/toggleTool`, `isGroupEnabled/
isToolEnabled`, `resolveDisabledToolIds`, `enabledMcpServers`, `countActiveTools`,
`normalizeToolSelection`). `config.tools` holds the default selection.
- `core/catalog.ts` `buildToolCatalog()` assembles groups; MCP can be **live-
  probed** (connect + enumerate tools), returning the pool so a run reuses the
  connection. `registry.describeToolGroups()` supplies extension groups.
- The orchestrator + `generateNodeAgentic` take `disabledTools` and filter the
  assembled toolbelt by id (`submit_node` is always kept).
- **Granularity:** group-level toggle, expandable to per-tool toggles.
- **Per-run override:** every surface lets you tweak the selection at run start;
  config defaults are the starting point and a tweak can be "saved as default".
  Only enabled MCP servers are connected for a run.
- **CLI:** `lain tools list [--probe]` / `enable|disable <group-or-tool-id>` /
  `reset`; explore/resume flags `--disable-tool`/`--enable-tool`/`--disable-group`
  /`--only-tools`/`--no-mcp`. `lain mcp add|list|test|remove` manages servers.
- **Web:** `GET/PUT /api/tools` (probe), `GET/POST/DELETE /api/mcp`; reusable
  `ToolPicker` in the SettingsModal "Tools & MCP" tab + the CreateModal per-run
  panel (with "save as default"). create/extend connect enabled MCP + filter.
- **TUI:** tools overlay (palette "Tools & MCP") for defaults, and a "tools:" row
  in the create form opening the same overlay in per-run mode; ↑/↓ move, →
  expand a group, space/enter toggle, `d` save-as-default.

## Known Technical Gotchas

### OpenTUI
- `borderStyle: "rounded"` (not "round").
- `scrollBy({x, y})` (not two args). `.scrollTop = 0` (no `scrollToTop()`).
- `remove("id")` takes a string ID, not a renderable.
- `stackingMode` (not `stackMode`).
- `SelectRenderable` intercepts keyboard events even when blurred — use `key.stopPropagation()` in global handlers for modes where select shouldn't receive input.
- `MarkdownRenderable` doesn't work (tree-sitter grammars fail to load). We built a custom markdown renderer using the `t` template system with `fg()`, `bold()`, `italic()`, `dim()`.
- **Styled text objects** (`fg(c.blue)("text")`) CANNOT be interpolated in regular backtick strings (produces `[object Object]`). They can ONLY be used as expressions inside the `t` tagged template.

### React Flow (Web)
- Radial layout: compute source/target handle positions based on relative node positions.
- Use `straight` edge type. Disable node dragging.

### Obsidian Sync
- Split content/frontmatter hash tracking — metadata-only changes don't conflict with content edits.
- Self-write detection in file watcher prevents feedback loops.
- Conflict: both sides touch same region → preserved in `content_conflict` field.

## Running the Project

```bash
# Build all packages
pnpm build

# Run CLI
bun packages/cli/dist/index.js [command]

# Or via global wrapper (if installed)
lain [command]        # CLI
lain tui             # TUI
lain serve           # Web (API + static assets on same port)

# Run tests
pnpm test

# Dev mode
pnpm dev
```

## Testing

Tests live in `packages/*/test/*.test.ts`. Run with vitest:
```bash
pnpm test                    # all tests via turbo
bun run vitest run           # direct vitest invocation
```

Coverage is thin — many newer features (synthesis merge previews, node annotations, diff computation, web API endpoints) lack dedicated tests. The goal is hundreds of tests.

## The Agent Substrate (v0.5 — current)

Node generation is no longer a single completion. In **agentic** mode each node
is expanded by a tool-using agent driven by `AgentRunner` (in `@lain/agents`)
over the provider's `converse()` tool primitive.

- **`converse(request)`** is the low-level tool-capable primitive on every
  `AgentProvider` (Bedrock Converse `toolConfig`, Anthropic tools, OpenAI
  Chat-Completions tools). It returns one assistant turn (text / tool_use).
- **`AgentRunner.runAgent`** (`agents/src/runner.ts`) drives the multi-step
  loop: it always pairs `tool_result` blocks with `tool_use`, enforces a step
  budget, recovers from tool errors, and emits `AgentStepEvent`s.
- **Tools** are `LainTool { spec: ToolSpec; handler(input, ctx) }`. The default
  node toolbelt (`core/src/tools.ts`): `outline`, `read_node`, `search_nodes`,
  `link_to_node`, `read_findings`, `note_finding`, and (when a corpus exists)
  `search_corpus`, `list_corpus_sources`. The agent delivers its result via a
  `submit_node` tool (with a nudge + abort-on-submit) — never free-form parsing.
- **`generateNodeAgentic`** (`core/src/agentic.ts`) assembles the system prompt
  (substrate + mission + extension), tool context, extension tools, and MCP
  tools, then runs the loop.

Subsystems that plug into the substrate:
- **Corpus** (`core/src/corpus.ts`): ingest text/md/csv/json/pdf(unpdf)/image;
  BM25 retrieval; tables `corpus_source`/`corpus_chunk`. Tools let agents ground
  in the user's material.
- **Mission** (`core/src/mission.ts`): `deriveIntentContract` turns a seed into
  an intent + success criteria (tables `mission`); a **shared knowledge
  library** (`finding` table + note/read tools) lets branches collaborate.
- **MCP** (`core/src/mcp.ts`): `connectMcpServers` connects remote Streamable
  HTTP MCP servers (`@modelcontextprotocol/sdk`) and adapts their tools to
  `LainTool`s (namespaced `mcp_<server>_<tool>`). Config: `LainConfig.mcpServers`.
- **Extensions** contribute `ExtensionTool`s (shared) adapted with a
  dependency-light context (graph read, corpus search, sub-agent calls).

### Providers
All four are real and tool-capable: **Bedrock** (bearer token, raw fetch),
**Anthropic** (SDK), **OpenAI** (Chat Completions, raw fetch), **OpenRouter**
(OpenAI-compatible). `OpenAIProvider` also serves any OpenAI-compatible endpoint
via `baseUrl`.

### Distribution & lifecycle
`install.sh` builds + writes a `lain` launcher to `~/.local/bin`. CLI:
`version`/`--version`, `doctor`, `update` (git pull + rebuild; never touches
dbs/config), `uninstall`. Storage has a `schema_version` (`CURRENT_SCHEMA_VERSION`)
and an idempotent migrations runner; legacy dbs upgrade in place (additive
tables) with no data loss.

### Complete
- Core graph engine, SQLite storage (+ schema versioning/migrations), full CRUD
- Agent layer: Bedrock + Anthropic + OpenAI + OpenRouter, streaming, tool-calling
- Agent substrate: agentic node generation, corpus, missions, MCP, extension tools
- Full CLI (explore, init, status, tree, show, prune, extend, redirect, link,
  sync, export, watch, config, synthesize, merge-synthesis, corpus, mcp, mission,
  version, doctor, update, uninstall)
- Bidirectional Obsidian sync + file watcher; canvas export
- Extension system (4 built-ins; worldbuilding ships a `coin_names` tool)
- TUI (decomposed into theme/markdown/views modules; corpus grounding indicator;
  interactive mission interview gate before generation)
- Web UI (editorial layout, graph overlay, SSE, corpus drag-drop create flow +
  live thinking feed, in-exploration corpus panel; mission toggle + interview
  gate via `/api/mission/interview`)
- Missions on all three surfaces: contract-first **clarification interview**
  (`interviewMission`) is the cognitive-frontloading gate — CLI (clack), TUI
  (interview overlay), and web (CreateModal interview phase) all interview the
  user, show the proposed contract, and only generate on approval; then run the
  same validate→fix loop (`pursueMission`).
- Synthesis with staged annotations + merge preview
- Distribution: install/uninstall scripts, version/doctor/update commands

### Remaining / opportunities
- Deeper TUI motion/aesthetics + an agentic create flow + live thinking panel
- Synthesis using the mission contract as an explicit rubric
- MCP OAuth flow (header/bearer/api-key/url-token auth already supported)
- Interactive approve/reject/redirect at each depth

### Testing note
`@lain/core` tests run under **`bun test`** (not vitest — they need `bun:sqlite`).
`pnpm test` runs the whole suite green (106 core tests + shared/agents/extensions).

## File Reference

| File | Purpose |
|------|---------|
| `README.md` | User-facing front door (install, quickstart, features) — start here |
| `PLAN.md` | Original project spec (historical; README + this file reflect reality) |
| `packages/shared/src/index.ts` | All shared types, config defaults, ID generation |
| `packages/core/src/storage.ts` | SQLite schema + all CRUD operations |
| `packages/core/src/graph.ts` | DAG operations (addNode, getAncestors, prune, LCA) |
| `packages/core/src/orchestrator.ts` | Generation loop (BF/DF, concurrent, streaming, agentic) |
| `packages/core/src/agentic.ts` | Agentic node generation (substrate + mission + tools loop) |
| `packages/core/src/tools.ts` | Default node toolbelt + LainTool/LainToolContext |
| `packages/core/src/corpus.ts` | Multimodal ingestion + BM25 retrieval |
| `packages/core/src/mission.ts` | Intent-contract derivation |
| `packages/core/src/mcp.ts` | Remote MCP client (tools → LainTools) |
| `packages/core/src/synthesis.ts` | SynthesisEngine (synthesize, computeDiff, merge, preview) |
| `packages/core/src/sync.ts` | Bidirectional Obsidian sync |
| `packages/core/src/watcher.ts` | File watcher daemon |
| `packages/core/src/export.ts` | Obsidian markdown export |
| `packages/core/src/canvas-export.ts` | Obsidian .canvas export with radial layout |
| `packages/agents/src/bedrock.ts` | Bedrock provider (bearer token, converse + stream) |
| `packages/agents/src/openai.ts` | OpenAI / OpenRouter / compatible provider |
| `packages/agents/src/runner.ts` | AgentRunner tool-use loop |
| `packages/agents/src/prompts.ts` | All prompt construction |
| `packages/shared/src/agent.ts` | Agent wire types (ContentBlock, ToolSpec, Converse*) |
| `packages/cli/src/index.ts` | CLI entry + arg parser + serve/tui dispatch |
| `packages/cli/src/commands.ts` | All CLI command implementations |
| `packages/tui/src/app.ts` | TUI application (+ theme.ts, markdown.ts, views.ts) |
| `packages/tui/src/graph-view.ts` | Radial graph view (FrameBuffer, minimap, spatial nav) |
| `packages/web/src/App.tsx` | Web home + routing |
| `packages/web/src/components/ExplorationView.tsx` | Three-column layout, graph overlay, synthesis |
| `packages/web/src/components/CreateModal.tsx` | Agentic create flow (corpus drop, thinking feed) |
| `packages/web/src/server/index.ts` | Bun HTTP API server (REST + SSE + static + corpus) |
| `install.sh` / `uninstall.sh` | Install a `lain` launcher / remove it |
