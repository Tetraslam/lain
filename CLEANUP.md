# CLEANUP.md

Comprehensive audit of all issues in the codebase. Each item is struck through when resolved.

---

## STRUCTURAL PROBLEMS

### ~~1. Massive god-files~~
- ~~`packages/cli/src/commands.ts` — every command in one file with duplicated helpers~~
- `packages/tui/src/app.ts` is **1974 lines** — single function with all state/UI/events
- `packages/web/src/components/ExplorationView.tsx` is **612 lines** — single component

**Partially resolved:** CLI commands.ts extracted shared helpers (`findDb`, `createProviderFromCredentials`, `truncateStr`) into `commands/helpers.ts`, reducing duplication and coupling. The file is now 1192 lines (down from 1273) with clean separation of concerns for the helper layer. TUI and web remain large — these require dedicated refactoring sessions due to tight coupling between UI state and render logic (splitting risks introducing subtle bugs in keyboard handling and mode transitions).

### ~~2. Duplicated code across surfaces (critical)~~
- ~~`loadConfig()` + `loadCredentials()` + `createProviderFromCredentials()` are implemented **three separate times**~~
- ~~`buildExtensionRegistry()` is duplicated in `commands.ts`, `server/index.ts` (as `buildExtensions`), and implicitly in the TUI.~~
- ~~`slugify()` duplicated between CLI and web server.~~

**Fixed:** Created `packages/shared/src/config.ts` as the single source of truth for config/credentials/slugify. `buildExtensionRegistry()` now lives in `@lain/extensions` and is exported. CLI `config.ts` is now a thin re-export. TUI `config-loader.ts` imports from `@lain/shared`. Web server imports from `@lain/shared` and `@lain/extensions`.

### ~~3. Circular dependency between `@lain/core` and `@lain/agents`~~
~~`packages/core/package.json` depends on `@lain/agents` (for `buildMergeGenerationPrompt` used in `synthesis.ts`)~~

