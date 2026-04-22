import React, { useState, useEffect, useCallback, useRef } from "react";
import { ExplorationView } from "./components/ExplorationView";
import { CreateModal } from "./components/CreateModal";
import "./styles.css";

interface DbInfo {
  path: string;
  name: string;
  explorations: { id: string; name: string; seed: string; n: number; m: number; extension: string; nodeCount: number }[];
}

export function App() {
  const [dbs, setDbs] = useState<DbInfo[]>([]);
  const [activeDb, setActiveDb] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const fetchDbs = useCallback(async () => {
    try {
      const res = await fetch("/api/explorations");
      setDbs(await res.json());
    } catch (err) { console.error(err); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchDbs(); }, [fetchDbs]);

  // Keyboard navigation on home screen
  useEffect(() => {
    if (activeDb || showCreate) return;
    const allItems = dbs.flatMap((db) => db.explorations.map((exp) => ({ db, exp })));
    const totalItems = allItems.length + 1; // +1 for "New exploration"

    function handleKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, totalItems - 1));
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (selectedIdx < allItems.length) {
          setActiveDb(allItems[selectedIdx].db.name);
        } else {
          setShowCreate(true);
        }
      } else if (e.key === "n") {
        setShowCreate(true);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activeDb, showCreate, dbs, selectedIdx]);

  if (activeDb) {
    return (
      <ExplorationView
        dbFile={activeDb}
        onBack={() => { setActiveDb(null); fetchDbs(); }}
      />
    );
  }

  const allItems = dbs.flatMap((db) => db.explorations.map((exp) => ({ db, exp })));

  return (
    <div className="home">
      <div className="home-brand">
        <h1>lain</h1>
        <p>everything is connected</p>
      </div>

      {loading ? (
        <p className="home-loading">loading...</p>
      ) : dbs.length === 0 ? (
        <div className="home-empty">
          <p>No explorations found in the current directory.</p>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            Create your first exploration
          </button>
        </div>
      ) : (
        <div className="home-list">
          {allItems.map((item, i) => (
            <button
              key={`${item.db.name}-${item.exp.id}`}
              className={`exploration-card${i === selectedIdx ? " selected" : ""}`}
              onClick={() => setActiveDb(item.db.name)}
            >
              <span className="card-title">{item.exp.name}</span>
              <span className="card-meta">{item.exp.nodeCount} nodes · {item.exp.extension}</span>
            </button>
          ))}
          <button
            className={`exploration-card card-create${selectedIdx === allItems.length ? " selected" : ""}`}
            onClick={() => setShowCreate(true)}
          >
            <span className="card-title">New exploration →</span>
            <span className="card-meta">n to create · j/k to navigate · enter to open</span>
          </button>
        </div>
      )}

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreated={(dbFile: string) => { setShowCreate(false); setActiveDb(dbFile); fetchDbs(); }}
        />
      )}
    </div>
  );
}
