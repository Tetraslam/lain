import React, { useState, useRef, useCallback } from "react";

interface CreateModalProps {
  onClose: () => void;
  onCreated: (dbFile: string) => void;
}

interface Activity {
  id: number;
  kind: "plan" | "tool" | "node" | "corpus" | "info";
  text: string;
  node?: string;
}

const EXTENSIONS = [
  { value: "freeform", label: "Freeform", hint: "pure divergent thinking" },
  { value: "worldbuilding", label: "Worldbuilding", hint: "geography, cultures, magic — coins in-world names" },
  { value: "debate", label: "Debate", hint: "pro / con / steelman / critique" },
  { value: "research", label: "Research", hint: "citations & methodology" },
];

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let activityCounter = 0;

export function CreateModal({ onClose, onCreated }: CreateModalProps) {
  const [seed, setSeed] = useState("");
  const [n, setN] = useState("3");
  const [m, setM] = useState("2");
  const [ext, setExt] = useState("freeform");
  const [agentic, setAgentic] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [doneCount, setDoneCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const grounded = agentic || files.length > 0;

  const pushActivity = useCallback((a: Omit<Activity, "id">) => {
    setActivity((prev) => {
      const next = [...prev, { ...a, id: activityCounter++ }];
      return next.slice(-60);
    });
    requestAnimationFrame(() => {
      if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
    });
  }, []);

  const addFiles = useCallback((list: FileList | File[]) => {
    const incoming = Array.from(list);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...incoming.filter((f) => !seen.has(f.name + f.size))];
    });
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handleCreate = async () => {
    if (!seed.trim() || creating) return;
    setCreating(true);
    setActivity([]);
    setDoneCount(0);
    pushActivity({ kind: "info", text: grounded ? "Seeding agents with your material…" : "Beginning exploration…" });

    try {
      let res: Response;
      if (files.length > 0) {
        const form = new FormData();
        form.append("seed", seed);
        form.append("n", n);
        form.append("m", m);
        form.append("extension", ext);
        form.append("agentic", "true");
        for (const f of files) form.append("files", f);
        res = await fetch("/api/create", { method: "POST", body: form });
      } else {
        res = await fetch("/api/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seed, n: parseInt(n) || 3, m: parseInt(m) || 2, extension: ext, agentic: grounded }),
        });
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let dbFile = "";

      if (reader) {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const eventStr of events) {
            let eventType = "";
            let data = "";
            for (const line of eventStr.split("\n")) {
              if (line.startsWith("event: ")) eventType = line.slice(7);
              if (line.startsWith("data: ")) data = line.slice(6);
            }
            if (!eventType || !data) continue;
            let parsed: any;
            try { parsed = JSON.parse(data); } catch { continue; }

            switch (eventType) {
              case "corpus:ingested":
                pushActivity({ kind: "corpus", text: `Ingested ${parsed.count} source${parsed.count === 1 ? "" : "s"} into the corpus` });
                break;
              case "plan:complete": {
                const dirs: string[] = parsed.data?.directions ?? [];
                pushActivity({ kind: "plan", text: `Planned ${dirs.length} directions from ${parsed.nodeId}`, node: parsed.nodeId });
                break;
              }
              case "node:agent-step": {
                const step = parsed.data;
                if (step?.kind === "tool_call") {
                  pushActivity({ kind: "tool", text: TOOL_LABELS[step.name] ?? step.name, node: parsed.nodeId });
                }
                break;
              }
              case "node:complete":
                setDoneCount((c) => c + 1);
                pushActivity({ kind: "node", text: parsed.data?.title || "untitled", node: parsed.nodeId });
                break;
              case "complete":
                dbFile = parsed.dbFile;
                break;
              case "error":
                pushActivity({ kind: "info", text: `Error: ${parsed.message}` });
                setCreating(false);
                return;
            }
          }
        }
      }

      if (dbFile) onCreated(dbFile);
      else { pushActivity({ kind: "info", text: "Failed to create exploration" }); setCreating(false); }
    } catch (err: any) {
      pushActivity({ kind: "info", text: `Error: ${err.message}` });
      setCreating(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !creating) onClose(); }}>
      <div className="modal-content create-modal">
        <div className="modal-title">New exploration</div>

        {!creating ? (
          <>
            <div className="form-group">
              <label className="form-label">Seed idea</label>
              <textarea
                className="form-input create-seed"
                placeholder="what if cities were grown instead of built…"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                autoFocus
                rows={2}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleCreate(); }}
              />
            </div>

            <div className="form-row">
              <div className="form-group" style={{ flex: "0 0 70px" }}>
                <label className="form-label">Branches</label>
                <input className="form-input" value={n} onChange={(e) => setN(e.target.value)} />
              </div>
              <div className="form-group" style={{ flex: "0 0 70px" }}>
                <label className="form-label">Depth</label>
                <input className="form-input" value={m} onChange={(e) => setM(e.target.value)} />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Lens</label>
                <select className="form-input" value={ext} onChange={(e) => setExt(e.target.value)}>
                  {EXTENSIONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                </select>
              </div>
            </div>
            <div className="lens-hint">{EXTENSIONS.find((x) => x.value === ext)?.hint}</div>

            {/* Corpus drop zone */}
            <div className="form-group">
              <label className="form-label">Source material — ground the agents in your world</label>
              <div
                className={`drop-zone${dragging ? " dragging" : ""}${files.length ? " has-files" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => { if (e.target.files) addFiles(e.target.files); }}
                />
                {files.length === 0 ? (
                  <span className="drop-hint">drop PDFs, notes, CSVs, images… or click to browse</span>
                ) : (
                  <div className="file-chips">
                    {files.map((f, i) => (
                      <span key={f.name + i} className="file-chip">
                        {f.name}<span className="file-size">{humanSize(f.size)}</span>
                        <button
                          className="chip-x"
                          onClick={(e) => { e.stopPropagation(); setFiles((prev) => prev.filter((_, j) => j !== i)); }}
                        >×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <label className={`agentic-toggle${grounded ? " on" : ""}`} onClick={() => files.length === 0 && setAgentic(!agentic)}>
              <span className={`toggle-switch${grounded ? " on" : ""}`}><span className="toggle-knob" /></span>
              <span className="toggle-label">
                <strong>Agentic mode</strong>
                <em>{grounded ? "nodes research the graph + your corpus, and link across branches" : "one-shot generation (faster, less grounded)"}</em>
              </span>
              {files.length > 0 && <span className="toggle-forced">on — corpus attached</span>}
            </label>

            <div className="modal-actions">
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={!seed.trim()}>
                Explore {grounded ? "↬" : "→"}
              </button>
            </div>
          </>
        ) : (
          <div className="thinking">
            <div className="thinking-head">
              <div className="streaming-dot" />
              <span>{doneCount > 0 ? `${doneCount} nodes woven` : "thinking"}</span>
            </div>
            <div className="thinking-feed" ref={feedRef}>
              {activity.map((a) => (
                <div key={a.id} className={`feed-line feed-${a.kind}`}>
                  {a.node && <span className="feed-tag">{a.node}</span>}
                  <span className="feed-text">{a.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  outline: "scanning the whole graph",
  read_node: "reading a related branch",
  search_nodes: "searching other nodes",
  search_corpus: "consulting your source material",
  list_corpus_sources: "reviewing available sources",
  link_to_node: "linking to a related branch",
  coin_names: "coining in-world names",
  submit_node: "writing the node",
};
