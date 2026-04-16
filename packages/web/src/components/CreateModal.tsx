import React, { useState } from "react";

interface CreateModalProps {
  onClose: () => void;
  onCreated: (dbFile: string) => void;
}

export function CreateModal({ onClose, onCreated }: CreateModalProps) {
  const [seed, setSeed] = useState("");
  const [n, setN] = useState("3");
  const [m, setM] = useState("2");
  const [ext, setExt] = useState("freeform");
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState("");

  const handleCreate = async () => {
    if (!seed.trim()) return;
    setCreating(true);
    setStatus("Creating exploration...");

    try {
      const res = await fetch("/api/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seed,
          n: parseInt(n) || 3,
          m: parseInt(m) || 2,
          extension: ext,
        }),
      });

      // SSE stream
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let dbFile = "";
      let nodesGenerated = 0;

      if (reader) {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const eventStr of events) {
            const lines = eventStr.split("\n");
            let eventType = "";
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) eventType = line.slice(7);
              if (line.startsWith("data: ")) data = line.slice(6);
            }
            if (!eventType || !data) continue;

            try {
              const parsed = JSON.parse(data);
              if (eventType === "node:complete") {
                nodesGenerated++;
                const title = parsed.data?.title || "untitled";
                setStatus(`Generated ${nodesGenerated} nodes... latest: ${title.slice(0, 40)}`);
              }
              if (eventType === "complete") {
                dbFile = parsed.dbFile;
              }
              if (eventType === "error") {
                setStatus(`Error: ${parsed.message}`);
                setCreating(false);
                return;
              }
            } catch {}
          }
        }
      }

      if (dbFile) {
        onCreated(dbFile);
      } else {
        setStatus("Failed to create exploration");
        setCreating(false);
      }
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
      setCreating(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <div className="modal-title">New Exploration</div>

        <div className="form-group">
          <label className="form-label">Seed idea</label>
          <input
            className="form-input"
            placeholder="what if trees could talk..."
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            autoFocus
            disabled={creating}
            onKeyDown={(e) => { if (e.key === "Enter" && !creating) handleCreate(); }}
          />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Branches (n)</label>
            <input className="form-input" value={n} onChange={(e) => setN(e.target.value)} disabled={creating} />
          </div>
          <div className="form-group">
            <label className="form-label">Depth (m)</label>
            <input className="form-input" value={m} onChange={(e) => setM(e.target.value)} disabled={creating} />
          </div>
          <div className="form-group">
            <label className="form-label">Extension</label>
            <select className="form-input" value={ext} onChange={(e) => setExt(e.target.value)} disabled={creating}>
              <option value="freeform">freeform</option>
              <option value="worldbuilding">worldbuilding</option>
              <option value="debate">debate</option>
              <option value="research">research</option>
            </select>
          </div>
        </div>

        {status && (
          <div className="streaming-indicator">
            {creating && <div className="streaming-dot" />}
            {status}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={creating}>Cancel</button>
          <button className="btn btn-primary" onClick={handleCreate} disabled={creating || !seed.trim()}>
            {creating ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
