import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  BackgroundVariant,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { NodePanel } from "./NodePanel";
import { LainNode } from "./LainNode";

interface ExplorationData {
  exploration: any;
  nodes: any[];
  crosslinks: any[];
}

const nodeTypes: NodeTypes = { lain: LainNode as any };

function buildLayout(data: ExplorationData): { nodes: Node[]; edges: Edge[] } {
  const { nodes: lainNodes, crosslinks } = data;

  // Build adjacency
  const childrenOf = new Map<string, any[]>();
  for (const n of lainNodes) {
    if (n.parentId) {
      const siblings = childrenOf.get(n.parentId) || [];
      siblings.push(n);
      childrenOf.set(n.parentId, siblings);
    }
  }
  for (const [, ch] of childrenOf) ch.sort((a: any, b: any) => a.branchIndex - b.branchIndex);

  // Radial layout
  const root = lainNodes.find((n: any) => n.parentId === null);
  if (!root) return { nodes: [], edges: [] };

  // Count leaves for proportional arcs
  const leafCount = new Map<string, number>();
  function countLeaves(nodeId: string): number {
    const children = childrenOf.get(nodeId) || [];
    if (children.length === 0) { leafCount.set(nodeId, 1); return 1; }
    let total = 0;
    for (const c of children) total += countLeaves(c.id);
    leafCount.set(nodeId, total);
    return total;
  }
  countLeaves(root.id);

  const maxDepth = Math.max(...lainNodes.map((n: any) => n.depth), 0);
  const ringSpacing = 250; // pixels between rings

  const flowNodes: Node[] = [];

  function layout(node: any, angleStart: number, angleEnd: number, depth: number) {
    const angle = (angleStart + angleEnd) / 2;
    const radius = depth * ringSpacing;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;

    flowNodes.push({
      id: node.id,
      type: "lain",
      position: { x, y },
      data: {
        title: node.title || node.id,
        depth: node.depth,
        status: node.status,
        model: node.model,
      },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    });

    const children = childrenOf.get(node.id) || [];
    if (children.length === 0) return;
    const parentLeaves = leafCount.get(node.id) || 1;
    const arcSpan = angleEnd - angleStart;
    let currentAngle = angleStart;
    for (const child of children) {
      const childLeaves = leafCount.get(child.id) || 1;
      const childArc = arcSpan * (childLeaves / parentLeaves);
      layout(child, currentAngle, currentAngle + childArc, depth + 1);
      currentAngle += childArc;
    }
  }

  layout(root, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2, 0);

  // Edges
  const flowEdges: Edge[] = [];
  for (const n of lainNodes) {
    if (n.parentId) {
      flowEdges.push({
        id: `${n.parentId}-${n.id}`,
        source: n.parentId,
        target: n.id,
        type: "default",
        animated: false,
        style: { stroke: "#3b3f5c", strokeWidth: 1.5 },
      });
    }
  }
  for (const cl of crosslinks) {
    flowEdges.push({
      id: `cl-${cl.sourceId}-${cl.targetId}`,
      source: cl.sourceId,
      target: cl.targetId,
      className: "crosslink",
      animated: true,
      style: { stroke: "#7c6ea3", strokeWidth: 1, strokeDasharray: "6 4" },
    });
  }

  return { nodes: flowNodes, edges: flowEdges };
}

export function ExplorationView({ dbFile, onBack }: { dbFile: string; onBack: () => void }) {
  const [data, setData] = useState<ExplorationData | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const fetchData = useCallback(async () => {
    const res = await fetch(`/api/exploration/${encodeURIComponent(dbFile)}`);
    const d = await res.json();
    setData(d);
    const layout = buildLayout(d);
    setNodes(layout.nodes);
    setEdges(layout.edges);
    if (!selectedNodeId) setSelectedNodeId("root");
  }, [dbFile]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const selectedLainNode = useMemo(() => {
    if (!data || !selectedNodeId) return null;
    return data.nodes.find((n: any) => n.id === selectedNodeId) || null;
  }, [data, selectedNodeId]);

  const handleAction = useCallback(async (action: string, nodeId?: string) => {
    const target = nodeId || selectedNodeId;
    if (!target) return;

    if (action === "prune") {
      await fetch("/api/prune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dbFile, nodeId: target }),
      });
    } else if (action === "extend") {
      await fetch("/api/extend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dbFile, nodeId: target }),
      });
    } else if (action === "redirect") {
      await fetch("/api/redirect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dbFile, nodeId: target }),
      });
    } else if (action === "export") {
      await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dbFile }),
      });
    } else if (action === "sync") {
      await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dbFile }),
      });
    }

    // Refresh data after action
    await fetchData();
  }, [dbFile, selectedNodeId, fetchData]);

  if (!data) return <div className="home-loading" style={{ padding: "2rem" }}>Loading...</div>;

  const exp = data.exploration;

  return (
    <div className="exploration-container">
      <div className="exploration-header">
        <button className="back-btn" onClick={onBack}>←</button>
        <div>
          <div className="header-title">{exp.name}</div>
          <div className="header-meta">
            {data.nodes.filter((n: any) => n.status !== "pruned").length} nodes · n={exp.n} m={exp.m} · {exp.extension}
          </div>
        </div>
        <div className="header-actions">
          <button className="btn btn-sm" onClick={() => handleAction("export")}>Export</button>
          <button className="btn btn-sm" onClick={() => handleAction("sync")}>Sync</button>
        </div>
      </div>

      <div className="exploration-body">
        <div className="graph-panel">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            minZoom={0.1}
            maxZoom={2}
            defaultEdgeOptions={{ type: "default" }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#292e42" />
            <Controls position="bottom-left" style={{ background: "#1f2335", borderColor: "#32344a" }} />
            <MiniMap
              nodeColor={(node) => {
                if (node.data?.status === "pruned") return "#f7768e";
                if (node.data?.depth === 0) return "#7aa2f7";
                return "#565f89";
              }}
              maskColor="rgba(26, 27, 38, 0.8)"
              style={{ background: "#16161e", borderColor: "#32344a" }}
            />
          </ReactFlow>
        </div>

        {selectedLainNode && (
          <NodePanel
            node={selectedLainNode}
            dbFile={dbFile}
            allNodes={data.nodes}
            crosslinks={data.crosslinks.filter(
              (cl: any) => cl.sourceId === selectedNodeId || cl.targetId === selectedNodeId
            )}
            onAction={handleAction}
            onSelectNode={setSelectedNodeId}
          />
        )}
      </div>
    </div>
  );
}
