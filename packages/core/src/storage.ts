import Database from "better-sqlite3";
import type {
  Exploration,
  LainNode,
  Crosslink,
  Synthesis,
  SynthesisAnnotation,
  SyncState,
  NodeStatus,
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
`;

export class Storage {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
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

  updateNodeContent(
    id: string,
    title: string,
    content: string,
    model: string,
    provider: string
  ): void {
    this.db
      .prepare(
        `UPDATE node SET title = ?, content = ?, model = ?, provider = ?, status = 'complete', updated_at = ? WHERE id = ?`
      )
      .run(title, content, model, provider, new Date().toISOString(), id);
  }

  updateNodeStatus(id: string, status: NodeStatus): void {
    this.db
      .prepare("UPDATE node SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
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
      .run(...values);
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
    // BFS to find all descendants
    const result: LainNode[] = [];
    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = this.getChildren(current);
      for (const child of children) {
        result.push(child);
        queue.push(child.id);
      }
    }
    return result;
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
        `SELECT c.* FROM crosslink c
         JOIN node n ON c.source_id = n.id
         WHERE n.exploration_id = ?`
      )
      .all(explorationId) as Record<string, unknown>[];
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

  // ---- Transaction helper ----

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
