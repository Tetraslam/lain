import { Storage } from "./storage.js";
import { Sync } from "./sync.js";
import type { LainEventHandler } from "@lain/shared";
import { nowISO } from "@lain/shared";
import * as chokidar from "chokidar";
import * as fs from "fs";
import * as path from "path";

export interface WatcherOptions {
  dbPath: string;
  explorationId: string;
  dir: string;
  debounceMs?: number;
  onDelete?: "prune" | "ignore";
  onEvent?: LainEventHandler;
}

/**
 * File watcher daemon that auto-syncs on markdown file changes.
 */
export class Watcher {
  private storage: Storage;
  private sync: Sync;
  private watcher: chokidar.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges = new Set<string>();
  private selfWrites = new Set<string>(); // paths we just wrote — ignore these
  private options: Required<
    Pick<WatcherOptions, "debounceMs" | "onDelete">
  > & WatcherOptions;
  private lockPath: string;
  private running = false;

  constructor(options: WatcherOptions) {
    this.options = {
      debounceMs: 500,
      onDelete: "prune",
      ...options,
    };
    this.storage = new Storage(options.dbPath);
    this.sync = new Sync(this.storage);
    this.lockPath = options.dbPath + ".lock";
  }

  /**
   * Start watching. Returns when stopped.
   */
  async start(): Promise<void> {
    if (this.running) throw new Error("Watcher already running");
    this.running = true;

    // Write lock file
    fs.writeFileSync(this.lockPath, String(process.pid));

    // Load .lainignore patterns
    const ignorePatterns = this.loadIgnorePatterns();

    this.watcher = chokidar.watch(this.options.dir, {
      ignored: [
        /(^|[/\\])\./,          // hidden files
        /node_modules/,
        /_index\.md$/,           // we manage this ourselves
        ...ignorePatterns,
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    });

    this.watcher.on("change", (filePath) => this.onFileChange(filePath));
    this.watcher.on("add", (filePath) => this.onFileChange(filePath));
    this.watcher.on("unlink", (filePath) => this.onFileDelete(filePath));

    this.emit("sync:started");

    // Keep running until stopped
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!this.running) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Stop the watcher.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Clean up lock file
    if (fs.existsSync(this.lockPath)) {
      fs.unlinkSync(this.lockPath);
    }
    this.storage.close();
  }

  /**
   * Mark paths as self-written so the watcher ignores them.
   */
  markSelfWrite(filePaths: string[]): void {
    for (const p of filePaths) {
      this.selfWrites.add(path.resolve(p));
    }
    // Clear after debounce window + buffer
    setTimeout(() => {
      for (const p of filePaths) {
        this.selfWrites.delete(path.resolve(p));
      }
    }, this.options.debounceMs + 200);
  }

  private onFileChange(filePath: string): void {
    if (!filePath.endsWith(".md")) return;
    if (this.selfWrites.has(path.resolve(filePath))) return;

    this.pendingChanges.add(filePath);
    this.debouncedSync();
  }

  private onFileDelete(filePath: string): void {
    if (!filePath.endsWith(".md")) return;
    if (this.options.onDelete === "ignore") return;
    if (this.selfWrites.has(path.resolve(filePath))) return;

    this.pendingChanges.add(filePath);
    this.debouncedSync();
  }

  private debouncedSync(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.performSync();
    }, this.options.debounceMs);
  }

  private performSync(): void {
    try {
      const result = this.sync.pull(
        this.options.explorationId,
        this.options.dir
      );

      for (const id of result.pulled) {
        this.emit("sync:file-changed", id);
      }
      for (const id of result.conflicts) {
        this.emit("sync:conflict", id);
      }

      this.emit("sync:complete");
    } catch (error) {
      this.emit("error", undefined, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.pendingChanges.clear();
  }

  private loadIgnorePatterns(): (string | RegExp)[] {
    const ignorePath = path.join(this.options.dir, ".lainignore");
    if (!fs.existsSync(ignorePath)) return [];

    const content = fs.readFileSync(ignorePath, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((pattern) => new RegExp(pattern.replace(/\*/g, ".*")));
  }

  private emit(type: string, nodeId?: string, data?: unknown): void {
    this.options.onEvent?.({
      type: type as any,
      explorationId: this.options.explorationId,
      nodeId,
      data,
      timestamp: nowISO(),
    });
  }
}
