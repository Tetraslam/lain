import React, { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

interface LainNodeData {
  title: string;
  depth: number;
  status: string;
  model?: string;
}

export const LainNode = memo(function LainNode({ data, selected }: NodeProps & { data: LainNodeData }) {
  const d = data as LainNodeData;
  const className = [
    "lain-node",
    selected && "selected",
    d.depth === 0 && "depth-0",
    d.status === "pruned" && "pruned",
  ].filter(Boolean).join(" ");

  return (
    <div className={className}>
      <Handle type="target" position={Position.Top} style={{ background: "#3b3f5c", border: "none", width: 6, height: 6 }} />
      <div className="node-title">{d.title}</div>
      <div className="node-meta">depth {d.depth} · {d.status}</div>
      <Handle type="source" position={Position.Bottom} style={{ background: "#3b3f5c", border: "none", width: 6, height: 6 }} />
    </div>
  );
});
