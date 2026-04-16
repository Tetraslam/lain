import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
} from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { Storage, Graph } from "@lain/core";
import type { LainNode, Exploration, Crosslink } from "@lain/shared";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Theme — inherits terminal bg/fg, accents from Tokyo Night purple family
// ============================================================================

const theme = {
  // We don't set background — let the terminal's own bg show through.
  // This makes lain look native in any Tokyo Night / dark terminal.
  accent: "#bb9af7",        // purple — primary accent (borders, highlights)
  accentDim: "#7c6ea3",     // muted purple — inactive accents
  secondary: "#7aa2f7",     // blue — secondary accent (links, metadata keys)
  tertiary: "#0db9d7",      // cyan — tertiary (breadcrumbs, node IDs)

  fg: "#a9b1d6",            // terminal fg — main text
  fgBright: "#c0caf5",      // brighter fg — titles, selected text
  fgDim: "#565f89",         // dim fg — metadata values, hints
  fgMuted: "#3b3f5c",       // very dim — separators, tree connectors

  selected: "#292e42",      // subtle highlight bg for selected row
  panelBorder: "#32344a",   // inactive panel border (from palette[0])

  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  orange: "#ff9e64",
};

// ============================================================================
// State
// ============================================================================

interface AppState {
  exploration: Exploration;
  nodes: LainNode[];
  selectedNodeId: string;
  treeLines: TreeLine[];
  activePanel: "tree" | "content";
  showHelp: boolean;
}

interface TreeLine {
  nodeId: string;
  display: string; // pre-rendered line
  depth: number;
  isPruned: boolean;
  isPending: boolean;
}

// ============================================================================
// Smart DB discovery
// ============================================================================

function findDbFile(arg?: string): string {
  if (arg && fs.existsSync(arg)) return arg;

  // Search current directory for .db files
  const cwd = process.cwd();
  const dbFiles = fs.readdirSync(cwd).filter((f) => f.endsWith(".db"));

  if (dbFiles.length === 1) return path.resolve(dbFiles[0]);
  if (dbFiles.length > 1) {
    // Pick the most recently modified
    const sorted = dbFiles
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(cwd, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return path.resolve(sorted[0].name);
  }

  // Search parent directories
  let dir = cwd;
  for (let i = 0; i < 5; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".db"));
    if (files.length > 0) {
      const sorted = files
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      return path.join(dir, sorted[0].name);
    }
  }

  throw new Error(
    "No .db file found. Usage: lain-tui [file.db] or run from a directory containing one."
  );
}

// ============================================================================
// Main App
// ============================================================================

