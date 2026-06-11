import React, { useState, useEffect, useCallback } from "react";

interface MissionAssertion { id: string; text: string }
interface MissionFeature { id: string; angle: string; assertions: string[] }
interface Mission { intent: string; assertions: MissionAssertion[]; features: MissionFeature[] }
interface AssertionResult { id: string; status: "met" | "partial" | "unmet"; evidence: string }
interface MissionReport { round: number; satisfied: boolean; results: AssertionResult[]; summary: string }

const STATUS_GLYPH: Record<string, string> = { met: "✓", partial: "◐", unmet: "✗" };

/**
 * Right-rail panel showing the mission contract (intent + assertions) and the
 * latest validation verdict per assertion. Renders nothing when the exploration
 * has no mission, so it stays out of the way for plain explorations.
 */
export function MissionPanel({ dbFile }: { dbFile: string }) {
  const [mission, setMission] = useState<Mission | null>(null);
  const [report, setReport] = useState<MissionReport | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/mission/${encodeURIComponent(dbFile)}`);
      if (res.ok) { const d = await res.json(); setMission(d.mission); setReport(d.report); }
    } catch { /* non-critical */ }
  }, [dbFile]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!mission || mission.assertions.length === 0) return null;

  const verdict = new Map((report?.results ?? []).map((r) => [r.id, r]));
  const met = (report?.results ?? []).filter((r) => r.status === "met").length;
  const total = mission.assertions.length;

  return (
    <div className="context-section">
      <div className="context-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Mission</span>
        {report && (
          <span style={{ color: report.satisfied ? "var(--green)" : "var(--fg-muted)", fontSize: 11 }}>
            {met}/{total} met{report.round > 0 ? ` · r${report.round}` : ""}
          </span>
        )}
      </div>

      <p style={{ fontSize: 12, color: "var(--fg-muted)", margin: "0 0 0.6rem", lineHeight: 1.5 }}>{mission.intent}</p>

      <div className="mission-assertions" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {mission.assertions.map((a) => {
          const v = verdict.get(a.id);
          const color = v?.status === "met" ? "var(--green)" : v?.status === "partial" ? "var(--yellow)" : v?.status === "unmet" ? "var(--red)" : "var(--fg-muted)";
          return (
            <div key={a.id} style={{ display: "flex", gap: 6, fontSize: 12, lineHeight: 1.45 }} title={v?.evidence || ""}>
              <span style={{ color, flexShrink: 0 }}>{v ? STATUS_GLYPH[v.status] : "·"}</span>
              <span><span style={{ color: "var(--fg-muted)" }}>{a.id}</span> {a.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
