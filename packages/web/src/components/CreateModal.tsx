import React, { useState, useRef, useCallback } from "react";
import { ToolPicker, type ToolCatalog, type ToolSelection } from "./ToolPicker";

interface CreateModalProps {
  onClose: () => void;
  onCreated: (dbFile: string) => void;
}

function countActive(catalog: ToolCatalog | null, sel: ToolSelection): number {
  if (!catalog) return 0;
  let n = 0;
  for (const g of catalog.groups) {
    if (sel.disabledGroups.includes(g.id)) continue;
    for (const t of g.tools) if (!sel.disabledTools.includes(t.id)) n++;
  }
  return n;
}

interface Activity {
  id: number;
  kind: "plan" | "tool" | "node" | "corpus" | "info" | "mission";
  text: string;
  node?: string;
}

interface MissionType {
  explorationId: string;
  intent: string;
  assertions: { id: string; text: string }[];
  features: { id: string; angle: string; assertions: string[] }[];
  createdAt: string;
}

type InterviewResult =
  | { done: false; questions: string[]; rationale?: string }
  | { done: true; mission: MissionType };

type Phase = "form" | "interview" | "creating";

const EXTENSIONS = [
  { value: "freeform", label: "Freeform", hint: "pure divergent thinking" },
  { value: "worldbuilding", label: "Worldbuilding", hint: "geography, cultures, magic — coins in-world names" },
  { value: "debate", label: "Debate", hint: "pro / con / steelman / critique" },
  { value: "research", label: "Research", hint: "citations & methodology" },
];

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let activityCounter = 0;

