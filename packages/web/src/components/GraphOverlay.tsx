import React from "react";
import {
  ReactFlow, Background, Controls, MiniMap,
  type Node, type Edge, type NodeTypes,
  BackgroundVariant,
  type OnNodesChange, type OnEdgesChange,
} from "@xyflow/react";
import { LainNode } from "./LainNode";

const nodeTypes: NodeTypes = { lain: LainNode as any };

interface GraphOverlayProps {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node>;
  onEdgesChange: OnEdgesChange<Edge>;
  onSelect: (id: string) => void;
  onClose: () => void;
}

/** Full-screen radial graph overlay (React Flow). */
export function GraphOverlay({ nodes, edges, onNodesChange, onEdgesChange, onSelect, onClose }: GraphOverlayProps) {
  return (
    <div className="graph-overlay">
      <button className="graph-close" onClick={onClose}>✕ Close</button>
      <ReactFlow
        nodes={nodes} edges={edges}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onNodeClick={(_e: any, n: any) => { onSelect(n.id); onClose(); }}
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
  );
}
