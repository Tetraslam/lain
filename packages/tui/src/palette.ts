// Command palette — a universal, VS-Code-style toolbox for the TUI.
//
// Design goals:
//   • Decoupled: commands are declared against a typed `PaletteHost` (state +
//     action callbacks). The app builds the host; changing app internals can
//     only break the host wiring (caught by the type-checker), never silently
//     break the palette.
//   • Context-aware: each command's `when` decides availability from a snapshot.
//   • Fuzzy: subsequence matching with sensible scoring (consecutive + word
//     boundary + earliness bonuses).
//   • Pure + testable: building, filtering, ranking, and grouping are all pure
//     functions with no renderer/IO dependencies.

/** State snapshot + action callbacks the commands operate on. */
export interface PaletteHost {
  // ---- context snapshot ----
  /** The mode the palette was opened from. */
  context: "home" | "exploring" | "reading" | "graph" | "synthesis";
  hasExploration: boolean;
  hasSelectedNode: boolean;
  selectedNodeTitle: string | null;
  selectedNodeId: string | null;
  isRootSelected: boolean;
  hasCorpus: boolean;
  hasMission: boolean;
  hasSynthesis: boolean;
  branchN: number;

  // ---- actions (the app supplies these) ----
  openNode(): void;
  editNode(): void;
  pruneNode(): void;
  extendNode(): void;
  redirectNode(): void;
  linkNode(): void;
  graphView(): void;
  backToTree(): void;
  scrollTop(): void;
  newExploration(): void;
  openExploration(): void;
  synthesize(): void;
  viewSynthesis(): void;
  resumeExploration(): void;
  viewMission(): void;
  exportMarkdown(): void;
  exportCanvas(): void;
  syncObsidian(): void;
  addCorpus(): void;
  searchCorpus(): void;
  backToHome(): void;
  openSettings(): void;
  checkUpdate(): void;
  help(): void;
  quit(): void;
}

export interface Command {
  id: string;
  title: string;
  group: string;
  icon: string;
  /** Extra search terms (synonyms) not shown but matched. */
  keywords?: string;
  /** Display-only key hint. */
  shortcut?: string;
  /** Availability given the host snapshot. Defaults to always-available. */
  when?: (h: PaletteHost) => boolean;
  run: (h: PaletteHost) => void | Promise<void>;
}

// Group ordering for display (others fall to the end, alphabetically).
export const GROUP_ORDER = ["node", "exploration", "synthesis", "corpus", "navigation", "export", "app"];

/**
 * The full command registry. Pure: depends only on the host's shape, not on
 * any renderer. `when` predicates gate availability per context.
 */
export function allCommands(): Command[] {
  const truncate = (s: string | null, n = 28) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "selected");
  return [
    // ---- node ----
    { id: "node.open", title: "Open node", group: "node", icon: "↵", shortcut: "enter", keywords: "read view",
      when: (h) => h.context === "exploring" && h.hasSelectedNode, run: (h) => h.openNode() },
    { id: "node.edit", title: "Edit node", group: "node", icon: "✎", shortcut: "i", keywords: "modify content write",
      when: (h) => h.context === "reading", run: (h) => h.editNode() },
    { id: "node.extend", title: "Extend node", group: "node", icon: "⑂", shortcut: "e", keywords: "children branch grow more",
      when: (h) => h.hasSelectedNode, run: (h) => h.extendNode() },
    { id: "node.redirect", title: "Redirect node", group: "node", icon: "↻", shortcut: "r", keywords: "regenerate rewrite redo",
      when: (h) => h.hasSelectedNode && !h.isRootSelected, run: (h) => h.redirectNode() },
    { id: "node.prune", title: "Prune node", group: "node", icon: "✕", shortcut: "p", keywords: "delete remove cut",
      when: (h) => h.hasSelectedNode && !h.isRootSelected, run: (h) => h.pruneNode() },
    { id: "node.link", title: "Link node", group: "node", icon: "⊷", keywords: "crosslink connect relate",
      when: (h) => h.hasSelectedNode, run: (h) => h.linkNode() },

    // ---- exploration ----
    { id: "exp.new", title: "New exploration", group: "exploration", icon: "✦", keywords: "create start seed idea",
      run: (h) => h.newExploration() },
    { id: "exp.open", title: "Open exploration…", group: "exploration", icon: "⊟", keywords: "switch load list recent",
      run: (h) => h.openExploration() },
    { id: "exp.resume", title: "Resume exploration", group: "exploration", icon: "▸", keywords: "finish pending continue",
      when: (h) => h.hasExploration, run: (h) => h.resumeExploration() },
    { id: "exp.mission", title: "View mission", group: "exploration", icon: "◎", keywords: "contract assertions validation goal",
      when: (h) => h.hasMission, run: (h) => h.viewMission() },

    // ---- synthesis ----
    { id: "syn.run", title: "Synthesize", group: "synthesis", icon: "✧", shortcut: "y", keywords: "connect patterns contradictions",
      when: (h) => h.hasExploration, run: (h) => h.synthesize() },
    { id: "syn.view", title: "View synthesis", group: "synthesis", icon: "◈", keywords: "annotations results",
      when: (h) => h.hasSynthesis, run: (h) => h.viewSynthesis() },

    // ---- corpus ----
    { id: "corpus.add", title: "Add to corpus", group: "corpus", icon: "⊕", keywords: "ingest source material ground files pdf",
      when: (h) => h.hasExploration, run: (h) => h.addCorpus() },
    { id: "corpus.search", title: "Search corpus", group: "corpus", icon: "⌕", keywords: "retrieve find source",
      when: (h) => h.hasCorpus, run: (h) => h.searchCorpus() },

    // ---- navigation ----
    { id: "nav.graph", title: "Graph view", group: "navigation", icon: "◉", shortcut: "g", keywords: "visualize radial map",
      when: (h) => h.hasExploration && h.context !== "graph", run: (h) => h.graphView() },
    { id: "nav.tree", title: "Back to tree", group: "navigation", icon: "≡", keywords: "list exit graph",
      when: (h) => h.context === "graph" || h.context === "reading", run: (h) => h.backToTree() },
    { id: "nav.top", title: "Scroll to top", group: "navigation", icon: "⤒", keywords: "beginning start",
      when: (h) => h.context === "reading", run: (h) => h.scrollTop() },
    { id: "nav.home", title: "Back to home", group: "navigation", icon: "⌂", keywords: "exit explorations list",
      when: (h) => h.hasExploration, run: (h) => h.backToHome() },

    // ---- export ----
    { id: "exp.md", title: "Export to markdown", group: "export", icon: "⇪", shortcut: "x", keywords: "obsidian save files",
      when: (h) => h.hasExploration, run: (h) => h.exportMarkdown() },
    { id: "exp.canvas", title: "Export to canvas", group: "export", icon: "▦", keywords: "obsidian graph radial",
      when: (h) => h.hasExploration, run: (h) => h.exportCanvas() },
    { id: "exp.sync", title: "Sync with Obsidian", group: "export", icon: "⇄", shortcut: "s", keywords: "bidirectional filesystem",
      when: (h) => h.hasExploration, run: (h) => h.syncObsidian() },

    // ---- app ----
    { id: "app.settings", title: "Settings", group: "app", icon: "⚙", shortcut: ",", keywords: "config preferences provider model api key tokens options",
      run: (h) => h.openSettings() },
    { id: "app.update", title: "Check for updates", group: "app", icon: "↑", keywords: "version upgrade",
      run: (h) => h.checkUpdate() },
    { id: "app.help", title: "Help & keyboard reference", group: "app", icon: "?", shortcut: "?", keywords: "shortcuts keys",
      run: (h) => h.help() },
    { id: "app.quit", title: "Quit lain", group: "app", icon: "⏻", shortcut: "q", keywords: "exit close",
      run: (h) => h.quit() },
  ];
}

