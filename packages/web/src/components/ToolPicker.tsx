import React, { useState } from "react";

// Local mirrors of @lain/shared's tool-catalog types (the frontend can't import
// the node-side shared barrel, which pulls in fs/path).
export interface ToolInfo { id: string; title: string; description: string }
export interface ToolGroup {
  id: string; title: string; kind: "builtin" | "corpus" | "extension" | "mcp";
  description?: string; tools: ToolInfo[]; probed?: boolean; error?: string; server?: string;
}
export interface ToolCatalog { groups: ToolGroup[] }
export interface ToolSelection { disabledGroups: string[]; disabledTools: string[] }

const isGroupEnabled = (s: ToolSelection, id: string) => !s.disabledGroups.includes(id);
const isToolEnabled = (s: ToolSelection, gid: string, tid: string) => isGroupEnabled(s, gid) && !s.disabledTools.includes(tid);
function toggleGroup(s: ToolSelection, id: string, on: boolean): ToolSelection {
  const disabledGroups = s.disabledGroups.filter((g) => g !== id);
  if (!on) disabledGroups.push(id);
  return { ...s, disabledGroups };
}
function toggleTool(s: ToolSelection, id: string, on: boolean): ToolSelection {
  const disabledTools = s.disabledTools.filter((t) => t !== id);
  if (!on) disabledTools.push(id);
  return { ...s, disabledTools };
}

const KIND_BADGE: Record<ToolGroup["kind"], string> = {
  builtin: "built-in", corpus: "corpus", extension: "lens", mcp: "MCP",
};

interface ToolPickerProps {
  catalog: ToolCatalog;
  selection: ToolSelection;
  onChange: (next: ToolSelection) => void;
  /** Called to remove an MCP server (settings management only). */
  onRemoveServer?: (server: string) => void;
}

export function ToolPicker({ catalog, selection, onChange, onRemoveServer }: ToolPickerProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  return (
    <div className="toolpicker">
      {catalog.groups.map((g) => {
        const on = isGroupEnabled(selection, g.id);
        const activeCount = g.tools.filter((t) => isToolEnabled(selection, g.id, t.id)).length;
        const open = expanded[g.id];
        const hasTools = g.tools.length > 0;
        return (
          <div key={g.id} className={`tool-group${on ? "" : " off"}`}>
            <div className="tool-group-head">
              <button
                type="button"
                className={`toggle-switch${on ? " on" : ""}`}
                onClick={() => onChange(toggleGroup(selection, g.id, !on))}
                aria-pressed={on}
                title={on ? "Disable group" : "Enable group"}
              ><span className="toggle-knob" /></button>

              <button
                type="button"
                className="tool-group-title"
                onClick={() => hasTools && setExpanded((e) => ({ ...e, [g.id]: !open }))}
                disabled={!hasTools}
              >
                <span className={`tool-caret${open ? " open" : ""}`}>{hasTools ? "▸" : "·"}</span>
                <span className="tool-group-name">{g.title}</span>
                <span className={`tool-kind tool-kind-${g.kind}`}>{KIND_BADGE[g.kind]}</span>
                {hasTools && <span className="tool-count">{on ? `${activeCount}/${g.tools.length}` : "off"}</span>}
              </button>

              {g.kind === "mcp" && onRemoveServer && g.server && (
                <button className="tool-remove" title="Remove server" onClick={() => onRemoveServer(g.server!)}>×</button>
              )}
            </div>

            {g.description && !open && <div className="tool-group-desc">{g.description}</div>}
            {g.error && <div className="tool-group-error">✗ {g.error}</div>}
            {g.kind === "mcp" && !g.probed && !g.error && g.tools.length === 0 && (
              <div className="tool-group-desc">connect to list tools…</div>
            )}

            {open && hasTools && (
              <div className="tool-list">
                {g.tools.map((t) => {
                  const ton = isToolEnabled(selection, g.id, t.id);
                  return (
                    <label key={t.id} className={`tool-item${on ? "" : " locked"}`}>
                      <input
                        type="checkbox"
                        checked={ton}
                        disabled={!on}
                        onChange={(e) => onChange(toggleTool(selection, t.id, e.target.checked))}
                      />
                      <span className="tool-item-id">{t.id}</span>
                      <span className="tool-item-desc">{t.description}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
