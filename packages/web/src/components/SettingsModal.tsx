import React, { useState, useEffect, useCallback } from "react";
import { ToolPicker, type ToolCatalog, type ToolSelection } from "./ToolPicker";

interface SettingsModalProps {
  onClose: () => void;
}

interface SettingOption { value: string; label: string }
interface SettingField {
  key: string;
  label: string;
  description?: string;
  type: "string" | "secret" | "number" | "boolean" | "select";
  section: string;
  store: "config" | "credentials";
  options?: SettingOption[];
  suggestions?: string[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  value: unknown;
  isSet: boolean;
}
interface SettingSection { id: string; title: string; description?: string }
interface ConfigResponse {
  sections: SettingSection[];
  fields: SettingField[];
  paths: { global: string; workspace: string | null; credentials: string };
}

type TestState = { status: "idle" | "testing" | "ok" | "fail"; message?: string };

export function SettingsModal({ onClose }: SettingsModalProps) {
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // edits: key -> new value. secrets only included if the user typed something.
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [activeSection, setActiveSection] = useState<string>("provider");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  // Tools & MCP tab
  const [toolCatalog, setToolCatalog] = useState<ToolCatalog | null>(null);
  const [toolSelection, setToolSelection] = useState<ToolSelection>({ disabledGroups: [], disabledTools: [] });
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsSavedAt, setToolsSavedAt] = useState<number | null>(null);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpHeader, setMcpHeader] = useState("");
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  const loadTools = useCallback(async () => {
    setToolsLoading(true);
    try {
      const res = await fetch("/api/tools?probe=1");
      const json = await res.json();
      setToolCatalog(json.catalog);
      setToolSelection(json.selection ?? { disabledGroups: [], disabledTools: [] });
    } catch { /* ignore */ }
    setToolsLoading(false);
  }, []);

  const saveToolSelection = useCallback(async (next: ToolSelection) => {
    setToolSelection(next);
    await fetch("/api/tools", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selection: next }),
    });
    setToolsSavedAt(Date.now());
  }, []);

  const addMcpServer = useCallback(async () => {
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    setMcpBusy(true);
    setMcpError(null);
    const headers: Record<string, string> = {};
    const idx = mcpHeader.indexOf(":");
    if (idx > 0) headers[mcpHeader.slice(0, idx).trim()] = mcpHeader.slice(idx + 1).trim();
    try {
      const res = await fetch("/api/mcp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: mcpName.trim(), url: mcpUrl.trim(), headers }),
      });
      const json = await res.json();
      if (!json.ok && json.error) setMcpError(json.error);
      setMcpName(""); setMcpUrl(""); setMcpHeader("");
      await loadTools();
    } catch (err: any) {
      setMcpError(err.message);
    }
    setMcpBusy(false);
  }, [mcpName, mcpUrl, mcpHeader, loadTools]);

  const removeMcpServer = useCallback(async (server: string) => {
    await fetch("/api/mcp", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: server }),
    });
    await loadTools();
  }, [loadTools]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/config");
    const json = (await res.json()) as ConfigResponse;
    setData(json);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const dirty = Object.keys(edits).length > 0;

  const setEdit = (key: string, value: unknown) => {
    setEdits((prev) => ({ ...prev, [key]: value }));
    setSavedAt(null);
    setTest({ status: "idle" });
  };

  // Effective value for a field = pending edit if present, else stored value.
  const effective = (f: SettingField): unknown =>
    Object.prototype.hasOwnProperty.call(edits, f.key) ? edits[f.key] : f.value;

  const currentProvider = (): string => {
    const f = data?.fields.find((x) => x.key === "defaultProvider");
    return String(f ? effective(f) : "anthropic");
  };

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    const updates = Object.entries(edits).map(([key, value]) => ({ key, value }));
    const res = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates, scope: "global" }),
    });
    const json = (await res.json()) as ConfigResponse & { errors?: { key: string; error: string }[] };
    setData({ sections: json.sections, fields: json.fields, paths: (json as any).paths ?? data!.paths });
    setEdits({});
    setSaving(false);
    setSavedAt(Date.now());
  };

  const runTest = async () => {
    setTest({ status: "testing" });
    // Send pending provider/model + any pending credential edits so the test
    // reflects what the user is about to save.
    const provider = currentProvider();
    const modelField = data?.fields.find((x) => x.key === "defaultModel");
    const model = modelField ? String(effective(modelField)) : undefined;
    const creds: Record<string, any> = {};
    for (const f of data?.fields ?? []) {
      if (f.store !== "credentials") continue;
      if (!Object.prototype.hasOwnProperty.call(edits, f.key)) continue;
      const [, prov, sub] = f.key.split(".");
      creds[prov] = creds[prov] ?? {};
      creds[prov][sub] = edits[f.key];
    }
    try {
      const res = await fetch("/api/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model, credentials: creds }),
      });
      const json = await res.json();
      if (json.ok) setTest({ status: "ok", message: `${json.model} replied “${json.sample}”` });
      else setTest({ status: "fail", message: json.error });
    } catch (err: any) {
      setTest({ status: "fail", message: err.message });
    }
  };

  const renderField = (f: SettingField) => {
    const val = effective(f);
    const id = `set-${f.key}`;
    return (
      <div className="setting-row" key={f.key}>
        <div className="setting-meta">
          <label htmlFor={id} className="setting-label">{f.label}</label>
          {f.description && <span className="setting-desc">{f.description}</span>}
        </div>
        <div className="setting-control">
          {f.type === "boolean" ? (
            <button
              type="button"
              className={`toggle-switch${val ? " on" : ""}`}
              onClick={() => setEdit(f.key, !val)}
              aria-pressed={!!val}
            ><span className="toggle-knob" /></button>
          ) : f.type === "select" ? (
            <select id={id} className="form-input" value={String(val ?? "")} onChange={(e) => setEdit(f.key, e.target.value)}>
              {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : f.type === "secret" ? (
            <input
              id={id}
              className="form-input"
              type="password"
              autoComplete="new-password"
              placeholder={f.isSet ? "•••••••• (stored — type to replace)" : (f.placeholder || "not set")}
              value={Object.prototype.hasOwnProperty.call(edits, f.key) ? String(edits[f.key] ?? "") : ""}
              onChange={(e) => setEdit(f.key, e.target.value)}
            />
          ) : f.type === "number" ? (
            <input
              id={id}
              className="form-input"
              type="number"
              min={f.min} max={f.max} step={f.step}
              value={val === "" || val == null ? "" : Number(val)}
              onChange={(e) => setEdit(f.key, e.target.value === "" ? "" : Number(e.target.value))}
            />
          ) : (
            <input
              id={id}
              className="form-input"
              type="text"
              placeholder={f.placeholder}
              list={f.suggestions ? `${id}-sug` : undefined}
              value={String(val ?? "")}
              onChange={(e) => setEdit(f.key, e.target.value)}
            />
          )}
          {f.suggestions && (
            <datalist id={`${id}-sug`}>
              {f.suggestions.map((s) => <option key={s} value={s} />)}
            </datalist>
          )}
        </div>
      </div>
    );
  };

  const sections = data?.sections ?? [];
  const sectionFields = (id: string) => (data?.fields ?? []).filter((f) => f.section === id);

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="modal-content settings-modal">
        <div className="settings-header">
          <div className="modal-title">Settings</div>
          {data?.paths && (
            <span className="settings-path" title={data.paths.global}>~/.config/lain/config.json</span>
          )}
        </div>

        {loading ? (
          <p className="home-loading">loading…</p>
        ) : (
          <div className="settings-body">
            <nav className="settings-nav">
              {sections.map((s) => (
                <button
                  key={s.id}
                  className={`settings-tab${activeSection === s.id ? " active" : ""}`}
                  onClick={() => setActiveSection(s.id)}
                >{s.title}</button>
              ))}
              <button
                className={`settings-tab${activeSection === "tools" ? " active" : ""}`}
                onClick={() => { setActiveSection("tools"); if (!toolCatalog) loadTools(); }}
              >Tools &amp; MCP</button>
            </nav>

            <div className="settings-pane">
              {activeSection === "tools" ? (
                <div>
                  <p className="settings-section-desc">
                    Which tools agents may use by default. Toggle a whole group, or expand it to pick individual tools.
                    {toolsSavedAt && <span className="settings-saved"> saved ✓</span>}
                  </p>
                  {toolsLoading || !toolCatalog ? (
                    <p className="home-loading">probing tools…</p>
                  ) : (
                    <ToolPicker catalog={toolCatalog} selection={toolSelection} onChange={saveToolSelection} onRemoveServer={removeMcpServer} />
                  )}
                  <div className="mcp-add">
                    <div className="mcp-add-title">Add an MCP server</div>
                    <div className="mcp-add-row">
                      <input className="form-input" placeholder="name" value={mcpName} onChange={(e) => setMcpName(e.target.value)} style={{ flex: "0 0 120px" }} />
                      <input className="form-input" placeholder="https://server/mcp" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} style={{ flex: 1 }} />
                    </div>
                    <input className="form-input" placeholder="optional header — e.g. Authorization: Bearer xyz" value={mcpHeader} onChange={(e) => setMcpHeader(e.target.value)} />
                    {mcpError && <div className="tool-group-error">✗ {mcpError}</div>}
                    <div className="mcp-add-actions">
                      <button className="btn btn-primary" onClick={addMcpServer} disabled={mcpBusy || !mcpName.trim() || !mcpUrl.trim()}>
                        {mcpBusy ? "connecting…" : "Add + probe"}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                sections.filter((s) => s.id === activeSection).map((s) => (
                  <div key={s.id}>
                    {s.description && <p className="settings-section-desc">{s.description}</p>}
                    {sectionFields(s.id).map(renderField)}
                    {s.id === "provider" && (
                      <div className="settings-test">
                        <button className="btn" onClick={runTest} disabled={test.status === "testing"}>
                          {test.status === "testing" ? "testing…" : "Test connection"}
                        </button>
                        {test.status === "ok" && <span className="test-ok">✓ {test.message}</span>}
                        {test.status === "fail" && <span className="test-fail">✗ {test.message}</span>}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <div className="modal-actions settings-actions">
          {savedAt && !dirty && <span className="settings-saved">saved ✓</span>}
          <button className="btn" onClick={onClose}>{dirty ? "Cancel" : "Close"}</button>
          <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : `Save${dirty ? ` (${Object.keys(edits).length})` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
