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
- `AgentProvider` interface: `generate()`, `plan()`, `synthesize()`, `generateRaw(system, user)`.
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

## Current State (v0.4 in progress)

### Complete
- Core graph engine, SQLite storage, full CRUD
- Agent layer (Bedrock + Anthropic providers, streaming)
- Full CLI with all commands (explore, init, status, tree, show, prune, extend, redirect, link, sync, export, watch, config, synthesize, merge-synthesis)
- Bidirectional Obsidian sync with file watcher
- Extension system with 4 built-in extensions
- TUI (home, exploration view, graph view, edit mode, command palette, create form, synthesis view)
- Web UI (editorial layout, graph overlay, SSE streaming, edit mode, keyboard nav)
- Canvas export to Obsidian `.canvas` format
- Synthesis pass with staged annotations and merge preview

### Remaining
- Synthesis with custom instructions/focus/filters
- Interactive mode (approve/reject/redirect at each depth)
- Quality cleanup, comprehensive test coverage, polish across all surfaces

## File Reference

| File | Purpose |
|------|---------|
| `PLAN.md` | Comprehensive project spec — the source of truth |
| `packages/shared/src/index.ts` | All shared types, config defaults, ID generation |
| `packages/core/src/storage.ts` | SQLite schema + all CRUD operations |
| `packages/core/src/graph.ts` | DAG operations (addNode, getAncestors, prune, LCA) |
| `packages/core/src/orchestrator.ts` | Generation loop (BF/DF, concurrent, streaming) |
| `packages/core/src/synthesis.ts` | SynthesisEngine (synthesize, computeDiff, merge, preview) |
| `packages/core/src/sync.ts` | Bidirectional Obsidian sync |
| `packages/core/src/watcher.ts` | File watcher daemon |
| `packages/core/src/export.ts` | Obsidian markdown export |
| `packages/core/src/canvas-export.ts` | Obsidian .canvas export with radial layout |
| `packages/agents/src/bedrock.ts` | Bedrock provider (bearer token, binary stream parser) |
| `packages/agents/src/prompts.ts` | All prompt construction |
| `packages/agents/src/types.ts` | AgentProvider interface |
| `packages/cli/src/index.ts` | CLI entry + arg parser + serve/tui dispatch |
| `packages/cli/src/commands.ts` | All CLI command implementations |
| `packages/tui/src/index.ts` | Full TUI application |
| `packages/tui/src/graph-view.ts` | Radial graph view (FrameBuffer, minimap, spatial nav) |
| `packages/web/src/App.tsx` | Web home + routing |
| `packages/web/src/ExplorationView.tsx` | Three-column layout, graph overlay, synthesis panel |
| `packages/web/src/server/index.ts` | Bun HTTP API server (REST + SSE + static) |
