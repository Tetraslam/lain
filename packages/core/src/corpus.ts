// Corpus — the substrate's memory. Users drop in arbitrary source material
// (text, markdown, csv, json, images, …) and agents retrieve from it while
// expanding nodes. This is what lets "dump a folder of worldbuilding files and
// something extraordinary emerges" actually work.
//
// Text sources are extracted and chunked for BM25 retrieval. Images are stored
// whole (base64) so they can be handed directly to a multimodal model.
//
// Retrieval is a self-contained lexical BM25 implementation: deterministic,
// dependency-free, and offline-testable. Embedding-based retrieval is a
// future drop-in (the `search` signature is stable).

import * as fs from "fs";
import * as path from "path";
import { Storage } from "./storage.js";
import type {
  CorpusChunk,
  CorpusHit,
  CorpusKind,
  CorpusSource,
  ImageFormatLike,
} from "@lain/shared";
import { generateId, nowISO } from "@lain/shared";

const IMAGE_EXTS: Record<string, ImageFormatLike> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".gif": "gif",
  ".webp": "webp",
};

const TEXT_KIND_BY_EXT: Record<string, CorpusKind> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".csv": "csv",
  ".tsv": "csv",
  ".json": "json",
  ".txt": "text",
  ".text": "text",
  ".log": "text",
};

export interface IngestOptions {
  /** Target chunk size in characters. Default 1200. */
  chunkSize?: number;
  /** Overlap between consecutive chunks in characters. Default 150. */
  overlap?: number;
}

export interface IngestResult {
  source: CorpusSource;
  chunkCount: number;
}

export class Corpus {
  private storage: Storage;
  private ownsStorage: boolean;

  constructor(dbPathOrStorage: string | Storage) {
    if (typeof dbPathOrStorage === "string") {
      this.storage = new Storage(dbPathOrStorage);
      this.ownsStorage = true;
    } else {
      this.storage = dbPathOrStorage;
      this.ownsStorage = false;
    }
  }

  close(): void {
    if (this.ownsStorage) this.storage.close();
  }

  getStorage(): Storage {
    return this.storage;
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  /** Ingest a single file from disk, detecting its kind by extension. */
  async ingestFile(
    explorationId: string,
    filePath: string,
    opts: IngestOptions = {}
  ): Promise<IngestResult> {
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);
    const stat = fs.statSync(filePath);

    if (IMAGE_EXTS[ext]) {
      const data = fs.readFileSync(filePath).toString("base64");
      return this.ingestImage(explorationId, {
        name,
        format: IMAGE_EXTS[ext],
        data,
        byteSize: stat.size,
      });
    }

    if (ext === ".pdf") {
      const text = await extractPdfText(filePath);
      return this.ingestText(explorationId, {
        name,
        kind: "pdf",
        text,
        byteSize: stat.size,
        meta: { path: filePath },
        ...opts,
      });
    }

    const kind = TEXT_KIND_BY_EXT[ext] ?? "text";
    const raw = fs.readFileSync(filePath, "utf-8");
    const text = kind === "csv" ? csvToText(raw) : raw;
    return this.ingestText(explorationId, {
      name,
      kind,
      text,
      byteSize: stat.size,
      meta: { path: filePath },
      ...opts,
    });
  }

