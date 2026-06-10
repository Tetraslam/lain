import { Database } from "bun:sqlite";
import { generateId } from "@lain/shared";
import type {
  Exploration,
  LainNode,
  Crosslink,
  Synthesis,
  SynthesisAnnotation,
  NodeAnnotation,
  SyncState,
  NodeStatus,
  CorpusSource,
  CorpusChunk,
  Mission,
  MissionReport,
  Finding,
  Citation,
} from "@lain/shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exploration (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seed TEXT NOT NULL,
  n INTEGER NOT NULL,
  m INTEGER NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'bf',
  plan_detail TEXT NOT NULL DEFAULT 'sentence',
  extension TEXT NOT NULL DEFAULT 'freeform',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node (
  id TEXT PRIMARY KEY,
  exploration_id TEXT NOT NULL REFERENCES exploration(id),
  parent_id TEXT REFERENCES node(id),
  content TEXT,
  content_conflict TEXT,
  title TEXT,
  depth INTEGER NOT NULL,
  branch_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  model TEXT,
  provider TEXT,
  plan_summary TEXT,
  extension_data TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crosslink (
  source_id TEXT NOT NULL REFERENCES node(id),
  target_id TEXT NOT NULL REFERENCES node(id),
  label TEXT,
  ai_suggested INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id)
);

