import React from "react";

const SHORTCUTS: [string, string][] = [
  ["j/k ↑↓", "navigate nodes"],
  ["h/l ←→", "siblings"],
  ["e", "extend (add children)"],
  ["r", "redirect (regenerate)"],
  ["i", "edit node content"],
  ["p", "prune node + descendants"],
  ["g", "toggle graph overlay"],
  ["s", "toggle synthesis panel"],
  ["c", "toggle corpus / sources"],
  ["b", "toggle sidebar"],
  ["?", "this help"],
  ["esc", "close overlay / go back"],
];

/** Keyboard shortcut reference overlay. */
export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
        <h2 className="modal-title">Keyboard shortcuts</h2>
        <div style={{ fontSize: 13, lineHeight: 2, fontFamily: "var(--font-mono)" }}>
          {SHORTCUTS.map(([key, desc]) => (
            <div key={key}><strong>{key}</strong> — {desc}</div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
