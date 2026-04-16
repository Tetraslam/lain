import React, { useState, useEffect, useCallback } from "react";
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

  const fetchDbs = useCallback(async () => {
    try {
      const res = await fetch("/api/explorations");
      setDbs(await res.json());
    } catch (err) { console.error(err); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchDbs(); }, [fetchDbs]);

  if (activeDb) {
    return (
      <ExplorationView
        dbFile={activeDb}
        onBack={() => { setActiveDb(null); fetchDbs(); }}
      />
    );
  }

  return (
    <div className="home">
      <div className="home-brand">
        <h1>lain</h1>
        <p>graph-based ideation engine</p>
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
          {dbs.map((db) =>
            db.explorations.map((exp) => (
              <button key={`${db.name}-${exp.id}`} className="exploration-card" onClick={() => setActiveDb(db.name)}>
                <span className="card-title">{exp.name}</span>
                <span className="card-meta">{exp.nodeCount} nodes · {exp.extension}</span>
              </button>
            ))
          )}
          <button className="exploration-card card-create" onClick={() => setShowCreate(true)}>
            <span className="card-title">New exploration →</span>
            <span className="card-meta">create</span>
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