export async function createApp(dbPathArg?: string): Promise<void> {
  const dbPath = findDbFile(dbPathArg);
  const storage = new Storage(dbPath);
  const graph = new Graph(storage);

  const explorations = graph.getAllExplorations();
  if (explorations.length === 0) {
    storage.close();
    throw new Error("No explorations in this database.");
  }

  const exploration = explorations[0];
  const allNodes = graph.getAllNodes(exploration.id);
  const root = allNodes.find((n) => n.parentId === null);
  if (!root) {
    storage.close();
    throw new Error("No root node found.");
  }

  const treeLines = buildTreeLines(root, allNodes);
  const nodeCount = allNodes.filter((n) => n.status !== "pruned").length;

  const state: AppState = {
    exploration,
    nodes: allNodes,
    selectedNodeId: root.id,
    treeLines,
    activePanel: "tree",
    showHelp: false,
  };

  const renderer = await createCliRenderer();

  // Set terminal title
  const shortName = exploration.name.length > 40
    ? exploration.name.slice(0, 37) + "..."
    : exploration.name;
  renderer.setTerminalTitle(`lain — ${shortName}`);

  // ---- Root container ----
  const container = new BoxRenderable(renderer, {
    id: "container",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
  });
  renderer.root.add(container);

  // ---- Header ----
  const header = new BoxRenderable(renderer, {
    id: "header",
    width: "100%",
    height: 1,
    flexDirection: "row",
    marginTop: 1,
    marginBottom: 1,
  });
  container.add(header);

  const headerText = new TextRenderable(renderer, {
    id: "header-text",
    content: `  lain  ${shortName}  ·  ${nodeCount} nodes  ·  n=${exploration.n} m=${exploration.m}  ·  ${exploration.extension}`,
    fg: theme.fgDim,
  });
  header.add(headerText);

  // ---- Content area ----
  const contentArea = new BoxRenderable(renderer, {
    id: "content-area",
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
    gap: 2,
  });
  container.add(contentArea);

  // ---- Tree panel ----
  const treePanel = new BoxRenderable(renderer, {
    id: "tree-panel",
    width: "35%",
    height: "100%",
    border: true,
    borderStyle: "round",
    borderColor: theme.accent,
    title: " tree ",
    titleAlignment: "left",
    flexDirection: "column",
    overflow: "hidden",
    paddingLeft: 1,
  });
  contentArea.add(treePanel);

  const treeScroll = new ScrollBoxRenderable(renderer, {
    id: "tree-scroll",
    scrollY: true,
    scrollX: false,
    viewportCulling: true,
    scrollbarOptions: {
      trackColor: theme.panelBorder,
      thumbColor: theme.accentDim,
    },
  });
  treePanel.add(treeScroll);

  const treeText = new TextRenderable(renderer, {
    id: "tree-text",
    content: renderTree(state),
    fg: theme.fg,
    width: "100%",
  });
  treeScroll.content.add(treeText);

  // ---- Node panel ----
  const nodePanel = new BoxRenderable(renderer, {
    id: "node-panel",
    flexGrow: 1,
    height: "100%",
    border: true,
    borderStyle: "round",
    borderColor: theme.panelBorder,
    title: " node ",
    titleAlignment: "left",
    flexDirection: "column",
    overflow: "hidden",
    paddingLeft: 1,
    paddingRight: 1,
  });
  contentArea.add(nodePanel);

  const nodeScroll = new ScrollBoxRenderable(renderer, {
    id: "node-scroll",
    scrollY: true,
    scrollX: false,
    viewportCulling: true,
    scrollbarOptions: {
      trackColor: theme.panelBorder,
      thumbColor: theme.accentDim,
    },
  });
  nodePanel.add(nodeScroll);

  const nodeContent = new TextRenderable(renderer, {
    id: "node-content",
    content: "",
    fg: theme.fg,
    width: "100%",
  });
  nodeScroll.content.add(nodeContent);

  // ---- Footer ----
  const footer = new BoxRenderable(renderer, {
    id: "footer",
    width: "100%",
    height: 1,
    marginTop: 1,
    marginBottom: 1,
    paddingLeft: 2,
  });
  container.add(footer);

  const footerText = new TextRenderable(renderer, {
    id: "footer-text",
    content: buildFooter(state),
    fg: theme.fgMuted,
  });
  footer.add(footerText);

  // ---- Initial render ----
  updateNodePanel(state, nodeContent, graph);
  updatePanelBorders(state, treePanel, nodePanel);

  // ---- Keyboard ----
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (state.showHelp) {
      state.showHelp = false;
      treeText.content = renderTree(state);
      updateNodePanel(state, nodeContent, graph);
      updatePanelBorders(state, treePanel, nodePanel);
      footerText.content = buildFooter(state);
      return;
    }

    const currentIdx = state.treeLines.findIndex(
      (l) => l.nodeId === state.selectedNodeId
    );

    switch (key.name) {
      // ---- Vertical navigation ----
      case "up":
      case "k": {
        if (state.activePanel === "tree" && currentIdx > 0) {
          state.selectedNodeId = state.treeLines[currentIdx - 1].nodeId;
          treeText.content = renderTree(state);
          updateNodePanel(state, nodeContent, graph);
          nodeScroll.scrollToTop();
          ensureLineVisible(treeScroll, currentIdx - 1);
        } else if (state.activePanel === "content") {
          nodeScroll.scrollBy(0, -2);
        }
        break;
      }
      case "down":
      case "j": {
        if (state.activePanel === "tree" && currentIdx < state.treeLines.length - 1) {
          state.selectedNodeId = state.treeLines[currentIdx + 1].nodeId;
          treeText.content = renderTree(state);
          updateNodePanel(state, nodeContent, graph);
          nodeScroll.scrollToTop();
          ensureLineVisible(treeScroll, currentIdx + 1);
        } else if (state.activePanel === "content") {
          nodeScroll.scrollBy(0, 2);
        }
        break;
      }

      // ---- Panel switching ----
      case "tab": {
        state.activePanel = state.activePanel === "tree" ? "content" : "tree";
        updatePanelBorders(state, treePanel, nodePanel);
        footerText.content = buildFooter(state);
        break;
      }
      case "left": {
        if (state.activePanel === "content") {
          state.activePanel = "tree";
          updatePanelBorders(state, treePanel, nodePanel);
          footerText.content = buildFooter(state);
        }
        break;
      }
      case "right": {
        if (state.activePanel === "tree") {
          state.activePanel = "content";
          updatePanelBorders(state, treePanel, nodePanel);
          footerText.content = buildFooter(state);
        }
        break;
      }

      // ---- Enter: open content panel ----
      case "return": {
        state.activePanel = "content";
        updatePanelBorders(state, treePanel, nodePanel);
        nodeScroll.scrollToTop();
        footerText.content = buildFooter(state);
        break;
      }

      // ---- Jump to top/bottom ----
      case "g": {
        if (state.activePanel === "tree" && state.treeLines.length > 0) {
          state.selectedNodeId = state.treeLines[0].nodeId;
          treeText.content = renderTree(state);
          updateNodePanel(state, nodeContent, graph);
          treeScroll.scrollToTop();
          nodeScroll.scrollToTop();
        } else if (state.activePanel === "content") {
          nodeScroll.scrollToTop();
        }
        break;
      }

      // ---- Help ----
      case "?": {
        state.showHelp = true;
        nodeContent.content = buildHelpContent();
        nodePanel.title = " help ";
        nodePanel.borderColor = theme.accent;
        treePanel.borderColor = theme.panelBorder;
        footerText.content = "  press any key to dismiss";
        nodeScroll.scrollToTop();
        break;
      }

      // ---- Quit ----
      case "q": {
        storage.close();
        renderer.setTerminalTitle("");
        renderer.destroy();
        process.exit(0);
        break;
      }
      case "escape": {
        if (state.activePanel === "content") {
          // Escape in content panel goes back to tree
          state.activePanel = "tree";
          updatePanelBorders(state, treePanel, nodePanel);
          footerText.content = buildFooter(state);
        } else {
          storage.close();
          renderer.setTerminalTitle("");
          renderer.destroy();
          process.exit(0);
        }
        break;
      }
    }
  });
}

