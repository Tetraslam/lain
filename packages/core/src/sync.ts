import { Storage } from "./storage.js";
import { Graph } from "./graph.js";
import { Exporter, contentHash } from "./export.js";
import type { LainNode, SyncState } from "@lain/shared";
import { nowISO } from "@lain/shared";
import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

export interface SyncResult {
  pushed: string[];   // node IDs pushed to files
  pulled: string[];   // node IDs pulled from files
  conflicts: string[]; // node IDs with conflicts
  pruned: string[];   // node IDs pruned (file deleted)
  created: string[];  // node IDs from new files
}

/**
 * Bidirectional sync between SQLite db and obsidian markdown folder.
 * Tracks content and frontmatter separately for fine-grained conflict detection.
 */
export class Sync {
  private graph: Graph;
  private exporter: Exporter;

  constructor(private storage: Storage) {
    this.graph = new Graph(storage);
    this.exporter = new Exporter(storage);
  }

  /**
   * Push db state to markdown files. Records sync state.
   */
  push(explorationId: string, outputDir: string): SyncResult {
    const result: SyncResult = {
      pushed: [],
      pulled: [],
      conflicts: [],
      pruned: [],
      created: [],
    };

    const exploration = this.graph.getExploration(explorationId);
    if (!exploration) throw new Error(`Exploration not found: ${explorationId}`);

    const nodes = this.graph.getAllNodes(explorationId);
    const crosslinks = this.graph.getCrosslinks(explorationId);

    fs.mkdirSync(outputDir, { recursive: true });

    // Write index
    const indexContent = this.exporter.renderIndex(exploration, nodes);
    fs.writeFileSync(path.join(outputDir, "_index.md"), indexContent);

    // Write each node and record sync state
    for (const node of nodes) {
      if (node.status === "pruned") continue;

      const nodeCrosslinks = crosslinks.filter(
        (c) => c.sourceId === node.id || c.targetId === node.id
      );
      const children = nodes.filter(
        (n) => n.parentId === node.id && n.status !== "pruned"
      );
      const fileContent = this.exporter.renderNode(node, nodeCrosslinks, children);
      const fileName = `${node.id}.md`;
      const filePath = path.join(outputDir, fileName);

      fs.writeFileSync(filePath, fileContent);

      // Parse to get separate hashes
      const parsed = matter(fileContent);
      const fmHash = contentHash(
        matter.stringify("", parsed.data).trim()
      );
      const bodyHash = contentHash(parsed.content);

      this.storage.upsertSyncState({
        nodeId: node.id,
        filePath: fileName,
        contentHash: bodyHash,
        frontmatterHash: fmHash,
        dbContentHash: bodyHash,
        dbFrontmatterHash: fmHash,
        syncedAt: nowISO(),
      });

      result.pushed.push(node.id);
    }

    return result;
  }