/** Commands available in the given context (after `when` filtering). */
export function availableCommands(host: PaletteHost): Command[] {
  return allCommands().filter((c) => (c.when ? c.when(host) : true));
}

export interface FuzzyResult {
  /** Higher is better. */
  score: number;
  /** Matched character indices in the title (for highlighting). */
  positions: number[];
}

/**
 * Subsequence fuzzy match. Returns null if `query` isn't a subsequence of
 * `text`. Scoring rewards consecutive matches, word-boundary starts, and early
 * matches. Matching is done against `text`; `positions` index into `title`.
 */
export function fuzzyMatch(query: string, title: string, extra = ""): FuzzyResult | null {
  if (!query.trim()) return { score: 0, positions: [] };
  const q = query.toLowerCase().replace(/\s+/g, "");
  const text = (title + " " + extra).toLowerCase();
  const titleLen = title.length;

  let qi = 0;
  let score = 0;
  let prev = -2;
  const positions: number[] = [];
  for (let ti = 0; ti < text.length && qi < q.length; ti++) {
    if (text[ti] === q[qi]) {
      let s = 1;
      if (ti === prev + 1) s += 3; // consecutive
      if (ti === 0 || /[\s\-_/]/.test(text[ti - 1])) s += 5; // word boundary
      s += Math.max(0, 4 - ti * 0.1); // earliness
      score += s;
      if (ti < titleLen) positions.push(ti);
      prev = ti;
      qi++;
    }
  }
  return qi === q.length ? { score, positions } : null;
}

export interface RankedCommand {
  command: Command;
  match: FuzzyResult;
}

/** Filter + fuzzy-rank the available commands for a query. */
export function rankCommands(host: PaletteHost, query: string): RankedCommand[] {
  const ranked: RankedCommand[] = [];
  for (const command of availableCommands(host)) {
    const match = fuzzyMatch(query, command.title, `${command.group} ${command.keywords ?? ""}`);
    if (match) ranked.push({ command, match });
  }
  if (query.trim()) {
    // When searching, sort purely by relevance.
    ranked.sort((a, b) => b.match.score - a.match.score);
  } else {
    // Otherwise keep a stable, grouped registry order.
    ranked.sort((a, b) => groupRank(a.command.group) - groupRank(b.command.group));
  }
  return ranked;
}

function groupRank(group: string): number {
  const i = GROUP_ORDER.indexOf(group);
  return i === -1 ? GROUP_ORDER.length : i;
}

/** Group ranked commands into ordered sections (for display when not searching). */
export function groupRanked(ranked: RankedCommand[]): { group: string; items: RankedCommand[] }[] {
  const out: { group: string; items: RankedCommand[] }[] = [];
  for (const r of ranked) {
    let section = out.find((s) => s.group === r.command.group);
    if (!section) { section = { group: r.command.group, items: [] }; out.push(section); }
    section.items.push(r);
  }
  return out;
}