// ============================================================================
// Panel border management
// ============================================================================

function updatePanelBorders(
  state: AppState,
  treePanel: BoxRenderable,
  nodePanel: BoxRenderable
): void {
  treePanel.borderColor = state.activePanel === "tree" ? theme.accent : theme.panelBorder;
  nodePanel.borderColor = state.activePanel === "content" ? theme.accent : theme.panelBorder;
  nodePanel.title = " node ";
}

// ============================================================================
// Tree rendering
// ============================================================================

function buildTreeLines(
  node: LainNode,
  allNodes: LainNode[],
  prefix = "",
  isLast = true,
  isRoot = true
): TreeLine[] {
  const lines: TreeLine[] = [];
  const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";

  const maxTitle = 30;
  let title = node.title || node.id;
  if (title.length > maxTitle) {
    title = title.slice(0, maxTitle - 1) + "…";
  }

  lines.push({
    nodeId: node.id,
    display: `${prefix}${connector}${title}`,
    depth: node.depth,
    isPruned: node.status === "pruned",
    isPending: node.status === "pending",
  });

  const children = allNodes
    .filter((n) => n.parentId === node.id)
    .sort((a, b) => a.branchIndex - b.branchIndex);

  const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");

  children.forEach((child, i) => {
    lines.push(
      ...buildTreeLines(child, allNodes, childPrefix, i === children.length - 1, false)
    );
  });

  return lines;
}

