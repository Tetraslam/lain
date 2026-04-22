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

interface ExplorationData { exploration: any; nodes: any[]; crosslinks: any[]; nodeAnnotations?: Record<string, any[]>; }
const nodeTypes: NodeTypes = { lain: LainNode as any };

function buildFlowLayout(data: ExplorationData): { nodes: Node[]; edges: Edge[] } {
  const { nodes: lainNodes, crosslinks } = data;

  // Build parent→children map
  const childrenOf = new Map<string, any[]>();
  for (const n of lainNodes) {
    if (n.parentId) {
      const siblings = childrenOf.get(n.parentId) || [];
      siblings.push(n);
      childrenOf.set(n.parentId, siblings);
    }
  }
  for (const [, children] of childrenOf) {
    children.sort((a: any, b: any) => a.branchIndex - b.branchIndex);
  }

  const root = lainNodes.find((n: any) => !n.parentId);
  if (!root) return { nodes: [], edges: [] };

  // Count leaf descendants for proportional angle allocation
  const leafCount = new Map<string, number>();
  function countLeaves(id: string): number {
    const children = childrenOf.get(id) || [];
    if (!children.length) {
      leafCount.set(id, 1);
      return 1;
    }
    let total = 0;
    for (const child of children) total += countLeaves(child.id);
    leafCount.set(id, total);
    return total;
  }
  countLeaves(root.id);

  // Radial layout: place nodes in concentric rings
  const RING_SPACING = 250;
  const flowNodes: Node[] = [];

  function layoutNode(node: any, angleStart: number, angleEnd: number, depth: number) {
    const angle = (angleStart + angleEnd) / 2;
    const radius = depth * RING_SPACING;

    flowNodes.push({
      id: node.id,
      type: "lain",
      position: { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius },
      data: { title: node.title || node.id, depth: node.depth, status: node.status },
    });

    const children = childrenOf.get(node.id) || [];
    if (!children.length) return;

    const parentLeaves = leafCount.get(node.id) || 1;
    const arcSpan = angleEnd - angleStart;
    let currentAngle = angleStart;

    for (const child of children) {
      const childLeaves = leafCount.get(child.id) || 1;
      const childArc = arcSpan * (childLeaves / parentLeaves);
      layoutNode(child, currentAngle, currentAngle + childArc, depth + 1);
      currentAngle += childArc;
    }
  }

  layoutNode(root, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2, 0);

  // Build edge routing: determine which handle to use based on relative positions
  const posMap = new Map(flowNodes.map((n) => [n.id, n.position]));

  function pickHandles(sourceId: string, targetId: string) {
    const sourcePos = posMap.get(sourceId);
    const targetPos = posMap.get(targetId);
    if (!sourcePos || !targetPos) return { sourceHandle: "bottom", targetHandle: "top" };

    const dx = targetPos.x - sourcePos.x;
    const dy = targetPos.y - sourcePos.y;

    if (Math.abs(dy) > Math.abs(dx)) {
      return dy > 0
        ? { sourceHandle: "bottom", targetHandle: "top" }
        : { sourceHandle: "top-s", targetHandle: "bottom-t" };
    }
    return dx > 0
      ? { sourceHandle: "right", targetHandle: "left-t" }
      : { sourceHandle: "left", targetHandle: "right-t" };
  }

  // Build edges: tree edges + crosslink edges
  const flowEdges: Edge[] = [];

  for (const n of lainNodes) {
    if (n.parentId) {
      const handles = pickHandles(n.parentId, n.id);
      flowEdges.push({
        id: `${n.parentId}-${n.id}`,
        source: n.parentId,
        target: n.id,
        ...handles,
        type: "straight",
        style: { stroke: "#28283a", strokeWidth: 1.5 },
      });
    }
  }

  for (const cl of crosslinks) {
    const handles = pickHandles(cl.sourceId, cl.targetId);
    flowEdges.push({
      id: `cl-${cl.sourceId}-${cl.targetId}`,
      source: cl.sourceId,
      target: cl.targetId,
      ...handles,
      type: "straight",
      animated: true,
      style: { stroke: "#50506a", strokeWidth: 1, strokeDasharray: "6 4" },
    });
  }

  return { nodes: flowNodes, edges: flowEdges };
}

