import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState,
  type Node, type Edge, type NodeTypes,
  BackgroundVariant, Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Markdown from "react-markdown";
import { LainNode } from "./LainNode";

interface ExplorationData { exploration: any; nodes: any[]; crosslinks: any[]; }
const nodeTypes: NodeTypes = { lain: LainNode as any };

function buildFlowLayout(data: ExplorationData): { nodes: Node[]; edges: Edge[] } {
  const { nodes: lainNodes, crosslinks } = data;
  const childrenOf = new Map<string, any[]>();
  for (const n of lainNodes) { if (n.parentId) { const s = childrenOf.get(n.parentId) || []; s.push(n); childrenOf.set(n.parentId, s); } }
  for (const [, ch] of childrenOf) ch.sort((a: any, b: any) => a.branchIndex - b.branchIndex);
  const root = lainNodes.find((n: any) => !n.parentId);
  if (!root) return { nodes: [], edges: [] };
  const leafCount = new Map<string, number>();
  function countLeaves(id: string): number { const ch = childrenOf.get(id) || []; if (!ch.length) { leafCount.set(id, 1); return 1; } let t = 0; for (const c of ch) t += countLeaves(c.id); leafCount.set(id, t); return t; }
  countLeaves(root.id);
  const flowNodes: Node[] = [];
  function layout(node: any, aS: number, aE: number, d: number) {
    const a = (aS + aE) / 2, r = d * 250;
    flowNodes.push({ id: node.id, type: "lain", position: { x: Math.cos(a) * r, y: Math.sin(a) * r }, data: { title: node.title || node.id, depth: node.depth, status: node.status } });
    const ch = childrenOf.get(node.id) || []; if (!ch.length) return;
    const pL = leafCount.get(node.id) || 1; const arc = aE - aS; let cur = aS;
    for (const c of ch) { const cL = leafCount.get(c.id) || 1; const cA = arc * (cL / pL); layout(c, cur, cur + cA, d + 1); cur += cA; }
  }
  layout(root, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2, 0);
  const posMap = new Map(flowNodes.map((n) => [n.id, n.position]));
  function pickH(sId: string, tId: string) { const s = posMap.get(sId), t = posMap.get(tId); if (!s || !t) return { sourceHandle: "bottom", targetHandle: "top" }; const dx = t.x - s.x, dy = t.y - s.y; if (Math.abs(dy) > Math.abs(dx)) return dy > 0 ? { sourceHandle: "bottom", targetHandle: "top" } : { sourceHandle: "top-s", targetHandle: "bottom-t" }; return dx > 0 ? { sourceHandle: "right", targetHandle: "left-t" } : { sourceHandle: "left", targetHandle: "right-t" }; }
  const flowEdges: Edge[] = [];
  for (const n of lainNodes) { if (n.parentId) { const h = pickH(n.parentId, n.id); flowEdges.push({ id: `${n.parentId}-${n.id}`, source: n.parentId, target: n.id, ...h, type: "straight", style: { stroke: "#28283a", strokeWidth: 1.5 } }); } }
  for (const cl of crosslinks) { const h = pickH(cl.sourceId, cl.targetId); flowEdges.push({ id: `cl-${cl.sourceId}-${cl.targetId}`, source: cl.sourceId, target: cl.targetId, ...h, type: "straight", animated: true, style: { stroke: "#50506a", strokeWidth: 1, strokeDasharray: "6 4" } }); }
  return { nodes: flowNodes, edges: flowEdges };
}