export function CreateModal({ onClose, onCreated }: CreateModalProps) {
  const [seed, setSeed] = useState("");
  const [n, setN] = useState("3");
  const [m, setM] = useState("2");
  const [ext, setExt] = useState("freeform");
  const [agentic, setAgentic] = useState(false);
  const [mission, setMission] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  // Per-run tool selection
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolCatalog, setToolCatalog] = useState<ToolCatalog | null>(null);
  const [runSelection, setRunSelection] = useState<ToolSelection>({ disabledGroups: [], disabledTools: [] });
  const [toolsLoading, setToolsLoading] = useState(false);
  const [saveToolsDefault, setSaveToolsDefault] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [activity, setActivity] = useState<Activity[]>([]);
  const [doneCount, setDoneCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  // Interview (mission gate) state
  const [interviewHistory, setInterviewHistory] = useState<{ question: string; answer: string }[]>([]);
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [proposedMission, setProposedMission] = useState<MissionType | null>(null);
  const [interviewBusy, setInterviewBusy] = useState(false);
  const [interviewError, setInterviewError] = useState<string | null>(null);
  const [refining, setRefining] = useState(false);
  const [refineText, setRefineText] = useState("");

  const grounded = agentic || files.length > 0;

  const pushActivity = useCallback((a: Omit<Activity, "id">) => {
    setActivity((prev) => [...prev, { ...a, id: activityCounter++ }].slice(-60));
    requestAnimationFrame(() => {
      if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
    });
  }, []);

  const addFiles = useCallback((list: FileList | File[]) => {
    const incoming = Array.from(list);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...incoming.filter((f) => !seen.has(f.name + f.size))];
    });
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  // ---- Mission interview (the cognitive-frontloading gate) ----
  const runInterviewTurn = useCallback(async (history: { question: string; answer: string }[]) => {
    setInterviewBusy(true);
    setInterviewError(null);
    try {
      const res = await fetch("/api/mission/interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed, n: parseInt(n) || 3, extension: ext, history }),
      });
      const result = (await res.json()) as InterviewResult;
      if (result.done) {
        setProposedMission(result.mission);
        setQuestions([]);
        setAnswers([]);
      } else {
        setProposedMission(null);
        setQuestions(result.questions || []);
        setAnswers((result.questions || []).map(() => ""));
      }
    } catch (err: any) {
      setInterviewError(err.message || "interview failed");
    }
    setInterviewBusy(false);
  }, [seed, n, ext]);

  const startInterview = () => {
    setPhase("interview");
    setInterviewHistory([]);
    setProposedMission(null);
    setQuestions([]);
    setRefining(false);
    runInterviewTurn([]);
  };

  const submitAnswers = () => {
    const turns = questions.map((q, i) => ({ question: q, answer: (answers[i] || "").trim() }));
    const next = [...interviewHistory, ...turns];
    setInterviewHistory(next);
    setQuestions([]);
    runInterviewTurn(next);
  };

  const submitRefine = () => {
    const next = [...interviewHistory, { question: "Requested change", answer: refineText.trim() }];
    setInterviewHistory(next);
    setProposedMission(null);
    setRefining(false);
    setRefineText("");
    runInterviewTurn(next);
  };

  const loadTools = useCallback(async () => {
    setToolsLoading(true);
    try {
      const res = await fetch("/api/tools?probe=1");
      const json = await res.json();
      setToolCatalog(json.catalog);
      setRunSelection(json.selection ?? { disabledGroups: [], disabledTools: [] });
    } catch { /* ignore */ }
    setToolsLoading(false);
  }, []);

  const openToolPanel = () => {
    setToolsOpen((o) => {
      const next = !o;
      if (next && !toolCatalog) loadTools();
      return next;
    });
  };

  const handleCreate = async (lockedMission: MissionType | null = null) => {
    if (!seed.trim() || phase === "creating") return;
    setPhase("creating");
    setActivity([]);
    setDoneCount(0);
    pushActivity({
      kind: "info",
      text: lockedMission ? "Pursuing the mission…" : grounded ? "Seeding agents with your material…" : "Beginning exploration…",
    });

    try {
      // Include a per-run tool selection only if the user actually opened/edited it.
      const selectionEdited = toolsOpen && toolCatalog &&
        (runSelection.disabledGroups.length > 0 || runSelection.disabledTools.length > 0 || saveToolsDefault);
      const toolSelection = selectionEdited ? runSelection : null;

      let res: Response;
      if (files.length > 0) {
        const form = new FormData();
        form.append("seed", seed);
        form.append("n", n);
        form.append("m", m);
        form.append("extension", ext);
        form.append("agentic", "true");
        if (lockedMission) form.append("mission", JSON.stringify(lockedMission));
        if (toolSelection) form.append("toolSelection", JSON.stringify(toolSelection));
        if (saveToolsDefault) form.append("saveToolsDefault", "true");
        for (const f of files) form.append("files", f);
        res = await fetch("/api/create", { method: "POST", body: form });
      } else {
        res = await fetch("/api/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seed, n: parseInt(n) || 3, m: parseInt(m) || 2, extension: ext,
            agentic: grounded || !!lockedMission, mission: lockedMission,
            toolSelection, saveToolsDefault,
          }),
        });
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let dbFile = "";

      if (reader) {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const eventStr of events) {
            let eventType = "";
            let data = "";
            for (const line of eventStr.split("\n")) {
              if (line.startsWith("event: ")) eventType = line.slice(7);
              if (line.startsWith("data: ")) data = line.slice(6);
            }
            if (!eventType || !data) continue;
            let parsed: any;
            try { parsed = JSON.parse(data); } catch { continue; }

            switch (eventType) {
              case "mission:set":
                pushActivity({ kind: "mission", text: `Contract set — ${parsed.assertions} assertions, ${parsed.features} branches` });
                break;
              case "corpus:ingested":
                pushActivity({ kind: "corpus", text: `Ingested ${parsed.count} source${parsed.count === 1 ? "" : "s"} into the corpus` });
                break;
              case "plan:complete": {
                const dirs: string[] = parsed.data?.directions ?? [];
                pushActivity({ kind: "plan", text: `Planned ${dirs.length} directions from ${parsed.nodeId}`, node: parsed.nodeId });
                break;
              }
              case "node:agent-step": {
                const step = parsed.data;
                if (step?.kind === "tool_call") {
                  pushActivity({ kind: "tool", text: TOOL_LABELS[step.name] ?? step.name, node: parsed.nodeId });
                }
                break;
              }
              case "node:complete":
                setDoneCount((c) => c + 1);
                pushActivity({ kind: "node", text: parsed.data?.title || "untitled", node: parsed.nodeId });
                break;
              case "mission:validated": {
                const r = parsed.data ?? {};
                const met = (r.results ?? []).filter((x: any) => x.status === "met").length;
                pushActivity({ kind: "mission", text: `Validation round ${r.round}: ${met}/${r.results?.length ?? 0} met${r.satisfied ? " — satisfied ✓" : ""}` });
                break;
              }
              case "mission:fix": {
                const f = parsed.data ?? {};
                pushActivity({ kind: "mission", text: `Closing gap [${(f.assertions ?? []).join(", ")}]`, node: parsed.nodeId });
                break;
              }
              case "complete":
                dbFile = parsed.dbFile;
                break;
              case "error":
                pushActivity({ kind: "info", text: `Error: ${parsed.message}` });
                setPhase("form");
                return;
            }
          }
        }
      }

      if (dbFile) onCreated(dbFile);
      else { pushActivity({ kind: "info", text: "Failed to create exploration" }); setPhase("form"); }
    } catch (err: any) {
      pushActivity({ kind: "info", text: `Error: ${err.message}` });
      setPhase("form");
    }
  };

  const primaryAction = () => (mission ? startInterview() : handleCreate(null));

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && phase !== "creating") onClose(); }}>
      <div className="modal-content create-modal">
        <div className="modal-title">
          {phase === "interview" ? "Mission — pin down the goal" : "New exploration"}
        </div>

        {phase === "form" && (
          <>
            <div className="form-group">
              <label className="form-label">Seed idea</label>
              <textarea
                className="form-input create-seed"
                placeholder="what if cities were grown instead of built…"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                autoFocus
                rows={2}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) primaryAction(); }}
              />
            </div>

            <div className="form-row">
              <div className="form-group" style={{ flex: "0 0 70px" }}>
                <label className="form-label">Branches</label>
                <input className="form-input" value={n} onChange={(e) => setN(e.target.value)} />
              </div>
              <div className="form-group" style={{ flex: "0 0 70px" }}>
                <label className="form-label">Depth</label>
                <input className="form-input" value={m} onChange={(e) => setM(e.target.value)} />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Lens</label>
                <select className="form-input" value={ext} onChange={(e) => setExt(e.target.value)}>
                  {EXTENSIONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                </select>
              </div>
            </div>
            <div className="lens-hint">{EXTENSIONS.find((x) => x.value === ext)?.hint}</div>

            {/* Corpus drop zone */}
            <div className="form-group">
              <label className="form-label">Source material — ground the agents in your world</label>
              <div
                className={`drop-zone${dragging ? " dragging" : ""}${files.length ? " has-files" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => { if (e.target.files) addFiles(e.target.files); }}
                />
                {files.length === 0 ? (
                  <span className="drop-hint">drop PDFs, notes, CSVs, images… or click to browse</span>
                ) : (
                  <div className="file-chips">
                    {files.map((f, i) => (
                      <span key={f.name + i} className="file-chip">
                        {f.name}<span className="file-size">{humanSize(f.size)}</span>
                        <button
                          className="chip-x"
                          onClick={(e) => { e.stopPropagation(); setFiles((prev) => prev.filter((_, j) => j !== i)); }}
                        >×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <label className={`agentic-toggle${grounded ? " on" : ""}`} onClick={() => files.length === 0 && setAgentic(!agentic)}>
              <span className={`toggle-switch${grounded ? " on" : ""}`}><span className="toggle-knob" /></span>
              <span className="toggle-label">
                <strong>Agentic mode</strong>
                <em>{grounded ? "nodes research the graph + your corpus, and link across branches" : "one-shot generation (faster, less grounded)"}</em>
              </span>
              {files.length > 0 && <span className="toggle-forced">on — corpus attached</span>}
            </label>

            <label className={`agentic-toggle${mission ? " on" : ""}`} onClick={() => setMission(!mission)}>
              <span className={`toggle-switch${mission ? " on" : ""}`}><span className="toggle-knob" /></span>
              <span className="toggle-label">
                <strong>Mission mode</strong>
                <em>{mission ? "interview to pin the goal, then validate the graph against a contract" : "freeform branching with no success contract"}</em>
              </span>
            </label>

            {/* Per-run tool selection */}
            <div className="tool-disclosure">
              <button type="button" className="tool-disclosure-head" onClick={openToolPanel}>
                <span className={`tool-caret${toolsOpen ? " open" : ""}`}>▸</span>
                <strong>Tools</strong>
                <em>
                  {toolsOpen && toolCatalog
                    ? `${countActive(toolCatalog, runSelection)} tools active for this run`
                    : "choose which tools & MCP servers agents may use"}
                </em>
              </button>
              {toolsOpen && (
                <div className="tool-disclosure-body">
                  {toolsLoading || !toolCatalog ? (
                    <p className="home-loading">probing tools…</p>
                  ) : (
                    <>
                      <ToolPicker catalog={toolCatalog} selection={runSelection} onChange={setRunSelection} />
                      <label className="save-default">
                        <input type="checkbox" checked={saveToolsDefault} onChange={(e) => setSaveToolsDefault(e.target.checked)} />
                        save this selection as the new default
                      </label>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={primaryAction} disabled={!seed.trim()}>
                {mission ? "Plan mission ◇" : `Explore ${grounded ? "↬" : "→"}`}
              </button>
            </div>
          </>
        )}

        {phase === "interview" && (
          <div className="interview">
            <div className="interview-head">
              <div className="streaming-dot" />
              <span>{proposedMission ? "Proposed contract — approve before exploring" : interviewBusy ? "thinking…" : "A few questions first"}</span>
            </div>

            {interviewError && <div className="feed-line feed-info"><span className="feed-text">Error: {interviewError}</span></div>}

            {interviewBusy && (
              <div className="interview-busy">pinning down the goal…</div>
            )}

            {!interviewBusy && !proposedMission && questions.length > 0 && (
              <>
                <div className="interview-questions">
                  {questions.map((q, i) => (
                    <div className="form-group" key={i}>
                      <label className="form-label">{q}</label>
                      <textarea
                        className="form-input"
                        rows={2}
                        value={answers[i] || ""}
                        autoFocus={i === 0}
                        placeholder="your answer — leave blank to let lain decide"
                        onChange={(e) => setAnswers((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
                      />
                    </div>
                  ))}
                </div>
                <div className="modal-actions">
                  <button className="btn" onClick={() => setPhase("form")}>Back</button>
                  <button className="btn btn-primary" onClick={submitAnswers}>Continue →</button>
                </div>
              </>
            )}

            {!interviewBusy && proposedMission && !refining && (
              <>
                <div className="contract-card">
                  <p className="contract-intent">{proposedMission.intent}</p>
                  <div className="contract-section">Contract · {proposedMission.assertions.length} assertions</div>
                  <ul className="contract-list">
                    {proposedMission.assertions.map((a) => (
                      <li key={a.id}><span className="contract-id">{a.id}</span>{a.text}</li>
                    ))}
                  </ul>
                  {proposedMission.features.length > 0 && (
                    <>
                      <div className="contract-section">Branches</div>
                      <ul className="contract-list">
                        {proposedMission.features.map((f) => (
                          <li key={f.id}>
                            <span className="contract-id branch">{f.id}</span>{f.angle}
                            <span className="contract-claims"> [{f.assertions.join(", ")}]</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
                <div className="modal-actions">
                  <button className="btn" onClick={() => setRefining(true)}>Refine</button>
                  <button className="btn btn-primary" onClick={() => handleCreate(proposedMission)}>Lock in &amp; explore ↬</button>
                </div>
              </>
            )}

            {!interviewBusy && proposedMission && refining && (
              <>
                <div className="form-group">
                  <label className="form-label">What should change about the goal or contract?</label>
                  <textarea
                    className="form-input"
                    rows={3}
                    value={refineText}
                    autoFocus
                    onChange={(e) => setRefineText(e.target.value)}
                  />
                </div>
                <div className="modal-actions">
                  <button className="btn" onClick={() => setRefining(false)}>Back</button>
                  <button className="btn btn-primary" onClick={submitRefine} disabled={!refineText.trim()}>Resubmit →</button>
                </div>
              </>
            )}
          </div>
        )}

        {phase === "creating" && (
          <div className="thinking">
            <div className="thinking-head">
              <div className="streaming-dot" />
              <span>{doneCount > 0 ? `${doneCount} nodes woven` : "thinking"}</span>
            </div>
            <div className="thinking-feed" ref={feedRef}>
              {activity.map((a) => (
                <div key={a.id} className={`feed-line feed-${a.kind}`}>
                  {a.node && <span className="feed-tag">{a.node}</span>}
                  <span className="feed-text">{a.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  outline: "scanning the whole graph",
  read_node: "reading a related branch",
  search_nodes: "searching other nodes",
  search_corpus: "consulting your source material",
  list_corpus_sources: "reviewing available sources",
  read_findings: "reviewing shared findings",
  note_finding: "recording a finding",
  link_to_node: "linking to a related branch",
  coin_names: "coining in-world names",
  submit_node: "writing the node",
};