  /**
   * Pull changes from markdown files into db.
   */
  pull(explorationId: string, inputDir: string): SyncResult {
    const result: SyncResult = {
      pushed: [],
      pulled: [],
      conflicts: [],
      pruned: [],
      created: [],
    };

    const nodes = this.graph.getAllNodes(explorationId);
    const syncStates = this.storage.getAllSyncStates(explorationId);
    const stateMap = new Map(syncStates.map((s) => [s.nodeId, s]));

    // Check each existing node's file
    for (const node of nodes) {
      if (node.status === "pruned") continue;

      const state = stateMap.get(node.id);
      if (!state) continue; // Never synced, skip

      const filePath = path.join(inputDir, state.filePath);

      if (!fs.existsSync(filePath)) {
        // File was deleted
        this.storage.pruneNode(node.id);
        result.pruned.push(node.id);
        continue;
      }

      const fileContent = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(fileContent);

      const fileFmHash = contentHash(
        matter.stringify("", parsed.data).trim()
      );
      const fileBodyHash = contentHash(parsed.content);

      // Check if file changed
      const fmChanged = fileFmHash !== state.frontmatterHash;
      const bodyChanged = fileBodyHash !== state.contentHash;

      if (!fmChanged && !bodyChanged) continue; // No changes

      // File changed — update db
      const updates: {
        title?: string;
        content?: string;
        frontmatter?: Record<string, unknown>;
      } = {};

      if (bodyChanged) {
        updates.content = parsed.content.trim();
        // Extract title from first heading
        const titleMatch = parsed.content.match(/^#\s+(.+)/m);
        if (titleMatch) updates.title = titleMatch[1];
      }

      if (fmChanged) {
        updates.frontmatter = parsed.data as Record<string, unknown>;
      }

      this.storage.updateNodeFromSync(node.id, updates);

      // Update sync state
      this.storage.upsertSyncState({
        ...state,
        contentHash: fileBodyHash,
        frontmatterHash: fileFmHash,
        dbContentHash: fileBodyHash,
        dbFrontmatterHash: fileFmHash,
        syncedAt: nowISO(),
      });

      result.pulled.push(node.id);
    }

    // Check for new files (not yet in db)
    if (fs.existsSync(inputDir)) {
      const files = fs.readdirSync(inputDir).filter(
        (f) => f.endsWith(".md") && f !== "_index.md"
      );
      const nodeIds = new Set(nodes.map((n) => n.id));

      for (const file of files) {
        const nodeId = file.replace(/\.md$/, "");
        if (nodeIds.has(nodeId)) continue;

        // New file — try to import
        const filePath = path.join(inputDir, file);
        const fileContent = fs.readFileSync(filePath, "utf-8");
        const parsed = matter(fileContent);

        if (parsed.data.id && parsed.data.parent) {
          // Has valid frontmatter — this is not implemented in v0.1
          // Would need to create a new node in the db
          result.created.push(nodeId);
        }
      }
    }

    return result;
  }

  /**
   * Full bidirectional sync. Detects conflicts.
   */
  sync(explorationId: string, dir: string): SyncResult {
    const result: SyncResult = {
      pushed: [],
      pulled: [],
      conflicts: [],
      pruned: [],
      created: [],
    };

    const exploration = this.graph.getExploration(explorationId);
    if (!exploration) throw new Error(`Exploration not found: ${explorationId}`);

    const nodes = this.graph.getAllNodes(explorationId);
    const crosslinks = this.graph.getCrosslinks(explorationId);
    const syncStates = this.storage.getAllSyncStates(explorationId);
    const stateMap = new Map(syncStates.map((s) => [s.nodeId, s]));

    fs.mkdirSync(dir, { recursive: true });

    for (const node of nodes) {
      if (node.status === "pruned") continue;

      const state = stateMap.get(node.id);
      const fileName = `${node.id}.md`;
      const filePath = path.join(dir, fileName);
      const fileExists = fs.existsSync(filePath);

      if (!state) {
        // Never synced — push db to file
        const nodeCrosslinks = crosslinks.filter(
          (c) => c.sourceId === node.id || c.targetId === node.id
        );
        const children = nodes.filter(
          (n) => n.parentId === node.id && n.status !== "pruned"
        );
        const fileContent = this.exporter.renderNode(
          node,
          nodeCrosslinks,
          children
        );
        fs.writeFileSync(filePath, fileContent);

        const parsed = matter(fileContent);
        const fmHash = contentHash(matter.stringify("", parsed.data).trim());
        const bodyHash = contentHash(parsed.content);

        this.storage.upsertSyncState({
          nodeId: node.id,
          filePath: fileName,
          contentHash: bodyHash,
          frontmatterHash: fmHash,
          dbContentHash: bodyHash,
          dbFrontmatterHash: fmHash,
          syncedAt: nowISO(),
        });

        result.pushed.push(node.id);
        continue;
      }

      if (!fileExists) {
        // File deleted — prune
        this.storage.pruneNode(node.id);
        result.pruned.push(node.id);
        continue;
      }

      // Both exist — check for changes
      const fileContent = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(fileContent);
      const fileFmHash = contentHash(matter.stringify("", parsed.data).trim());
      const fileBodyHash = contentHash(parsed.content);

      // Compute current db hashes
      const nodeCrosslinks = crosslinks.filter(
        (c) => c.sourceId === node.id || c.targetId === node.id
      );
      const children = nodes.filter(
        (n) => n.parentId === node.id && n.status !== "pruned"
      );
      const dbContent = this.exporter.renderNode(node, nodeCrosslinks, children);
      const dbParsed = matter(dbContent);
      const dbFmHash = contentHash(matter.stringify("", dbParsed.data).trim());
      const dbBodyHash = contentHash(dbParsed.content);

      const fileBodyChanged = fileBodyHash !== state.contentHash;
      const fileFmChanged = fileFmHash !== state.frontmatterHash;
      const dbBodyChanged = dbBodyHash !== state.dbContentHash;
      const dbFmChanged = dbFmHash !== state.dbFrontmatterHash;

      // Resolve content
      if (fileBodyChanged && dbBodyChanged) {
        // Conflict on content — file wins, db preserved as conflict
        this.storage.setNodeConflict(node.id, node.content || "");
        this.storage.updateNodeFromSync(node.id, {
          content: parsed.content.trim(),
        });
        result.conflicts.push(node.id);
      } else if (fileBodyChanged) {
        // File changed only
        const titleMatch = parsed.content.match(/^#\s+(.+)/m);
        this.storage.updateNodeFromSync(node.id, {
          content: parsed.content.trim(),
          title: titleMatch?.[1],
        });
        result.pulled.push(node.id);
      } else if (dbBodyChanged) {
        // DB changed only — overwrite file
        // (will be written below when we update sync state)
      }

      // Resolve frontmatter
      if (fileFmChanged && dbFmChanged) {
        // Conflict on frontmatter — file wins
        this.storage.updateNodeFromSync(node.id, {
          frontmatter: parsed.data as Record<string, unknown>,
        });
        if (!result.conflicts.includes(node.id)) {
          result.conflicts.push(node.id);
        }
      } else if (fileFmChanged) {
        this.storage.updateNodeFromSync(node.id, {
          frontmatter: parsed.data as Record<string, unknown>,
        });
        if (!result.pulled.includes(node.id)) {
          result.pulled.push(node.id);
        }
      }

      // Re-render and write file (picks up db changes or confirms file state)
      const updatedNode = this.graph.getNode(node.id)!;
      const updatedCrosslinks = crosslinks.filter(
        (c) => c.sourceId === node.id || c.targetId === node.id
      );
      const updatedChildren = nodes.filter(
        (n) => n.parentId === node.id && n.status !== "pruned"
      );
      const updatedContent = this.exporter.renderNode(
        updatedNode,
        updatedCrosslinks,
        updatedChildren
      );
      fs.writeFileSync(filePath, updatedContent);

      // Update sync state
      const finalParsed = matter(updatedContent);
      const finalFmHash = contentHash(
        matter.stringify("", finalParsed.data).trim()
      );
      const finalBodyHash = contentHash(finalParsed.content);

      this.storage.upsertSyncState({
        nodeId: node.id,
        filePath: fileName,
        contentHash: finalBodyHash,
        frontmatterHash: finalFmHash,
        dbContentHash: finalBodyHash,
        dbFrontmatterHash: finalFmHash,
        syncedAt: nowISO(),
      });

      if (dbBodyChanged || dbFmChanged) {
        if (!result.pushed.includes(node.id)) {
          result.pushed.push(node.id);
        }
      }
    }

    // Write index
    const indexContent = this.exporter.renderIndex(exploration, nodes);
    fs.writeFileSync(path.join(dir, "_index.md"), indexContent);

    return result;
  }

  /**
   * Get sync status without making changes.
   */
  status(explorationId: string, dir: string): {
    fileChanged: string[];
    dbChanged: string[];
    conflicts: string[];
    deleted: string[];
    newFiles: string[];
  } {
    const result = {
      fileChanged: [] as string[],
      dbChanged: [] as string[],
      conflicts: [] as string[],
      deleted: [] as string[],
      newFiles: [] as string[],
    };

    const nodes = this.graph.getAllNodes(explorationId);
    const crosslinks = this.graph.getCrosslinks(explorationId);
    const syncStates = this.storage.getAllSyncStates(explorationId);
    const stateMap = new Map(syncStates.map((s) => [s.nodeId, s]));

    for (const node of nodes) {
      if (node.status === "pruned") continue;
      const state = stateMap.get(node.id);
      if (!state) continue;

      const filePath = path.join(dir, state.filePath);
      if (!fs.existsSync(filePath)) {
        result.deleted.push(node.id);
        continue;
      }

      const fileContent = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(fileContent);
      const fileFmHash = contentHash(matter.stringify("", parsed.data).trim());
      const fileBodyHash = contentHash(parsed.content);

      const nodeCrosslinks = crosslinks.filter(
        (c) => c.sourceId === node.id || c.targetId === node.id
      );
      const children = nodes.filter(
        (n) => n.parentId === node.id && n.status !== "pruned"
      );
      const dbContent = this.exporter.renderNode(node, nodeCrosslinks, children);
      const dbParsed = matter(dbContent);
      const dbFmHash = contentHash(matter.stringify("", dbParsed.data).trim());
      const dbBodyHash = contentHash(dbParsed.content);

      const fileChanged =
        fileBodyHash !== state.contentHash ||
        fileFmHash !== state.frontmatterHash;
      const dbChanged =
        dbBodyHash !== state.dbContentHash ||
        dbFmHash !== state.dbFrontmatterHash;

      if (fileChanged && dbChanged) result.conflicts.push(node.id);
      else if (fileChanged) result.fileChanged.push(node.id);
      else if (dbChanged) result.dbChanged.push(node.id);
    }

    return result;
  }
}