export function ExplorationView({ dbFile, onBack }: { dbFile: string; onBack: () => void }) {
  const [data, setData] = useState<ExplorationData | null>(null);
  const [selectedId, setSelectedId] = useState<string>("root");
  const [showGraph, setShowGraph] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const contentRef = useRef<HTMLElement>(null);

  // Responsive: auto-collapse on narrow screens
  useEffect(() => {
    function onResize() {
      if (window.innerWidth < 900) setNavCollapsed(true);
    }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const fetchData = useCallback(async () => {
    const res = await fetch(`/api/exploration/${encodeURIComponent(dbFile)}`);
    const d = await res.json();
    setData(d);
    const layout = buildFlowLayout(d);
    setFlowNodes(layout.nodes);
    setFlowEdges(layout.edges);
  }, [dbFile]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const node = useMemo(() => data?.nodes.find((n: any) => n.id === selectedId), [data, selectedId]);
  const children = useMemo(() => data?.nodes.filter((n: any) => n.parentId === selectedId && n.status !== "pruned").sort((a: any, b: any) => a.branchIndex - b.branchIndex) || [], [data, selectedId]);
  const crosslinks = useMemo(() => data?.crosslinks.filter((cl: any) => cl.sourceId === selectedId || cl.targetId === selectedId) || [], [data, selectedId]);
  const ancestors = useMemo(() => {
    if (!data || !node) return [];
    const r: any[] = []; let c = node;
    while (c?.parentId) { const p = data.nodes.find((n: any) => n.id === c.parentId); if (!p) break; r.unshift(p); c = p; }
    return r;
  }, [data, node]);

  // Scroll to top when node changes
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [selectedId]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!data) return;
    function handleKey(e: KeyboardEvent) {
      if (!data) return;
      // Don't handle if user is typing in an input
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;

      const cur = data.nodes.find((n: any) => n.id === selectedId);
      if (!cur) return;

      // Navigation: arrow keys
      let target: string | null = null;
      if (e.key === "ArrowUp" && cur.parentId) target = cur.parentId;
      if (e.key === "ArrowDown") {
        const ch = data.nodes.filter((n: any) => n.parentId === selectedId && n.status !== "pruned").sort((a: any, b: any) => a.branchIndex - b.branchIndex);
        if (ch.length > 0) target = ch[0].id;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (cur.parentId) {
          const sibs = data.nodes.filter((n: any) => n.parentId === cur.parentId && n.status !== "pruned").sort((a: any, b: any) => a.branchIndex - b.branchIndex);
          const idx = sibs.findIndex((s: any) => s.id === selectedId);
          if (e.key === "ArrowRight" && idx < sibs.length - 1) target = sibs[idx + 1].id;
          if (e.key === "ArrowLeft" && idx > 0) target = sibs[idx - 1].id;
        }
      }
      if (target) { e.preventDefault(); setSelectedId(target); return; }

      // Shortcuts
      if (e.key === "g") { setShowGraph((v) => !v); return; }
      if (e.key === "b") { setNavCollapsed((v) => !v); return; }
      if (e.key === "e") { handleAction("extend"); return; }
      if (e.key === "r" && selectedId !== "root") { handleAction("redirect"); return; }
      if (e.key === "p" && selectedId !== "root") { handleAction("prune"); return; }
      if (e.key === "Escape") {
        if (showGraph) setShowGraph(false);
        else onBack();
        return;
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [data, selectedId, showGraph]);

  const handleAction = useCallback(async (action: string, nodeId?: string) => {
    const target = nodeId || selectedId;
    const body = JSON.stringify(action === "export" || action === "sync" ? { dbFile } : { dbFile, nodeId: target });
    await fetch(`/api/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    await fetchData();
  }, [dbFile, selectedId, fetchData]);

  if (!data || !node) return <div className="home" style={{ justifyContent: "center" }}><p className="home-loading">loading...</p></div>;

  const exp = data.exploration;
  const isNarrow = typeof window !== "undefined" && window.innerWidth < 1100;

  // Build nav tree
  const navItems: { id: string; title: string; depth: number; status: string }[] = [];
  function buildNav(nodeId: string, depth: number) {
    const n = data!.nodes.find((x: any) => x.id === nodeId);
    if (!n) return;
    navItems.push({ id: n.id, title: n.title || n.id, depth, status: n.status });
    const ch = data!.nodes.filter((x: any) => x.parentId === nodeId).sort((a: any, b: any) => a.branchIndex - b.branchIndex);
    for (const c of ch) buildNav(c.id, depth + 1);
  }
  const rootNode = data.nodes.find((n: any) => !n.parentId);
  if (rootNode) buildNav(rootNode.id, 0);

  return (
    <div className="exploration">
      <div className="topbar">
        <button className="topbar-back" onClick={onBack} title="Esc">← back</button>
        <button className="topbar-back" onClick={() => setNavCollapsed((v) => !v)} title="B" style={{ fontSize: 12 }}>
          {navCollapsed ? "☰" : "◀"}
        </button>
        <span className="topbar-title">{exp.name}</span>
        <div className="topbar-actions">
          <button className="btn btn-sm" onClick={() => setShowGraph(true)} title="G">Graph</button>
          <button className="btn btn-sm" onClick={() => handleAction("export")}>Export</button>
          <button className="btn btn-sm" onClick={() => handleAction("sync")}>Sync</button>
        </div>
      </div>

      <div className="columns">
        {/* Left: Tree nav (collapsible) */}
        {!navCollapsed && (
          <nav className="nav-panel">
            <div className="nav-section-title">Contents</div>
            {navItems.map((item) => (
              <button
                key={item.id}
                className={`nav-item depth-${Math.min(item.depth, 3)} ${item.id === selectedId ? "active" : ""} ${item.status === "pruned" ? "pruned" : ""}`}
                onClick={() => setSelectedId(item.id)}
              >
                {item.title.length > 38 ? item.title.slice(0, 37) + "…" : item.title}
              </button>
            ))}
          </nav>
        )}

        {/* Center: Content */}
        <main className="content-area" ref={contentRef}>
          <article>
            <div className="article-header">
              {ancestors.length > 0 && (
                <div className="article-breadcrumb">
                  {ancestors.map((a: any) => (
                    <React.Fragment key={a.id}>
                      <a href="#" onClick={(e) => { e.preventDefault(); setSelectedId(a.id); }}>{(a.title || a.id).slice(0, 25)}</a>
                      <span className="sep">›</span>
                    </React.Fragment>
                  ))}
                  <span>{(node.title || node.id).slice(0, 30)}</span>
                </div>
              )}

              <h1 className="article-title">{node.title || node.id}</h1>

              <div className="article-meta">
                <span><span className="meta-label">depth</span> <span className="meta-value">{node.depth}</span></span>
                <span><span className="meta-label">status</span> <span className={`meta-value status-${node.status}`}>{node.status}</span></span>
                {node.model && <span><span className="meta-label">model</span> <span className="meta-value">{node.model}</span></span>}
              </div>

              {node.planSummary && <div className="article-direction">{node.planSummary}</div>}
            </div>

            <div className="article-body">
              {node.content ? <Markdown>{node.content}</Markdown> : <p style={{ color: "var(--fg-muted)", fontStyle: "italic" }}>No content yet.</p>}
            </div>

            <div className="article-actions">
              <button className="btn btn-sm" onClick={() => handleAction("extend")} title="E">Extend</button>
              {node.id !== "root" && (
                <>
                  <button className="btn btn-sm" onClick={() => handleAction("redirect")} title="R">Redirect</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleAction("prune")} title="P">Prune</button>
                </>
              )}
            </div>

            {crosslinks.length > 0 && (
              <div className="article-section">
                <div className="article-section-title">Cross-links</div>
                {crosslinks.map((cl: any) => {
                  const otherId = cl.sourceId === selectedId ? cl.targetId : cl.sourceId;
                  const other = data.nodes.find((n: any) => n.id === otherId);
                  return (
                    <div key={`${cl.sourceId}-${cl.targetId}`} className="crosslink-item">
                      <a href="#" onClick={(e) => { e.preventDefault(); setSelectedId(otherId); }}>→ {other?.title || otherId}</a>
                      {cl.label && <span className="cl-label"> — {cl.label}</span>}
                    </div>
                  );
                })}
              </div>
            )}

            {children.length > 0 && (
              <div className="article-section">
                <div className="article-section-title">Children</div>
                {children.map((ch: any) => (
                  <div key={ch.id} className="child-item">
                    <span className="child-idx">{ch.branchIndex}.</span>
                    <a href="#" onClick={(e) => { e.preventDefault(); setSelectedId(ch.id); }}>{ch.title || ch.id}</a>
                  </div>
                ))}
              </div>
            )}

            {/* Keyboard shortcut hint */}
            <div style={{ marginTop: "3rem", paddingTop: "1rem", borderTop: "1px solid var(--border-subtle)", fontSize: 11, color: "var(--fg-muted)", letterSpacing: "0.02em" }}>
              ↑↓←→ navigate · <strong>e</strong> extend · <strong>r</strong> redirect · <strong>p</strong> prune · <strong>g</strong> graph · <strong>b</strong> toggle sidebar · <strong>esc</strong> back
            </div>
          </article>
        </main>

        {/* Right: Context (hidden on narrow) */}
        {!isNarrow && (
          <aside className="context-panel">
            <div className="context-section">
              <div className="context-title">Node</div>
              <div className="context-item"><span className="cl">id</span> <span className="cv">{node.id}</span></div>
              <div className="context-item"><span className="cl">branch</span> <span className="cv">{node.branchIndex}</span></div>
              <div className="context-item"><span className="cl">extension</span> <span className="cv">{exp.extension}</span></div>
              {node.provider && <div className="context-item"><span className="cl">provider</span> <span className="cv">{node.provider}</span></div>}
            </div>
            <div className="context-section">
              <div className="context-title">Exploration</div>
              <div className="context-item"><span className="cl">nodes</span> <span className="cv">{data.nodes.filter((n: any) => n.status !== "pruned").length}</span></div>
              <div className="context-item"><span className="cl">n</span> <span className="cv">{exp.n}</span></div>
              <div className="context-item"><span className="cl">m</span> <span className="cv">{exp.m}</span></div>
              <div className="context-item"><span className="cl">strategy</span> <span className="cv">{exp.strategy}</span></div>
            </div>
          </aside>
        )}
      </div>

      {/* Graph toggle */}
      <button className="graph-toggle" onClick={() => setShowGraph(!showGraph)}>{showGraph ? "Close graph" : "Graph ⌘G"}</button>

      {/* Graph overlay */}
      {showGraph && (
        <div className="graph-overlay">
          <button className="graph-close" onClick={() => setShowGraph(false)}>✕ Close</button>
          <ReactFlow
            nodes={flowNodes} edges={flowEdges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onNodeClick={(_e: any, n: any) => { setSelectedId(n.id); setShowGraph(false); }}
            nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false}
            fitView fitViewOptions={{ padding: 0.3 }} minZoom={0.05} maxZoom={2}
            defaultEdgeOptions={{ type: "straight" }} proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#1e1e28" />
            <Controls position="bottom-left" />
            <MiniMap
              nodeColor={(n: any) => n.data?.depth === 0 ? "#88b0f0" : n.data?.status === "pruned" ? "#e07070" : "#50506a"}
              maskColor="rgba(15, 15, 20, 0.85)" style={{ background: "#0f0f14", borderColor: "#28283a" }}
            />
          </ReactFlow>
        </div>
      )}
    </div>
  );
}
