import React, { useState, useEffect, useCallback } from "react";
import { ExplorationView } from "./components/ExplorationView";
import { Home } from "./components/Home";
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
      const data = await res.json();
      setDbs(data);
    } catch (err) {
      console.error("Failed to fetch explorations:", err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchDbs(); }, [fetchDbs]);

  // If we have an active exploration, show it
  if (activeDb) {
    return (
      <ExplorationView
        dbFile={activeDb}
        onBack={() => { setActiveDb(null); fetchDbs(); }}
      />
    );
  }

  return (
    <div className="home-container">
      <header className="home-header">
        <h1 className="home-title">lain</h1>
        <p className="home-subtitle">graph-based ideation engine</p>
      </header>

      <main className="home-main">
        {loading ? (
          <p className="home-loading">Loading explorations...</p>
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
                <button
                  key={`${db.name}-${exp.id}`}
                  className="exploration-card"
                  onClick={() => setActiveDb(db.name)}
                >
                  <div className="card-title">{exp.name}</div>
                  <div className="card-meta">
                    {exp.nodeCount} nodes · n={exp.n} m={exp.m} · {exp.extension} · {db.name}
                  </div>
                </button>
              ))
            )}
            <button className="exploration-card card-create" onClick={() => setShowCreate(true)}>
              <div className="card-title">✦ Create new exploration</div>
              <div className="card-meta">Start a new idea graph from scratch</div>
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreated={(dbFile) => {
            setShowCreate(false);
            setActiveDb(dbFile);
            fetchDbs();
          }}
        />
      )}
    </div>
  );
}