CREATE TABLE IF NOT EXISTS synthesis (
  id TEXT PRIMARY KEY,
  exploration_id TEXT NOT NULL REFERENCES exploration(id),
  content TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  merged INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS synthesis_annotation (
  id TEXT PRIMARY KEY,
  synthesis_id TEXT NOT NULL REFERENCES synthesis(id),
  type TEXT NOT NULL,
  source_node_id TEXT REFERENCES node(id),
  target_node_id TEXT REFERENCES node(id),
  content TEXT,
  merged INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  node_id TEXT PRIMARY KEY REFERENCES node(id),
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  frontmatter_hash TEXT NOT NULL,
  db_content_hash TEXT NOT NULL,
  db_frontmatter_hash TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_node_exploration ON node(exploration_id);
CREATE INDEX IF NOT EXISTS idx_node_parent ON node(parent_id);
CREATE INDEX IF NOT EXISTS idx_node_depth ON node(depth);
CREATE INDEX IF NOT EXISTS idx_node_status ON node(status);
CREATE INDEX IF NOT EXISTS idx_crosslink_source ON crosslink(source_id);
CREATE INDEX IF NOT EXISTS idx_crosslink_target ON crosslink(target_id);

CREATE TABLE IF NOT EXISTS node_annotation (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES node(id),
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'synthesis',
  synthesis_annotation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_node_annotation_node ON node_annotation(node_id);

CREATE TABLE IF NOT EXISTS corpus_source (
  id TEXT PRIMARY KEY,
  exploration_id TEXT NOT NULL REFERENCES exploration(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT,
  byte_size INTEGER,
  data TEXT,
  image_format TEXT,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corpus_source_exploration ON corpus_source(exploration_id);

CREATE TABLE IF NOT EXISTS corpus_chunk (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES corpus_source(id),
  exploration_id TEXT NOT NULL REFERENCES exploration(id),
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  token_estimate INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corpus_chunk_exploration ON corpus_chunk(exploration_id);
CREATE INDEX IF NOT EXISTS idx_corpus_chunk_source ON corpus_chunk(source_id);

CREATE TABLE IF NOT EXISTS mission (
  exploration_id TEXT PRIMARY KEY REFERENCES exploration(id),
  intent TEXT NOT NULL,
  assertions TEXT NOT NULL DEFAULT '[]',
  features TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_report (
  id TEXT PRIMARY KEY,
  exploration_id TEXT NOT NULL REFERENCES exploration(id),
  round INTEGER NOT NULL,
  satisfied INTEGER NOT NULL,
  results TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mission_report_exploration ON mission_report(exploration_id);

CREATE TABLE IF NOT EXISTS finding (
  id TEXT PRIMARY KEY,
  exploration_id TEXT NOT NULL REFERENCES exploration(id),
  node_id TEXT,
  content TEXT NOT NULL,
  tags TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finding_exploration ON finding(exploration_id);

CREATE TABLE IF NOT EXISTS citation (
  id TEXT PRIMARY KEY,
  exploration_id TEXT NOT NULL REFERENCES exploration(id),
  node_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  quote TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_citation_exploration ON citation(exploration_id);
CREATE INDEX IF NOT EXISTS idx_citation_node ON citation(node_id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Current on-disk schema version. Bump when adding a migration step.
 *   1 = original (exploration/node/crosslink/synthesis/sync/annotations)
 *   2 = substrate (corpus, mission, finding tables)
 *   3 = mission gained assertions/features (rebuild legacy NOT-NULL column)
 *   4 = citation table (additive via IF NOT EXISTS; nothing to backfill)
 * All tables use CREATE TABLE IF NOT EXISTS, so opening an older db with newer
 * lain transparently adds missing tables; the version + migrations runner
 * exists for future destructive/altering changes that IF NOT EXISTS can't cover.
 */
export const CURRENT_SCHEMA_VERSION = 4;

/**
 * Ordered, idempotent migrations for changes that additive CREATE-IF-NOT-EXISTS
 * can't handle (column adds, backfills, …). Keyed by the version they upgrade
 * TO. Each receives the raw db.
 */
const MIGRATIONS: Record<number, (db: Database) => void> = {
  // 2: tables added via SCHEMA (IF NOT EXISTS); nothing extra to do.
  // 3: mission gained assertions/features (replacing the old NOT NULL `criteria`
  //    column); mission_report added via SCHEMA. Rebuild the table to the
  //    canonical shape so the legacy NOT-NULL column can't block inserts.
  3: (db) => {
    const cols = (db.prepare("PRAGMA table_info(mission)").all() as { name: string }[]).map((c) => c.name);
    if (cols.includes("assertions") && cols.includes("features") && !cols.includes("criteria")) return;
    const a = cols.includes("assertions") ? "assertions" : "'[]'";
    const f = cols.includes("features") ? "features" : "'[]'";
    db.run("ALTER TABLE mission RENAME TO mission_old");
    db.run(
      `CREATE TABLE mission (exploration_id TEXT PRIMARY KEY REFERENCES exploration(id),
       intent TEXT NOT NULL, assertions TEXT NOT NULL DEFAULT '[]', features TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`
    );
    db.run(`INSERT INTO mission (exploration_id, intent, assertions, features, created_at)
            SELECT exploration_id, intent, ${a}, ${f}, created_at FROM mission_old`);
    db.run("DROP TABLE mission_old");
  },
};

export class Storage {
  private db: Database;
  private closed = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Apply any pending schema migrations and stamp the current version. */
  private migrate(): void {
    const stored = this.getSchemaVersion();
    if (stored === CURRENT_SCHEMA_VERSION) return;
    // Fresh db (no version row) or older: run migrations up to current.
    const from = stored ?? CURRENT_SCHEMA_VERSION; // unstamped existing dbs are already at current shape (IF NOT EXISTS)
    for (let v = from + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
      MIGRATIONS[v]?.(this.db);
    }
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(CURRENT_SCHEMA_VERSION));
  }

  /** Read the stored schema version, or null if unstamped. */
  getSchemaVersion(): number | null {
    try {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
      return row?.value ? Number(row.value) : null;
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ---- Exploration ----

  createExploration(exp: Exploration): void {
    this.db
      .prepare(
        `INSERT INTO exploration (id, name, seed, n, m, strategy, plan_detail, extension, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        exp.id,
        exp.name,
        exp.seed,
        exp.n,
        exp.m,
        exp.strategy,
        exp.planDetail,
        exp.extension,
        exp.createdAt,
        exp.updatedAt
      );
  }

  getExploration(id: string): Exploration | null {
    const row = this.db
      .prepare("SELECT * FROM exploration WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToExploration(row) : null;
  }

  getExplorationsAll(): Exploration[] {
    const rows = this.db
      .prepare("SELECT * FROM exploration ORDER BY created_at DESC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToExploration(r));
  }

  private rowToExploration(row: Record<string, unknown>): Exploration {
    return {
      id: row.id as string,
      name: row.name as string,
      seed: row.seed as string,
      n: row.n as number,
      m: row.m as number,
      strategy: row.strategy as Exploration["strategy"],
      planDetail: row.plan_detail as Exploration["planDetail"],
      extension: row.extension as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  // ---- Node ----

  createNode(node: LainNode): void {
    this.db
      .prepare(
        `INSERT INTO node (id, exploration_id, parent_id, content, content_conflict, title, depth, branch_index, status, model, provider, plan_summary, extension_data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        node.id,
        node.explorationId,
        node.parentId,
        node.content,
        node.contentConflict,
        node.title,
        node.depth,
        node.branchIndex,
        node.status,
        node.model,
        node.provider,
        node.planSummary,
        node.extensionData ? JSON.stringify(node.extensionData) : null,
        node.createdAt,
        node.updatedAt
      );
  }

  getNode(id: string): LainNode | null {
    const row = this.db.prepare("SELECT * FROM node WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToNode(row) : null;
  }

  getNodesByExploration(explorationId: string): LainNode[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM node WHERE exploration_id = ? ORDER BY depth, branch_index"
      )
      .all(explorationId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  getChildren(nodeId: string): LainNode[] {
    const rows = this.db
      .prepare("SELECT * FROM node WHERE parent_id = ? ORDER BY branch_index")
      .all(nodeId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  getNodesByStatus(
    explorationId: string,
    status: NodeStatus
  ): LainNode[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM node WHERE exploration_id = ? AND status = ? ORDER BY depth, branch_index"
      )
      .all(explorationId, status) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  getNodesByDepth(explorationId: string, depth: number): LainNode[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM node WHERE exploration_id = ? AND depth = ? ORDER BY branch_index"
      )
      .all(explorationId, depth) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  updateNodeContent(
    id: string,
    title: string,
    content: string,
    model: string,
    provider: string
  ): LainNode {
    this.db
      .prepare(
        `UPDATE node SET title = ?, content = ?, model = ?, provider = ?, status = 'complete', updated_at = ? WHERE id = ?`
      )
      .run(title, content, model, provider, new Date().toISOString(), id);
    return this.getNode(id)!;
  }

  updateNodeStatus(id: string, status: NodeStatus): LainNode {
    this.db
      .prepare("UPDATE node SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
    return this.getNode(id)!;
  }

  updateNodeFromSync(
    id: string,
    updates: { title?: string; content?: string; frontmatter?: Record<string, unknown> }
  ): void {
    const parts: string[] = [];
    const values: unknown[] = [];

    if (updates.title !== undefined) {
      parts.push("title = ?");
      values.push(updates.title);
    }
    if (updates.content !== undefined) {
      parts.push("content = ?");
      values.push(updates.content);
    }
    if (updates.frontmatter !== undefined) {
      // Update individual frontmatter fields that map to node columns
      const fm = updates.frontmatter;
      if (fm.status !== undefined) {
        parts.push("status = ?");
        values.push(fm.status);
      }
      if (fm.extension_data !== undefined) {
        parts.push("extension_data = ?");
        values.push(JSON.stringify(fm.extension_data));
      }
    }

    if (parts.length === 0) return;

    parts.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    this.db
      .prepare(`UPDATE node SET ${parts.join(", ")} WHERE id = ?`)
      .run(...(values as any[]));
  }

  setNodeConflict(id: string, conflictContent: string): void {
    this.db
      .prepare(
        "UPDATE node SET content_conflict = ?, updated_at = ? WHERE id = ?"
      )
      .run(conflictContent, new Date().toISOString(), id);
  }

  clearNodeConflict(id: string): void {
    this.db
      .prepare(
        "UPDATE node SET content_conflict = NULL, updated_at = ? WHERE id = ?"
      )
      .run(new Date().toISOString(), id);
  }

  pruneNode(id: string): void {
    // Prune this node and all descendants
    const descendants = this.getDescendants(id);
    const ids = [id, ...descendants.map((d) => d.id)];
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE node SET status = 'pruned', updated_at = ? WHERE id IN (${placeholders})`
      )
      .run(new Date().toISOString(), ...ids);
  }

  getDescendants(nodeId: string): LainNode[] {
    // Use recursive CTE for efficient single-query traversal
    const rows = this.db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM node WHERE parent_id = ?
           UNION ALL
           SELECT n.id FROM node n JOIN descendants d ON n.parent_id = d.id
         )
         SELECT node.* FROM node JOIN descendants ON node.id = descendants.id
         ORDER BY node.depth, node.branch_index`
      )
      .all(nodeId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  getAncestors(nodeId: string): LainNode[] {
    const ancestors: LainNode[] = [];
    let current = this.getNode(nodeId);
    while (current?.parentId) {
      const parent = this.getNode(current.parentId);
      if (!parent) break;
      ancestors.unshift(parent); // oldest first
      current = parent;
    }
    return ancestors;
  }

  private rowToNode(row: Record<string, unknown>): LainNode {
    return {
      id: row.id as string,
      explorationId: row.exploration_id as string,
      parentId: (row.parent_id as string) || null,
      content: (row.content as string) || null,
      contentConflict: (row.content_conflict as string) || null,
      title: (row.title as string) || null,
      depth: row.depth as number,
      branchIndex: row.branch_index as number,
      status: row.status as NodeStatus,
      model: (row.model as string) || null,
      provider: (row.provider as LainNode["provider"]) || null,
      planSummary: (row.plan_summary as string) || null,
      extensionData: row.extension_data
        ? (JSON.parse(row.extension_data as string) as Record<string, unknown>)
        : null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  // ---- Crosslink ----

  createCrosslink(link: Crosslink): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO crosslink (source_id, target_id, label, ai_suggested, created_at)
       VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        link.sourceId,
        link.targetId,
        link.label,
        link.aiSuggested ? 1 : 0,
        link.createdAt
      );
  }

  getCrosslinksForNode(nodeId: string): Crosslink[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM crosslink WHERE source_id = ? OR target_id = ?"
      )
      .all(nodeId, nodeId) as Record<string, unknown>[];
    return rows.map((r) => ({
      sourceId: r.source_id as string,
      targetId: r.target_id as string,
      label: (r.label as string) || null,
      aiSuggested: r.ai_suggested === 1,
      createdAt: r.created_at as string,
    }));
  }

  getCrosslinksForExploration(explorationId: string): Crosslink[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.* FROM crosslink c
         JOIN node n1 ON c.source_id = n1.id
         JOIN node n2 ON c.target_id = n2.id
         WHERE n1.exploration_id = ? OR n2.exploration_id = ?`
      )
      .all(explorationId, explorationId) as Record<string, unknown>[];
    return rows.map((r) => ({
      sourceId: r.source_id as string,
      targetId: r.target_id as string,
      label: (r.label as string) || null,
      aiSuggested: r.ai_suggested === 1,
      createdAt: r.created_at as string,
    }));
  }

  // ---- Sync State ----

  getSyncState(nodeId: string): SyncState | null {
    const row = this.db
      .prepare("SELECT * FROM sync_state WHERE node_id = ?")
      .get(nodeId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      nodeId: row.node_id as string,
      filePath: row.file_path as string,
      contentHash: row.content_hash as string,
      frontmatterHash: row.frontmatter_hash as string,
      dbContentHash: row.db_content_hash as string,
      dbFrontmatterHash: row.db_frontmatter_hash as string,
      syncedAt: row.synced_at as string,
    };
  }

  upsertSyncState(state: SyncState): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sync_state (node_id, file_path, content_hash, frontmatter_hash, db_content_hash, db_frontmatter_hash, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        state.nodeId,
        state.filePath,
        state.contentHash,
        state.frontmatterHash,
        state.dbContentHash,
        state.dbFrontmatterHash,
        state.syncedAt
      );
  }

  getAllSyncStates(explorationId: string): SyncState[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM sync_state s
         JOIN node n ON s.node_id = n.id
         WHERE n.exploration_id = ?`
      )
      .all(explorationId) as Record<string, unknown>[];
    return rows.map((r) => ({
      nodeId: r.node_id as string,
      filePath: r.file_path as string,
      contentHash: r.content_hash as string,
      frontmatterHash: r.frontmatter_hash as string,
      dbContentHash: r.db_content_hash as string,
      dbFrontmatterHash: r.db_frontmatter_hash as string,
      syncedAt: r.synced_at as string,
    }));
  }

  deleteSyncState(nodeId: string): void {
    this.db.prepare("DELETE FROM sync_state WHERE node_id = ?").run(nodeId);
  }

  // ---- Synthesis ----

  createSynthesis(synth: Synthesis): void {
    this.db
      .prepare(
        `INSERT INTO synthesis (id, exploration_id, content, model, status, merged, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        synth.id,
        synth.explorationId,
        synth.content,
        synth.model,
        synth.status,
        synth.merged ? 1 : 0,
        synth.createdAt
      );
  }

  getSynthesis(id: string): Synthesis | null {
    const row = this.db
      .prepare("SELECT * FROM synthesis WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSynthesis(row) : null;
  }

  getSynthesesForExploration(explorationId: string): Synthesis[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM synthesis WHERE exploration_id = ? ORDER BY created_at DESC"
      )
      .all(explorationId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSynthesis(r));
  }

  updateSynthesisStatus(id: string, status: Synthesis["status"]): void {
    this.db
      .prepare("UPDATE synthesis SET status = ? WHERE id = ?")
      .run(status, id);
  }

  updateSynthesisContent(id: string, content: string, model: string): void {
    this.db
      .prepare(
        "UPDATE synthesis SET content = ?, model = ?, status = 'complete' WHERE id = ?"
      )
      .run(content, model, id);
  }

  markSynthesisMerged(id: string): void {
    this.db
      .prepare("UPDATE synthesis SET merged = 1 WHERE id = ?")
      .run(id);
  }

  private rowToSynthesis(row: Record<string, unknown>): Synthesis {
    return {
      id: row.id as string,
      explorationId: row.exploration_id as string,
      content: row.content as string,
      model: (row.model as string) || null,
      status: row.status as Synthesis["status"],
      merged: row.merged === 1,
      createdAt: row.created_at as string,
    };
  }

  // ---- Synthesis Annotations ----

  createAnnotation(annotation: SynthesisAnnotation): void {
    this.db
      .prepare(
        `INSERT INTO synthesis_annotation (id, synthesis_id, type, source_node_id, target_node_id, content, merged, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        annotation.id,
        annotation.synthesisId,
        annotation.type,
        annotation.sourceNodeId,
        annotation.targetNodeId,
        annotation.content,
        annotation.merged ? 1 : 0,
        annotation.createdAt
      );
  }

  getAnnotation(id: string): SynthesisAnnotation | null {
    const row = this.db
      .prepare("SELECT * FROM synthesis_annotation WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToAnnotation(row) : null;
  }

  getAnnotationsForSynthesis(synthesisId: string): SynthesisAnnotation[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM synthesis_annotation WHERE synthesis_id = ? ORDER BY type, created_at"
      )
      .all(synthesisId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToAnnotation(r));
  }

  getUnmergedAnnotations(synthesisId: string): SynthesisAnnotation[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM synthesis_annotation WHERE synthesis_id = ? AND merged = 0 ORDER BY type, created_at"
      )
      .all(synthesisId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToAnnotation(r));
  }

  markAnnotationMerged(id: string): void {
    this.db
      .prepare("UPDATE synthesis_annotation SET merged = 1 WHERE id = ?")
      .run(id);
  }

  markAllAnnotationsMerged(synthesisId: string): void {
    this.db
      .prepare("UPDATE synthesis_annotation SET merged = 1 WHERE synthesis_id = ?")
      .run(synthesisId);
  }

  private rowToAnnotation(row: Record<string, unknown>): SynthesisAnnotation {
    return {
      id: row.id as string,
      synthesisId: row.synthesis_id as string,
      type: row.type as SynthesisAnnotation["type"],
      sourceNodeId: (row.source_node_id as string) || null,
      targetNodeId: (row.target_node_id as string) || null,
      content: (row.content as string) || null,
      merged: row.merged === 1,
      createdAt: row.created_at as string,
    };
  }

  // ---- Node Annotations (persistent notes on nodes) ----

  createNodeAnnotation(annotation: NodeAnnotation): void {
    this.db
      .prepare(
        `INSERT INTO node_annotation (id, node_id, content, source, synthesis_annotation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        annotation.id,
        annotation.nodeId,
        annotation.content,
        annotation.source,
        annotation.synthesisAnnotationId,
        annotation.createdAt
      );
  }

  getNodeAnnotations(nodeId: string): NodeAnnotation[] {
    const rows = this.db
      .prepare("SELECT * FROM node_annotation WHERE node_id = ? ORDER BY created_at")
      .all(nodeId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      nodeId: r.node_id as string,
      content: r.content as string,
      source: r.source as NodeAnnotation["source"],
      synthesisAnnotationId: (r.synthesis_annotation_id as string) || null,
      createdAt: r.created_at as string,
    }));
  }

  deleteNodeAnnotation(id: string): void {
    this.db.prepare("DELETE FROM node_annotation WHERE id = ?").run(id);
  }

  // ---- Corpus (multimodal source material) ----

  createCorpusSource(source: CorpusSource): void {
    this.db
      .prepare(
        `INSERT INTO corpus_source (id, exploration_id, name, kind, mime, byte_size, data, image_format, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        source.id,
        source.explorationId,
        source.name,
        source.kind,
        source.mime,
        source.byteSize,
        source.data,
        source.imageFormat,
        source.meta ? JSON.stringify(source.meta) : null,
        source.createdAt
      );
  }

  createCorpusChunks(chunks: CorpusChunk[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO corpus_chunk (id, source_id, exploration_id, seq, text, token_estimate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const c of chunks) {
        stmt.run(c.id, c.sourceId, c.explorationId, c.seq, c.text, c.tokenEstimate, c.createdAt);
      }
    })();
  }

  getCorpusSources(explorationId: string): CorpusSource[] {
    const rows = this.db
      .prepare("SELECT * FROM corpus_source WHERE exploration_id = ? ORDER BY created_at")
      .all(explorationId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToCorpusSource(r));
  }

  getCorpusSource(id: string): CorpusSource | null {
    const row = this.db.prepare("SELECT * FROM corpus_source WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToCorpusSource(row) : null;
  }

  getCorpusChunks(explorationId: string): CorpusChunk[] {
    const rows = this.db
      .prepare("SELECT * FROM corpus_chunk WHERE exploration_id = ? ORDER BY source_id, seq")
      .all(explorationId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToCorpusChunk(r));
  }

  deleteCorpusSource(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM corpus_chunk WHERE source_id = ?").run(id);
      this.db.prepare("DELETE FROM corpus_source WHERE id = ?").run(id);
    })();
  }

  private rowToCorpusSource(r: Record<string, unknown>): CorpusSource {
    return {
      id: r.id as string,
      explorationId: r.exploration_id as string,
      name: r.name as string,
      kind: r.kind as CorpusSource["kind"],
      mime: (r.mime as string) ?? null,
      byteSize: (r.byte_size as number) ?? null,
      data: (r.data as string) ?? null,
      imageFormat: (r.image_format as CorpusSource["imageFormat"]) ?? null,
      meta: r.meta ? (JSON.parse(r.meta as string) as Record<string, unknown>) : null,
      createdAt: r.created_at as string,
    };
  }

  private rowToCorpusChunk(r: Record<string, unknown>): CorpusChunk {
    return {
      id: r.id as string,
      sourceId: r.source_id as string,
      explorationId: r.exploration_id as string,
      seq: r.seq as number,
      text: r.text as string,
      tokenEstimate: (r.token_estimate as number) ?? null,
      createdAt: r.created_at as string,
    };
  }

  // ---- Mission (intent contract) ----

  upsertMission(mission: Mission): void {
    this.db
      .prepare(
        `INSERT INTO mission (exploration_id, intent, assertions, features, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(exploration_id) DO UPDATE SET
           intent = excluded.intent, assertions = excluded.assertions, features = excluded.features`
      )
      .run(
        mission.explorationId,
        mission.intent,
        JSON.stringify(mission.assertions),
        JSON.stringify(mission.features),
        mission.createdAt
      );
  }

  getMission(explorationId: string): Mission | null {
    const row = this.db.prepare("SELECT * FROM mission WHERE exploration_id = ?").get(explorationId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const parse = <T>(v: unknown): T[] => { try { return v ? (JSON.parse(v as string) as T[]) : []; } catch { return []; } };
    return {
      explorationId: row.exploration_id as string,
      intent: row.intent as string,
      assertions: parse(row.assertions),
      features: parse(row.features),
      createdAt: row.created_at as string,
    };
  }

  addMissionReport(report: MissionReport): void {
    this.db
      .prepare(
        `INSERT INTO mission_report (id, exploration_id, round, satisfied, results, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        generateId(),
        report.explorationId,
        report.round,
        report.satisfied ? 1 : 0,
        JSON.stringify(report.results),
        report.summary,
        report.createdAt
      );
  }

  getMissionReports(explorationId: string): MissionReport[] {
    const rows = this.db
      .prepare("SELECT * FROM mission_report WHERE exploration_id = ? ORDER BY round, created_at")
      .all(explorationId) as Record<string, unknown>[];
    return rows.map((r) => ({
      explorationId: r.exploration_id as string,
      round: r.round as number,
      satisfied: r.satisfied === 1,
      results: (() => { try { return JSON.parse(r.results as string); } catch { return []; } })(),
      summary: (r.summary as string) ?? "",
      createdAt: r.created_at as string,
    }));
  }

  getLatestMissionReport(explorationId: string): MissionReport | null {
    const reports = this.getMissionReports(explorationId);
    return reports.length ? reports[reports.length - 1] : null;
  }

  // ---- Findings (shared knowledge library) ----

  createFinding(finding: Finding): void {
    this.db
      .prepare(
        `INSERT INTO finding (id, exploration_id, node_id, content, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        finding.id,
        finding.explorationId,
        finding.nodeId,
        finding.content,
        finding.tags.length ? JSON.stringify(finding.tags) : null,
        finding.createdAt
      );
  }

  getFindings(explorationId: string): Finding[] {
    const rows = this.db
      .prepare("SELECT * FROM finding WHERE exploration_id = ? ORDER BY created_at")
      .all(explorationId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToFinding(r));
  }

  private rowToFinding(r: Record<string, unknown>): Finding {
    return {
      id: r.id as string,
      explorationId: r.exploration_id as string,
      nodeId: (r.node_id as string) ?? null,
      content: r.content as string,
      tags: r.tags ? (JSON.parse(r.tags as string) as string[]) : [],
      createdAt: r.created_at as string,
    };
  }

  // ---- Citations (web sources grounding a node's claims) ----

  /**
   * Record a source for a node and return its 1-based marker. Reusing a URL
   * already cited on the same node returns the existing marker (dedup), so the
   * agent can reference the same source repeatedly without duplicating it.
   */
  addCitation(input: { explorationId: string; nodeId: string; url: string; title?: string; quote?: string }): number {
    const url = input.url.trim();
    const existing = this.db
      .prepare("SELECT idx FROM citation WHERE node_id = ? AND url = ? LIMIT 1")
      .get(input.nodeId, url) as { idx?: number } | undefined;
    if (existing?.idx) return existing.idx;
    const next = (this.db.prepare("SELECT COALESCE(MAX(idx), 0) + 1 AS n FROM citation WHERE node_id = ?").get(input.nodeId) as { n: number }).n;
    this.db
      .prepare("INSERT INTO citation (id, exploration_id, node_id, idx, url, title, quote, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(generateId(), input.explorationId, input.nodeId, next, url, input.title?.trim() || null, input.quote?.trim() || null, new Date().toISOString());
    return next;
  }

  getCitationsForNode(nodeId: string): Citation[] {
    const rows = this.db.prepare("SELECT * FROM citation WHERE node_id = ? ORDER BY idx").all(nodeId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToCitation(r));
  }

  getCitations(explorationId: string): Citation[] {
    const rows = this.db.prepare("SELECT * FROM citation WHERE exploration_id = ? ORDER BY node_id, idx").all(explorationId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToCitation(r));
  }

  /** Drop a node's citations (used when the node is regenerated/revised). */
  clearNodeCitations(nodeId: string): void {
    this.db.prepare("DELETE FROM citation WHERE node_id = ?").run(nodeId);
  }

  private rowToCitation(r: Record<string, unknown>): Citation {
    return {
      id: r.id as string,
      explorationId: r.exploration_id as string,
      nodeId: r.node_id as string,
      idx: r.idx as number,
      url: r.url as string,
      title: (r.title as string) ?? "",
      quote: (r.quote as string) ?? null,
      createdAt: r.created_at as string,
    };
  }

  // ---- Transaction helper ----

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