function renderTree(state: AppState): string {
  return state.treeLines
    .map((line) => {
      const selected = line.nodeId === state.selectedNodeId;
      const marker = selected ? "▸ " : "  ";
      return `${marker}${line.display}`;
    })
    .join("\n");
}

function ensureLineVisible(
  scrollBox: ScrollBoxRenderable,
  lineIdx: number
): void {
  const targetScroll = Math.max(0, lineIdx - 8);
  scrollBox.scrollTo(0, targetScroll);
}

// ============================================================================
// Node content rendering
// ============================================================================

function updateNodePanel(
  state: AppState,
  contentEl: TextRenderable,
  graph: Graph
): void {
  const node = graph.getNode(state.selectedNodeId);
  if (!node) return;

  const parts: string[] = [];

  // Breadcrumb
  const ancestors = graph.getAncestorChain(state.selectedNodeId);
  if (ancestors.length > 0) {
    const crumbs = [...ancestors, node]
      .map((n) => {
        const name = n.title || n.id;
        return name.length > 18 ? name.slice(0, 17) + "…" : name;
      });
    parts.push(crumbs.join("  >  "));
    parts.push("");
  }

  // Title
  parts.push(node.title || node.id);
  parts.push("─".repeat(Math.min(50, (node.title || node.id).length)));
  parts.push("");

  // Metadata block
  const meta: string[] = [];
  meta.push(`id       ${node.id}`);
  meta.push(`depth    ${node.depth}  ·  branch ${node.branchIndex}  ·  ${node.status}`);
  if (node.model) meta.push(`model    ${node.model} (${node.provider})`);
  if (node.planSummary) meta.push(`direction  ${node.planSummary}`);
  parts.push(meta.join("\n"));
  parts.push("");

  // Content
  if (node.content) {
    parts.push(node.content);
  } else {
    parts.push("(no content)");
  }

  // Cross-links
  const crosslinks = graph.getCrosslinksForNode(node.id);
  if (crosslinks.length > 0) {
    parts.push("");
    parts.push("cross-links");
    for (const cl of crosslinks) {
      const otherId = cl.sourceId === node.id ? cl.targetId : cl.sourceId;
      const otherNode = graph.getNode(otherId);
      const otherName = otherNode?.title || otherId;
      parts.push(`  → ${otherName}${cl.label ? ` — ${cl.label}` : ""}`);
    }
  }

  // Children
  const children = state.nodes.filter(
    (n) => n.parentId === node.id && n.status !== "pruned"
  );
  if (children.length > 0) {
    parts.push("");
    parts.push(`children (${children.length})`);
    for (const child of children) {
      parts.push(`  ${child.branchIndex}. ${child.title || child.id}`);
    }
  }

  contentEl.content = parts.join("\n");
}

// ============================================================================
// Footer
// ============================================================================

function buildFooter(state: AppState): string {
  if (state.activePanel === "tree") {
    return "  j/k navigate  ·  enter/→ view  ·  tab switch  ·  ? help  ·  q quit";
  }
  return "  j/k scroll  ·  esc/← back  ·  tab switch  ·  g top  ·  ? help  ·  q quit";
}

// ============================================================================
// Help
// ============================================================================

function buildHelpContent(): string {
  return [
    "lain — keyboard reference",
    "═".repeat(30),
    "",
    "tree panel",
    "  j / ↓         next node",
    "  k / ↑         previous node",
    "  g             jump to root",
    "  enter / →     open node in content panel",
    "",
    "content panel",
    "  j / ↓         scroll down",
    "  k / ↑         scroll up",
    "  g             scroll to top",
    "  esc / ←       back to tree",
    "",
    "general",
    "  tab           switch panels",
    "  ← / →         switch panels",
    "  ?             this help",
    "  q             quit",
  ].join("\n");
}
