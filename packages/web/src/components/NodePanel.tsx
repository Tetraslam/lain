import React from "react";
import Markdown from "react-markdown";

interface NodePanelProps {
  node: any;
  dbFile: string;
  allNodes: any[];
  crosslinks: any[];
  onAction: (action: string, nodeId?: string) => void;
  onSelectNode: (nodeId: string) => void;
}

export function NodePanel({ node, dbFile, allNodes, crosslinks, onAction, onSelectNode }: NodePanelProps) {
  // Breadcrumb
  const ancestors: any[] = [];
  let current = node;
  while (current?.parentId) {
    const parent = allNodes.find((n: any) => n.id === current.parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    current = parent;
  }

  const children = allNodes.filter((n: any) => n.parentId === node.id && n.status !== "pruned");

  return (
    <div className="detail-panel">
      <div className="detail-header">
        {/* Breadcrumb */}
        {ancestors.length > 0 && (
          <div className="detail-breadcrumb">
            {ancestors.map((a: any, i: number) => (
              <React.Fragment key={a.id}>
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); onSelectNode(a.id); }}
                  style={{ color: "var(--fg-dim)", textDecoration: "none" }}
                >
                  {(a.title || a.id).slice(0, 20)}
                </a>
                <span> › </span>
              </React.Fragment>
            ))}
            <span style={{ color: "var(--fg)" }}>{(node.title || node.id).slice(0, 25)}</span>
          </div>
        )}

        <div className="detail-title">{node.title || node.id}</div>

        <div className="detail-meta-row">
          <div className="detail-meta-item">
            <span className="label">id</span> <span className="value">{node.id}</span>
          </div>
          <div className="detail-meta-item">
            <span className="label">depth</span> <span className="value">{node.depth}</span>
          </div>
          <div className="detail-meta-item">
            <span className="label">status</span>{" "}
            <span className="value" style={{
              color: node.status === "complete" ? "var(--green)" :
                     node.status === "pruned" ? "var(--red)" : "var(--yellow)"
            }}>
              {node.status}
            </span>
          </div>
          {node.model && (
            <div className="detail-meta-item">
              <span className="label">model</span> <span className="value">{node.model}</span>
            </div>
          )}
        </div>

        {node.planSummary && (
          <div style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>
            <span style={{ color: "var(--blue)" }}>direction</span>{" "}
            <span style={{ color: "var(--fg-dim)", fontStyle: "italic" }}>{node.planSummary}</span>
          </div>
        )}
      </div>

      <div className="detail-content">
        {node.content ? (
          <Markdown>{node.content}</Markdown>
        ) : (
          <p style={{ color: "var(--fg-dim)" }}>(no content)</p>
        )}

        {/* Cross-links */}
        {crosslinks.length > 0 && (
          <div className="detail-section">
            <div className="detail-section-title">Cross-links</div>
            {crosslinks.map((cl: any) => {
              const otherId = cl.sourceId === node.id ? cl.targetId : cl.sourceId;
              const other = allNodes.find((n: any) => n.id === otherId);
              return (
                <div key={`${cl.sourceId}-${cl.targetId}`} className="crosslink-item">
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); onSelectNode(otherId); }}
                    style={{ color: "var(--cyan)", textDecoration: "none" }}
                  >
                    → {other?.title || otherId}
                  </a>
                  {cl.label && <span style={{ color: "var(--fg-dim)" }}> — {cl.label}</span>}
                </div>
              );
            })}
          </div>
        )}

        {/* Children */}
        {children.length > 0 && (
          <div className="detail-section">
            <div className="detail-section-title">Children ({children.length})</div>
            {children.map((child: any) => (
              <div key={child.id} className="child-item">
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); onSelectNode(child.id); }}
                  style={{ color: "var(--fg)", textDecoration: "none" }}
                >
                  {child.branchIndex}. {child.title || child.id}
                </a>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="detail-actions">
        {node.id !== "root" && (
          <>
            <button className="btn btn-sm" onClick={() => onAction("extend", node.id)}>Extend</button>
            <button className="btn btn-sm" onClick={() => onAction("redirect", node.id)}>Redirect</button>
            <button className="btn btn-sm btn-danger" onClick={() => onAction("prune", node.id)}>Prune</button>
          </>
        )}
        {node.id === "root" && (
          <button className="btn btn-sm" onClick={() => onAction("extend", node.id)}>Extend</button>
        )}
      </div>
    </div>
  );
}
