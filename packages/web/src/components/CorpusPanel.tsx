import React, { useState, useEffect, useCallback, useRef } from "react";

interface CorpusSource {
  id: string;
  name: string;
  kind: string;
  byteSize: number | null;
}

const KIND_GLYPH: Record<string, string> = {
  text: "≡", markdown: "≡", csv: "▦", json: "{}", pdf: "▤", image: "▣", url: "↗", binary: "▪",
};

function humanSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Right-rail panel listing the exploration's ingested source material, with
 * drag-and-drop to add more. Newly-added sources are immediately available to
 * agents on the next Extend.
 */
export function CorpusPanel({ dbFile }: { dbFile: string }) {
  const [sources, setSources] = useState<CorpusSource[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/corpus/${encodeURIComponent(dbFile)}`);
      if (res.ok) setSources((await res.json()).sources ?? []);
    } catch { /* non-critical */ }
  }, [dbFile]);

  useEffect(() => { refresh(); }, [refresh]);

  const upload = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("dbFile", dbFile);
      for (const f of list) form.append("files", f);
      await fetch("/api/corpus/upload", { method: "POST", body: form });
      await refresh();
    } finally {
      setUploading(false);
    }
  }, [dbFile, refresh]);

  return (
    <div className="context-section">
      <div className="context-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Corpus</span>
        <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>{sources.length}</span>
      </div>

      {sources.length > 0 && (
        <div className="corpus-list">
          {sources.map((s) => (
            <div key={s.id} className="corpus-source" title={`${s.kind} · ${humanSize(s.byteSize)}`}>
              <span className="corpus-glyph">{KIND_GLYPH[s.kind] ?? "▪"}</span>
              <span className="corpus-name">{s.name}</span>
              <span className="corpus-size">{humanSize(s.byteSize)}</span>
            </div>
          ))}
        </div>
      )}

      <div
        className={`corpus-drop${dragging ? " dragging" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files?.length) upload(e.dataTransfer.files); }}
        onClick={() => fileInputRef.current?.click()}
      >
        <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); }} />
        {uploading ? "ingesting…" : sources.length === 0 ? "drop source material to ground the agents" : "+ add more"}
      </div>
    </div>
  );
}