export function ExplorationView({ dbFile, onBack }: { dbFile: string; onBack: () => void }) {
  const [data, setData] = useState<ExplorationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>("root");
  const [showGraph, setShowGraph] = useState(false);
  const [showSynthesis, setShowSynthesis] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [syntheses, setSyntheses] = useState<any[]>([]);
  const [synthesizing, setSynthesizing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null); // "extend" | "redirect" | "prune" | null
  const [confirmAction, setConfirmAction] = useState<{ message: string; action: () => void } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
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
    try {
      const res = await fetch(`/api/exploration/${encodeURIComponent(dbFile)}`);
      if (!res.ok) { setError(`Failed to load exploration (${res.status})`); return; }
      const d = await res.json();
      setData(d);
      setError(null);
      const layout = buildFlowLayout(d);
      setFlowNodes(layout.nodes);
      setFlowEdges(layout.edges);
    } catch (err: any) {
      setError(`Connection failed: ${err.message}`);
    }
  }, [dbFile]);

  const fetchSyntheses = useCallback(async () => {
    try {
      const res = await fetch(`/api/syntheses/${encodeURIComponent(dbFile)}`);
      if (res.ok) setSyntheses(await res.json());
    } catch { /* non-critical */ }
  }, [dbFile]);

  useEffect(() => { fetchData(); fetchSyntheses(); }, [fetchData, fetchSyntheses]);

  const handleSynthesize = useCallback(async () => {
    setSynthesizing(true);
    setShowSynthesis(true);
    try {
      const res = await fetch("/api/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dbFile }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        setError(`Synthesis failed: ${err.error}`);
      } else {
        await fetchSyntheses();
        await fetchData();
      }
    } catch (err: any) {
      setError(`Synthesis failed: ${err.message}`);
    } finally {
      setSynthesizing(false);
    }
  }, [dbFile, fetchSyntheses, fetchData]);

  const [mergePreview, setMergePreview] = useState<{ annotationId: string; synthesisId: string; preview: any } | null>(null);

  const handleMerge = useCallback(async (synthesisId: string, annotationId?: string, dismiss?: boolean, applyPreview?: any) => {
    try {
      const res = await fetch("/api/merge-synthesis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dbFile, synthesisId, annotationId, dismiss, preview: applyPreview }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        setError(`Merge failed: ${err.error}`);
        return;
      }
      const result = await res.json();
      if (result.action === "preview") {
        // Show preview to user for confirmation
        setMergePreview({ annotationId: annotationId!, synthesisId, preview: result.preview });
        return;
      }
      // Success — refresh data
      setMergePreview(null);
      await fetchSyntheses();
      await fetchData();
    } catch (err: any) {
      setError(`Merge failed: ${err.message}`);
    }
  }, [dbFile, fetchSyntheses, fetchData]);

  const node = useMemo(() => data?.nodes.find((n: any) => n.id === selectedId), [data, selectedId]);
  const children = useMemo(() => data?.nodes.filter((n: any) => n.parentId === selectedId && n.status !== "pruned").sort((a: any, b: any) => a.branchIndex - b.branchIndex) || [], [data, selectedId]);
  const crosslinks = useMemo(() => data?.crosslinks.filter((cl: any) => cl.sourceId === selectedId || cl.targetId === selectedId) || [], [data, selectedId]);
  const ancestors = useMemo(() => {
    if (!data || !node) return [];
    const r: any[] = []; let c = node;
    while (c?.parentId) { const p = data.nodes.find((n: any) => n.id === c.parentId); if (!p) break; r.unshift(p); c = p; }
    return r;
  }, [data, node]);

  // Build nav tree (document order) — used for navigation and rendering
  const navItems = useMemo(() => {
    if (!data) return [];
    const items: { id: string; title: string; depth: number; status: string }[] = [];
    function buildNav(nodeId: string, depth: number) {
      const n = data!.nodes.find((x: any) => x.id === nodeId);
      if (!n) return;
      items.push({ id: n.id, title: n.title || n.id, depth, status: n.status });
      const ch = data!.nodes.filter((x: any) => x.parentId === nodeId).sort((a: any, b: any) => a.branchIndex - b.branchIndex);
      for (const c of ch) buildNav(c.id, depth + 1);
    }
    const rootNode = data.nodes.find((n: any) => !n.parentId);
    if (rootNode) buildNav(rootNode.id, 0);
    return items;
  }, [data]);

  // Scroll to top when node changes
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [selectedId]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!data || !navItems.length) return;
    function handleKey(e: KeyboardEvent) {
      if (!data) return;
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;

      let target: string | null = null;

      // Up/Down/j/k: traverse in document order (same as nav panel)
      if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "j" || e.key === "k") {
        const currentIdx = navItems.findIndex((item) => item.id === selectedId);
        if (currentIdx === -1) return;
        if ((e.key === "ArrowUp" || e.key === "k") && currentIdx > 0) target = navItems[currentIdx - 1].id;
        if ((e.key === "ArrowDown" || e.key === "j") && currentIdx < navItems.length - 1) target = navItems[currentIdx + 1].id;
      }

      // Left/Right/h/l: siblings
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "h" || e.key === "l") {
        const cur = data.nodes.find((n: any) => n.id === selectedId);
        if (cur?.parentId) {
          const sibs = data.nodes.filter((n: any) => n.parentId === cur.parentId && n.status !== "pruned").sort((a: any, b: any) => a.branchIndex - b.branchIndex);
          const idx = sibs.findIndex((s: any) => s.id === selectedId);
          if ((e.key === "ArrowRight" || e.key === "l") && idx < sibs.length - 1) target = sibs[idx + 1].id;
          if ((e.key === "ArrowLeft" || e.key === "h") && idx > 0) target = sibs[idx - 1].id;
        }
      }

      if (target) { e.preventDefault(); setSelectedId(target); return; }

      // Shortcuts
      if (e.key === "g") { setShowGraph((v: boolean) => !v); return; }
      if (e.key === "b") { setNavCollapsed((v: boolean) => !v); return; }
      if (e.key === "s") { setShowSynthesis((v: boolean) => !v); return; }
      if (e.key === "?") { setShowHelp((v: boolean) => !v); return; }
      if (e.key === "i" && selectedId !== "root") { setEditing(true); setEditContent(node?.content || ""); return; }
      if (e.key === "e" && !actionLoading) { handleAction("extend"); return; }
      if (e.key === "r" && selectedId !== "root" && !actionLoading) { handleAction("redirect"); return; }
      if (e.key === "p" && selectedId !== "root" && !actionLoading) { handleAction("prune"); return; }
      if (e.key === "Escape") {
        if (confirmAction) { setConfirmAction(null); return; }
        if (editing) { setEditing(false); return; }
        if (showHelp) { setShowHelp(false); return; }
        if (showGraph) setShowGraph(false);
        else onBack();
        return;
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [data, selectedId, showGraph, navItems]);

  const handleAction = useCallback(async (action: string, nodeId?: string) => {
    const target = nodeId || selectedId;

    // Destructive actions need confirmation
    if (action === "prune" && !confirmAction) {
      const nodeName = data?.nodes.find((n: any) => n.id === target)?.title || target;
      setConfirmAction({
        message: `Prune "${nodeName}" and all descendants?`,
        action: () => handleAction("prune", target),
      });
      return;
    }
    if (action === "redirect" && !confirmAction) {
      const nodeName = data?.nodes.find((n: any) => n.id === target)?.title || target;
      setConfirmAction({
        message: `Regenerate "${nodeName}"? Content will be overwritten.`,
        action: () => handleAction("redirect", target),
      });
      return;
    }

    setConfirmAction(null);
    setActionLoading(action);
    try {
      const body = JSON.stringify(action === "export" || action === "sync" ? { dbFile } : { dbFile, nodeId: target });
      const res = await fetch(`/api/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        setError(`${action} failed: ${err.error}`);
      } else {
        // After prune, navigate to sibling or parent
        if (action === "prune" && data) {
          const prunedNode = data.nodes.find((n: any) => n.id === target);
          if (prunedNode) {
            const siblings = data.nodes.filter((n: any) => n.parentId === prunedNode.parentId && n.id !== target && n.status !== "pruned");
            const newTarget = siblings[0]?.id || prunedNode.parentId || "root";
            setSelectedId(newTarget);
          }
        }
        await fetchData();
      }
    } catch (err: any) {
      setError(`${action} failed: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  }, [dbFile, selectedId, fetchData, data, confirmAction]);

  const handleEdit = useCallback(async () => {
    if (!node) return;
    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dbFile, nodeId: node.id, content: editContent }),
      });
      if (res.ok) {
        setEditing(false);
        await fetchData();
      } else {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        setError(`Save failed: ${err.error}`);
      }
    } catch (err: any) {
      setError(`Save failed: ${err.message}`);
    }
  }, [dbFile, node, editContent, fetchData]);

  if (error && !data) return <div className="home" style={{ justifyContent: "center" }}><p className="home-loading" style={{ color: "var(--red)" }}>{error}</p><button className="btn" onClick={() => { setError(null); fetchData(); }} style={{ marginTop: "1rem" }}>Retry</button></div>;
  if (!data || !node) return <div className="home" style={{ justifyContent: "center" }}><p className="home-loading">loading...</p></div>;

  const exp = data.exploration;
  const isNarrow = typeof window !== "undefined" && window.innerWidth < 1100;

  return (
    <div className="exploration">
      <div className="topbar">
        <button className="topbar-back" onClick={onBack} title="Esc">← back</button>
        <button className="topbar-back" onClick={() => setNavCollapsed((v) => !v)} title="B" style={{ fontSize: 12 }}>
          {navCollapsed ? "☰" : "◀"}
        </button>
        <span className="topbar-title">{exp.name}</span>
        <div className="topbar-actions">
          <button className="btn btn-sm" onClick={() => setShowSynthesis((v) => !v)} title="S">
            {showSynthesis ? "Hide Synthesis" : "Synthesis"}
          </button>
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
              {editing ? (
                <div className="edit-area">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="edit-textarea"
                    autoFocus
                  />
                  <div className="edit-actions">
                    <button className="btn btn-sm" onClick={handleEdit}>Save</button>
                    <button className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
                  </div>
                </div>
              ) : (
                node.content ? <Markdown>{node.content}</Markdown> : <p style={{ color: "var(--fg-muted)", fontStyle: "italic" }}>No content yet.</p>
              )}
            </div>

            {/* Error banner */}
            {error && <div className="error-banner" onClick={() => setError(null)}>{error} <span style={{ opacity: 0.6 }}>· click to dismiss</span></div>}

            {/* Confirmation dialog */}
            {confirmAction && (
              <div className="confirm-banner">
                <span>{confirmAction.message}</span>
                <button className="btn btn-sm btn-danger" onClick={() => confirmAction.action()}>Confirm</button>
                <button className="btn btn-sm" onClick={() => setConfirmAction(null)}>Cancel</button>
              </div>
            )}

            <div className="article-actions">
              <button className="btn btn-sm" onClick={() => handleAction("extend")} disabled={!!actionLoading} title="E">
                {actionLoading === "extend" ? "Extending..." : "Extend"}
              </button>
              {node.id !== "root" && (
                <>
                  <button className="btn btn-sm" onClick={() => handleAction("redirect")} disabled={!!actionLoading} title="R">
                    {actionLoading === "redirect" ? "Regenerating..." : "Redirect"}
                  </button>
                  <button className="btn btn-sm" onClick={() => { setEditing(true); setEditContent(node.content || ""); }} title="I">Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleAction("prune")} disabled={!!actionLoading} title="P">
                    {actionLoading === "prune" ? "Pruning..." : "Prune"}
                  </button>
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

            {/* Node annotations (persistent notes) */}
            {data.nodeAnnotations && data.nodeAnnotations[selectedId] && (
              <div className="article-section">
                <div className="article-section-title">Notes</div>
                {data.nodeAnnotations[selectedId].map((na: any) => (
                  <div key={na.id} className="note-item">
                    <span className="note-icon">◆</span>
                    <span className="note-content">{na.content}</span>
                  </div>
                ))}
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
              j/k or ↑↓ navigate · h/l or ←→ siblings · <strong>e</strong> extend · <strong>r</strong> redirect · <strong>i</strong> edit · <strong>p</strong> prune · <strong>g</strong> graph · <strong>s</strong> synthesis · <strong>?</strong> help · <strong>b</strong> toggle sidebar · <strong>esc</strong> back
            </div>
          </article>
        </main>

        {/* Right: Context / Synthesis panel */}
        {!isNarrow && !showSynthesis && (
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
        {showSynthesis && (
          <aside className="context-panel synthesis-panel">
            <div className="context-section">
              <div className="context-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Synthesis</span>
                <button className="btn btn-sm" onClick={handleSynthesize} disabled={synthesizing}>
                  {synthesizing ? "Running..." : "Run"}
                </button>
              </div>
              {syntheses.length === 0 && !synthesizing && (
                <p style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 8 }}>
                  No syntheses yet. Click "Run" to analyze connections across the graph.
                </p>
              )}
              {syntheses.map((s: any) => (
                <div key={s.id} className="synthesis-result">
                  <div className="synthesis-header">
                    <span className="synthesis-id">{new Date(s.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                    <span className={`synthesis-status ${s.merged ? "merged" : ""}`}>{s.merged ? "merged" : "pending"}</span>
                  </div>
                  <div className="synthesis-summary">
                    <Markdown>{s.content.length > 300 ? s.content.slice(0, 300) + "..." : s.content}</Markdown>
                  </div>
                  {s.annotations && s.annotations.length > 0 && (
                    <div className="synthesis-annotations">
                      {s.annotations.map((a: any) => (
                        <div key={a.id} className={`annotation ${a.merged ? "annotation-merged" : ""}`}>
                          <div className="annotation-header">
                            <span className={`annotation-type type-${a.type}`}>{a.type}</span>
                            {!a.merged && !s.merged && (
                              <span className="annotation-actions">
                                <button onClick={() => handleMerge(s.id, a.id)} title={
                                  a.type === "crosslink" ? "Create crosslink between these nodes" :
                                  a.type === "note" ? "Attach this note to the node" :
                                  "Generate and preview resolution"
                                }>{a.type === "contradiction" || a.type === "merge_suggestion" ? "Resolve..." : "Apply"}</button>
                                <button onClick={() => handleMerge(s.id, a.id, true)} title="Dismiss without applying">Dismiss</button>
                              </span>
                            )}
                          </div>
                          <div className="annotation-nodes">
                            {a.sourceNodeId && <a href="#" onClick={(e) => { e.preventDefault(); setSelectedId(a.sourceNodeId); }}>{data.nodes.find((n: any) => n.id === a.sourceNodeId)?.title?.slice(0, 25) || a.sourceNodeId}</a>}
                            {a.targetNodeId && <> ↔ <a href="#" onClick={(e) => { e.preventDefault(); setSelectedId(a.targetNodeId); }}>{data.nodes.find((n: any) => n.id === a.targetNodeId)?.title?.slice(0, 25) || a.targetNodeId}</a></>}
                          </div>
                          <div className="annotation-content">{a.content}</div>
                        </div>
                      ))}
                      {!s.merged && s.annotations.some((a: any) => !a.merged) && (
                        <button className="btn btn-sm" style={{ marginTop: 8, width: "100%" }} onClick={() => handleMerge(s.id)}>
                          Merge all ({s.annotations.filter((a: any) => !a.merged).length})
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Merge Preview */}
            {mergePreview && (
              <div className="synthesis-result" style={{ borderColor: "var(--accent)", background: "rgba(187, 154, 247, 0.05)" }}>
                <div className="context-title" style={{ color: "var(--accent)" }}>Preview: {mergePreview.preview.title}</div>
                <div className="synthesis-summary" style={{ marginTop: 8 }}>
                  <Markdown>{mergePreview.preview.content}</Markdown>
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: "var(--fg-muted)" }}>
                  Parent: {mergePreview.preview.parentId} · Links to: {mergePreview.preview.crosslinkTo.join(", ")}
                </div>
                <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                  <button className="btn btn-sm" style={{ background: "var(--accent)", color: "var(--bg)" }}
                    onClick={() => handleMerge(mergePreview.synthesisId, mergePreview.annotationId, false, mergePreview.preview)}>
                    Accept
                  </button>
                  <button className="btn btn-sm" onClick={() => setMergePreview(null)}>Reject</button>
                </div>
              </div>
            )}
          </aside>
        )}
      </div>

      {/* Graph toggle */}
      <button className="graph-toggle" onClick={() => setShowGraph(!showGraph)}>{showGraph ? "Close graph" : "Graph (g)"}</button>

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

      {/* Help overlay */}
      {showHelp && (
        <div className="modal-overlay" onClick={() => setShowHelp(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <h2 className="modal-title">Keyboard shortcuts</h2>
            <div style={{ fontSize: 13, lineHeight: 2, fontFamily: "var(--font-mono)" }}>
              <div><strong>j/k ↑↓</strong> — navigate nodes</div>
              <div><strong>h/l ←→</strong> — siblings</div>
              <div><strong>e</strong> — extend (add children)</div>
              <div><strong>r</strong> — redirect (regenerate)</div>
              <div><strong>i</strong> — edit node content</div>
              <div><strong>p</strong> — prune node + descendants</div>
              <div><strong>g</strong> — toggle graph overlay</div>
              <div><strong>s</strong> — toggle synthesis panel</div>
              <div><strong>b</strong> — toggle sidebar</div>
              <div><strong>?</strong> — this help</div>
              <div><strong>esc</strong> — close overlay / go back</div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-sm" onClick={() => setShowHelp(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