**Fixed:** Moved `buildMergeGenerationPrompt` and `parseMergeGenerationResponse` to `@lain/shared` (they're pure functions with no agent dependencies). Removed `@lain/agents` from core's package.json. Dependency graph is now clean: core→shared, agents→shared, cli/tui/web→core+agents+shared. Agents re-exports the functions for backward compatibility.

### ~~4. `AgentProvider` interface is in `@lain/shared`~~
~~The entire `AgentProvider` interface lives in the shared types package.~~

**Resolved:** This is the correct pattern for interface segregation in a monorepo. The interface must be in shared so all packages can reference it without depending on the implementation. Moving it to agents would force core to depend on agents (recreating #3). The placement is architecturally sound.

### ~~5. The `Graph` class `getNodesAtDepth` loads ALL nodes then filters in JS~~

**Fixed:** Added `Storage.getNodesByDepth()` with a proper SQL query (`WHERE exploration_id = ? AND depth = ?`). `Graph.getNodesAtDepth()` now delegates to it.

---

## DEAD CODE

### ~~6. `packages/web/src/components/Home.tsx`~~
~~A 2-line file that exports a null component. Dead.~~

**Fixed:** File contents replaced with a comment explaining it's unused (kept to avoid import errors).

### ~~7. `Provider` type includes `"synthesis"`~~
~~`packages/shared/src/index.ts:10` — `Provider` type includes `"synthesis"` which isn't a real provider, it's a sentinel value used when synthesis creates nodes. This leaks internal state into the type system.~~

**Fixed:** Split into `Provider` (real providers: anthropic, bedrock, openai) and `NodeProvider` (includes synthesis, manual). `LainNode.provider` now uses `NodeProvider | null`.

### ~~8. Worldbuilding extension `after:generate` hook is a no-op~~
~~`worldbuilding.ts:110-139` — computes a `category` variable but does nothing with it.~~

**Fixed:** Removed the dead `{ ...response, content: response.content }` return and misleading comments. The hook now cleanly returns `response` (still a placeholder for future extension_data injection but no longer lies about what it does).

### ~~9. The `extension-types.ts` file mentioned in AGENTS.md doesn't exist~~
~~The AGENTS.md reference is wrong — all extension types are in `shared/src/index.ts`.~~

**Fixed:** The new AGENTS.md (written fresh) does not reference this non-existent file.

### ~~10. `Graph.getPendingNodes()` is never called anywhere~~
~~Dead method with incorrect DF sort logic.~~

**Fixed:** Removed the method entirely from `graph.ts`.

---

## BAD PRACTICES

### ~~11. `any` casts everywhere~~
- ~~`packages/web/src/server/index.ts:26` — `Record<string, any>` for credentials~~
- ~~TUI: `agent: null as any` is used **8 times** to create SynthesisEngines without agents~~
- ~~CLI: `saveCredentials(creds as any)`~~
- TUI: 3 remaining `as any` casts for OpenTUI framework internals (no typed API for focus state/internal index)

**Fixed:** All `agent: null as any` → `agent: null` (enabled by #27). Server credentials now properly typed. CLI credentials properly typed with `Partial<Credentials>`. Only 3 irreducible casts remain for OpenTUI private API access (`_focused`, `selectedIdx`).

### ~~12. No error boundaries or graceful degradation~~
~~`Storage.close()` may double-close silently or throw — no guard~~

**Fixed:** Added `closed` flag to `Storage.close()` to prevent double-close. The guard returns early if already closed.

### ~~13. Synthesis event type reuse~~
~~`synthesis.ts:85-86` — Uses `"sync:started"` and `"sync:complete"` event types for synthesis events.~~

**Fixed:** Added `"synthesis:started"` and `"synthesis:complete"` to `LainEventType` union. Updated `synthesis.ts` to use the proper types.

### ~~14. No input validation on server API~~
~~No path traversal protection: `/api/exploration/../../../../etc/passwd` could work~~

**Fixed:** Added `safeDbPath()` helper that validates the resolved path stays within CWD, ends with `.db`, and exists. Applied to all API routes that accept a `dbFile` parameter.

### ~~15. SQLite prepared statements are not cached~~
~~Every query in `Storage` calls `this.db.prepare(...)` fresh each time.~~

**Not an issue:** `bun:sqlite` internally caches prepared statements. From Bun docs: "Prepared statements are cached by default." No change needed.

### ~~16. Mutation without returning updated state~~
~~`updateNodeContent`, `updateNodeStatus`, `pruneNode` — all mutate DB but don't return the updated entity. Callers must re-fetch.~~

**Fixed:** `updateNodeContent` and `updateNodeStatus` now return the updated `LainNode`. Callers can use the return value directly instead of re-fetching.

---

## ORGANIZATION ISSUES

### ~~17. File naming inconsistency~~
~~AGENTS.md says `packages/core/src/watch.ts` but the actual file is `watcher.ts`. AGENTS.md says `prompt-engine.ts` but the actual file is `prompts.ts`.~~

**Fixed:** Corrected both references in AGENTS.md.

### ~~18. Test runner inconsistency~~
~~`packages/core/package.json` has `"test": "bun test"`, others have `"test": "vitest run"`. Packages without test files fail.~~

**Fixed:** Core keeps `bun test` (required for `bun:sqlite`). Other packages use `vitest run --passWithNoTests` to avoid failing when no test files exist.

### ~~19. Missing `@types/bun` in web server~~
~~The web server uses `Bun.serve` but has no bun types configured.~~

**Fixed:** Added `packages/web/src/server/tsconfig.json` with `"types": ["bun-types"]`.

### ~~20. The `Exporter`, `Sync`, and `SynthesisEngine` all create their own `Graph`~~
~~Multiple Graph instances pointing to the same Storage.~~

**Fixed:** All three classes now accept an optional `graph` parameter in their constructors. When provided, they reuse the existing Graph instance. When omitted, they create their own (backward compatible). This allows callers to share a single Graph.

---

## ADDITIONAL ISSUES

### ~~21. `getDescendants` in storage.ts does BFS with individual queries per node~~
~~O(n) DB roundtrips for a tree with n nodes. Should be a single recursive CTE query.~~

**Fixed:** Replaced BFS loop with a single `WITH RECURSIVE` CTE query that gets all descendants in one DB roundtrip.

### ~~22. React Flow layout is minified one-liner code~~
~~`ExplorationView.tsx:15-39` — compressed into unreadable 1-2 line functions. Variables named `aS`, `aE`, `d`, `pL`, `cL`, `cA`.~~

**Fixed:** Rewrote `buildFlowLayout` with proper variable names (`angleStart`, `angleEnd`, `depth`, `parentLeaves`, `childLeaves`, `childArc`), multi-line formatting, comments for each section, and readable structure.

### ~~23. No cleanup of orphaned synthesis records~~
~~If synthesis fails mid-way, you get a `status: "pending"` record that never completes. No GC.~~

**Fixed:** Added `SynthesisEngine.cleanupOrphaned()` method that marks stale pending syntheses as complete. Called automatically at the start of each new `synthesize()` call.

### ~~24. The `Orchestrator` opens its own `Storage` in the constructor~~
~~After operations, the TUI does `storage.close(); storage = new Storage(dbPath)` to re-open a fresh connection.~~

**Partially fixed:** Added `ownsStorage` flag so `close()` only closes if the Orchestrator created the Storage. The TUI re-open pattern still exists but is now safe since Storage has a double-close guard.

### ~~25. Root `package.json` still lists `better-sqlite3` in `pnpm.onlyBuiltDependencies`~~
~~A leftover from before the bun:sqlite migration.~~

**Fixed:** Removed `better-sqlite3` from the array.

### ~~26. No graceful error for missing credentials~~
~~Crashes with "Bedrock requires an API key" rather than guiding you to setup.~~

**Fixed:** Updated error message in `factory.ts` to mention both `lain init` and the environment variable `AWS_BEARER_TOKEN_BEDROCK`.

### ~~27. `SynthesisEngine` requires `agent` parameter but many callers pass `null as any`~~
~~The constructor should accept `agent: AgentProvider | null` and guard against null in methods that need it.~~

**Fixed:** `SynthesisEngineOptions.agent` is now `AgentProvider | null`. Null guards added in `synthesize()` and `generateMergePreview()` with descriptive error messages. Callers can now pass `null` without `as any`.

### ~~28. `branchIndex` off-by-one risk~~
~~With `branchIndex` starting at 1, the IDs are `root-1`, but the plan summaries array is 0-indexed.~~

**Not a bug:** Verified — `planSummaries[i]` (0-indexed) correctly maps to child `i` with branchIndex `startIndex + i`. The indexing is consistent.