  /** Ingest every supported file in a directory (recursively). */
  async ingestDirectory(
    explorationId: string,
    dir: string,
    opts: IngestOptions = {}
  ): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    const walk = (d: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else out.push(full);
      }
      return out;
    };
    for (const file of walk(dir)) {
      const ext = path.extname(file).toLowerCase();
      if (IMAGE_EXTS[ext] || TEXT_KIND_BY_EXT[ext] || ext === ".pdf") {
        results.push(await this.ingestFile(explorationId, file, opts));
      }
    }
    return results;
  }

  /** Ingest raw text (e.g. pasted content or a URL fetch). */
  ingestText(
    explorationId: string,
    args: {
      name: string;
      kind?: CorpusKind;
      text: string;
      byteSize?: number;
      mime?: string;
      meta?: Record<string, unknown>;
    } & IngestOptions
  ): IngestResult {
    const source: CorpusSource = {
      id: generateId(),
      explorationId,
      name: args.name,
      kind: args.kind ?? "text",
      mime: args.mime ?? null,
      byteSize: args.byteSize ?? args.text.length,
      data: null,
      imageFormat: null,
      meta: args.meta ?? null,
      createdAt: nowISO(),
    };
    this.storage.createCorpusSource(source);

    const pieces = chunkText(args.text, args.chunkSize ?? 1200, args.overlap ?? 150);
    const chunks: CorpusChunk[] = pieces.map((text, seq) => ({
      id: generateId(),
      sourceId: source.id,
      explorationId,
      seq,
      text,
      tokenEstimate: Math.ceil(text.length / 4),
      createdAt: nowISO(),
    }));
    if (chunks.length > 0) this.storage.createCorpusChunks(chunks);

    return { source, chunkCount: chunks.length };
  }

  /** Ingest an image (stored whole for multimodal use). */
  ingestImage(
    explorationId: string,
    args: { name: string; format: ImageFormatLike; data: string; byteSize?: number; meta?: Record<string, unknown> }
  ): IngestResult {
    const source: CorpusSource = {
      id: generateId(),
      explorationId,
      name: args.name,
      kind: "image",
      mime: `image/${args.format}`,
      byteSize: args.byteSize ?? Math.floor((args.data.length * 3) / 4),
      data: args.data,
      imageFormat: args.format,
      meta: args.meta ?? null,
      createdAt: nowISO(),
    };
    this.storage.createCorpusSource(source);
    // Images get a single descriptive chunk so they're discoverable by name.
    this.storage.createCorpusChunks([
      {
        id: generateId(),
        sourceId: source.id,
        explorationId,
        seq: 0,
        text: `[image] ${args.name}`,
        tokenEstimate: 0,
        createdAt: nowISO(),
      },
    ]);
    return { source, chunkCount: 1 };
  }

  // -------------------------------------------------------------------------
  // Retrieval
  // -------------------------------------------------------------------------

  listSources(explorationId: string): CorpusSource[] {
    return this.storage.getCorpusSources(explorationId);
  }

  getImageSources(explorationId: string): CorpusSource[] {
    return this.storage.getCorpusSources(explorationId).filter((s) => s.kind === "image");
  }

  isEmpty(explorationId: string): boolean {
    return this.storage.getCorpusSources(explorationId).length === 0;
  }

  /** BM25 search across all text chunks in an exploration. */
  search(explorationId: string, query: string, limit = 6): CorpusHit[] {
    const chunks = this.storage.getCorpusChunks(explorationId);
    if (chunks.length === 0) return [];

    const sourceById = new Map(
      this.storage.getCorpusSources(explorationId).map((s) => [s.id, s])
    );

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    // Precompute document frequencies and lengths.
    const docTokens = chunks.map((c) => tokenize(c.text));
    const avgLen = docTokens.reduce((a, t) => a + t.length, 0) / docTokens.length || 1;
    const df = new Map<string, number>();
    for (const tokens of docTokens) {
      for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
    }

    const N = chunks.length;
    const k1 = 1.5;
    const b = 0.75;

    const scored = chunks.map((chunk, i) => {
      const tokens = docTokens[i];
      const len = tokens.length || 1;
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

      let score = 0;
      for (const term of queryTerms) {
        const f = tf.get(term);
        if (!f) continue;
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (len / avgLen))));
      }
      const src = sourceById.get(chunk.sourceId);
      return {
        chunk,
        sourceName: src?.name ?? chunk.sourceId,
        sourceKind: src?.kind ?? ("text" as CorpusKind),
        score,
      } satisfies CorpusHit;
    });

    return scored
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Text processing helpers
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  "a an the of to in on for and or but is are was were be been being this that these those it its as at by with from into".split(
    " "
  )
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t)
  );
}

/**
 * Split text into overlapping chunks, preferring paragraph then sentence
 * boundaries so chunks stay semantically coherent.
 */
export function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= chunkSize) return [clean];

  const paragraphs = clean.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const para of paragraphs) {
    if (para.length > chunkSize) {
      // Paragraph itself too big — split on sentence boundaries.
      flush();
      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (current.length + s.length + 1 > chunkSize) flush();
        current += (current ? " " : "") + s;
      }
      flush();
      continue;
    }
    if (current.length + para.length + 2 > chunkSize) flush();
    current += (current ? "\n\n" : "") + para;
  }
  flush();

  // Apply overlap by prefixing each chunk (after the first) with the tail of
  // the previous chunk, improving recall across boundaries.
  if (overlap > 0 && chunks.length > 1) {
    return chunks.map((c, i) => {
      if (i === 0) return c;
      const prevTail = chunks[i - 1].slice(-overlap);
      return `${prevTail}\n${c}`;
    });
  }
  return chunks;
}

/** Render CSV into a compact "header: value" text form that retrieves well. */
function csvToText(raw: string): string {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return raw;
  const header = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1, 5000); // cap for safety
  const out: string[] = [`Columns: ${header.join(", ")}`];
  for (const line of rows) {
    const cells = line.split(",");
    const pairs = header.map((h, i) => `${h}: ${(cells[i] ?? "").trim()}`);
    out.push(pairs.join(" | "));
  }
  return out.join("\n");
}

/**
 * Extract text from a PDF using `unpdf` (pure-JS, no native deps, Bun-friendly).
 * Falls back to a clear placeholder if extraction yields nothing.
 */
async function extractPdfText(filePath: string): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const buffer = new Uint8Array(fs.readFileSync(filePath));
    const pdf = await getDocumentProxy(buffer);
    const { text } = await extractText(pdf, { mergePages: true });
    const joined = Array.isArray(text) ? text.join("\n\n") : text;
    if (joined && joined.trim()) return joined;
  } catch (err) {
    return `[PDF: ${path.basename(filePath)} — extraction failed: ${err instanceof Error ? err.message : String(err)}]`;
  }
  return `[PDF: ${path.basename(filePath)} — no extractable text (likely scanned images).]`;
}
