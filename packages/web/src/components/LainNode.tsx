import React, { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

const handleStyle = { background: "#3b3f5c", border: "none", width: 5, height: 5, opacity: 0 };

export const LainNode = memo(function LainNode({ data, selected }: NodeProps & { data: any }) {
  const d = data as { title: string; depth: number; status: string };
  const className = [
    "lain-node",
    selected && "selected",
    d.depth === 0 && "depth-0",
    d.status === "pruned" && "pruned",
  ].filter(Boolean).join(" ");

  return (
    <div className={className}>
      {/* Handles on all 4 sides for positional edge routing */}
      <Handle type="target" position={Position.Top} id="top" style={handleStyle} />
      <Handle type="target" position={Position.Bottom} id="bottom-t" style={handleStyle} />
      <Handle type="target" position={Position.Left} id="left-t" style={handleStyle} />
      <Handle type="target" position={Position.Right} id="right-t" style={handleStyle} />
      <Handle type="source" position={Position.Top} id="top-s" style={handleStyle} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={handleStyle} />
      <Handle type="source" position={Position.Left} id="left" style={handleStyle} />
      <Handle type="source" position={Position.Right} id="right" style={handleStyle} />

      <div className="node-title">{d.title}</div>
      <div className="node-meta">depth {d.depth} · {d.status}</div>
    </div>
  );
});
