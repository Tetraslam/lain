import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
} from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { Storage, Graph } from "@lain/core";
import type { LainNode, Exploration, Crosslink } from "@lain/shared";

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
  contentScrollY: number;
}

interface TreeLine {
  nodeId: string;
  prefix: string;
  title: string;
  status: string;
  depth: number;
}

// ============================================================================
// Colors
// ============================================================================

const C = {
  bg: "#1a1a2e",
  panelBg: "#16213e",
  activeBorder: "#00AAFF",
  inactiveBorder: "#444466",
  headerFg: "#00AAFF",
  selectedBg: "#0f3460",
  selectedFg: "#FFFFFF",
  treeFg: "#AABBCC",
  treeDim: "#667788",
  titleFg: "#FFD700",
  metaFg: "#778899",
  contentFg: "#CCDDEE",
  footerFg: "#556677",
  prunedFg: "#884444",
  pendingFg: "#887744",
  crosslinkFg: "#7B68EE",
  breadcrumbFg: "#556688",
  helpBg: "#1a1a2e",
  helpFg: "#AABBCC",
  helpKeyFg: "#FFD700",
};

// ============================================================================
// Main App
// ============================================================================

export async function createApp(dbPath: string): Promise<void> {
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
  const nodeCount = allNodes.filter((n) => n.status === "complete").length;
  const prunedCount = allNodes.filter((n) => n.status === "pruned").length;

  const state: AppState = {
    exploration,
    nodes: allNodes,
    selectedNodeId: root.id,
    treeLines,
    activePanel: "tree",
    showHelp: false,
    contentScrollY: 0,
  };

  const renderer = await createCliRenderer();

  // ---- Layout: container > [header, content-area, footer] ----
  const container = new BoxRenderable(renderer, {
    id: "container",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: C.bg,
  });
  renderer.root.add(container);

  // ---- Header ----
  const header = new BoxRenderable(renderer, {
    id: "header",
    width: "100%",
    height: 3,
    border: true,
    borderStyle: "round",
    borderColor: C.inactiveBorder,
    backgroundColor: C.panelBg,
    justifyContent: "center",
    alignItems: "center",
    paddingLeft: 1,
    paddingRight: 1,
  });
  container.add(header);

  const headerText = new TextRenderable(renderer, {
    id: "header-text",
    content: `lain  ${exploration.name}  |  ${nodeCount} nodes  ${prunedCount > 0 ? `${prunedCount} pruned  ` : ""}|  n=${exploration.n} m=${exploration.m}  |  ${exploration.extension}`,
    fg: C.headerFg,
  });
  header.add(headerText);

  // ---- Content area (tree | node) ----
  const contentArea = new BoxRenderable(renderer, {
    id: "content-area",
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
    marginTop: 1,
  });
  container.add(contentArea);

  // ---- Tree panel (left) ----
  const treePanel = new BoxRenderable(renderer, {
    id: "tree-panel",
    width: "38%",
    height: "100%",
    border: true,
    borderStyle: "round",
    borderColor: C.activeBorder, // starts focused
    backgroundColor: C.panelBg,
    title: " Tree ",
    titleAlignment: "left",
    flexDirection: "column",
    overflow: "hidden",
  });
  contentArea.add(treePanel);

  // Scrollable tree content
  const treeScroll = new ScrollBoxRenderable(renderer, {
    id: "tree-scroll",
    scrollY: true,
    scrollX: false,
    viewportCulling: true,
    scrollbarOptions: {
      trackColor: "#222244",
      thumbColor: "#445566",
    },
  });
  treePanel.add(treeScroll);

  const treeText = new TextRenderable(renderer, {
    id: "tree-text",
    content: renderTree(state),
    fg: C.treeFg,
    width: "100%",
  });
  treeScroll.content.add(treeText);

  // ---- Node panel (right) ----
  const nodePanel = new BoxRenderable(renderer, {
    id: "node-panel",
    flexGrow: 1,
    height: "100%",
    border: true,
    borderStyle: "round",
    borderColor: C.inactiveBorder,
    backgroundColor: C.panelBg,
    title: " Node ",
    titleAlignment: "left",
    marginLeft: 1,
    flexDirection: "column",
    overflow: "hidden",
  });
  contentArea.add(nodePanel);

  // Breadcrumb bar
  const breadcrumb = new TextRenderable(renderer, {
    id: "breadcrumb",
    content: "",
    fg: C.breadcrumbFg,
    width: "100%",
  });
  nodePanel.add(breadcrumb);

  // Scrollable node content
  const nodeScroll = new ScrollBoxRenderable(renderer, {
    id: "node-scroll",
    scrollY: true,
    scrollX: false,
    viewportCulling: true,
    scrollbarOptions: {
      trackColor: "#222244",
      thumbColor: "#445566",
    },
  });
  nodePanel.add(nodeScroll);

  const nodeContent = new TextRenderable(renderer, {
    id: "node-content",
    content: "",
    fg: C.contentFg,
    width: "100%",
  });
  nodeScroll.content.add(nodeContent);

  // ---- Footer ----
  const footer = new BoxRenderable(renderer, {
    id: "footer",
    width: "100%",
    height: 1,
    marginTop: 1,
    paddingLeft: 1,
  });
  container.add(footer);

  const footerText = new TextRenderable(renderer, {
    id: "footer-text",
    content: buildFooterText(state),
    fg: C.footerFg,
  });
  footer.add(footerText);

  // ---- Help overlay (hidden by default) ----
  // We'll toggle visibility by swapping content

  // ---- Initial render ----
  updateNodePanel(state, breadcrumb, nodeContent, graph);

  // ---- Keyboard handling ----
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (state.showHelp) {
      // Any key dismisses help
      state.showHelp = false;
      treeText.content = renderTree(state);
      updateNodePanel(state, breadcrumb, nodeContent, graph);
      footerText.content = buildFooterText(state);
      treePanel.borderColor = state.activePanel === "tree" ? C.activeBorder : C.inactiveBorder;
      nodePanel.borderColor = state.activePanel === "content" ? C.activeBorder : C.inactiveBorder;
      return;
    }

    const currentIdx = state.treeLines.findIndex(
      (l) => l.nodeId === state.selectedNodeId
    );

    switch (key.name) {
      // ---- Navigation ----
      case "up":
      case "k": {
        if (state.activePanel === "tree" && currentIdx > 0) {
          state.selectedNodeId = state.treeLines[currentIdx - 1].nodeId;
          state.contentScrollY = 0;
          treeText.content = renderTree(state);
          updateNodePanel(state, breadcrumb, nodeContent, graph);
          nodeScroll.scrollToTop();
          // Keep selected line visible
          ensureTreeLineVisible(treeScroll, currentIdx - 1, state.treeLines.length);
        } else if (state.activePanel === "content") {
          nodeScroll.scrollBy(0, -3);
        }
        break;
      }
      case "down":
      case "j": {
        if (state.activePanel === "tree" && currentIdx < state.treeLines.length - 1) {
          state.selectedNodeId = state.treeLines[currentIdx + 1].nodeId;
          state.contentScrollY = 0;
          treeText.content = renderTree(state);
          updateNodePanel(state, breadcrumb, nodeContent, graph);
          nodeScroll.scrollToTop();
          ensureTreeLineVisible(treeScroll, currentIdx + 1, state.treeLines.length);
        } else if (state.activePanel === "content") {
          nodeScroll.scrollBy(0, 3);
        }
        break;
      }

      // ---- Panel switching ----
      case "tab":
      case "h":
      case "l": {
        if (key.name === "tab" || (key.name === "l" && state.activePanel === "tree") || (key.name === "h" && state.activePanel === "content")) {
          state.activePanel = state.activePanel === "tree" ? "content" : "tree";
          treePanel.borderColor = state.activePanel === "tree" ? C.activeBorder : C.inactiveBorder;
          nodePanel.borderColor = state.activePanel === "content" ? C.activeBorder : C.inactiveBorder;
          footerText.content = buildFooterText(state);
        }
        break;
      }

      // ---- Enter: focus on content panel for selected node ----
      case "return": {
        state.activePanel = "content";
        treePanel.borderColor = C.inactiveBorder;
        nodePanel.borderColor = C.activeBorder;
        nodeScroll.scrollToTop();
        footerText.content = buildFooterText(state);
        break;
      }

      // ---- Tree navigation shortcuts ----
      case "g": {
        // Go to top
        if (state.activePanel === "tree" && state.treeLines.length > 0) {
          state.selectedNodeId = state.treeLines[0].nodeId;
          treeText.content = renderTree(state);
          updateNodePanel(state, breadcrumb, nodeContent, graph);
          treeScroll.scrollToTop();
          nodeScroll.scrollToTop();
        }
        break;
      }

      // Shift+G or 'G' — go to bottom (uppercase)
      // OpenTUI sends shift+g as key.name="g" key.shift=true

      // ---- Help ----
      case "?": {
        state.showHelp = true;
        nodeContent.content = buildHelpText();
        breadcrumb.content = "Help";
        nodePanel.borderColor = C.activeBorder;
        treePanel.borderColor = C.inactiveBorder;
        footerText.content = " Press any key to dismiss";
        break;
      }

      // ---- Quit ----
      case "q":
      case "escape": {
        storage.close();
        renderer.destroy();
        process.exit(0);
      }
    }
  });
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
  const statusTag =
    node.status === "pruned"
      ? " [x]"
      : node.status === "pending"
        ? " [?]"
        : "";

  lines.push({
    nodeId: node.id,
    prefix: prefix + connector,
    title: node.title || node.id,
    status: statusTag,
    depth: node.depth,
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
      const isPruned = line.status === " [x]";
      const isPending = line.status === " [?]";

      // Truncate title if needed (rough estimate — real width depends on terminal)
      const maxTitleLen = 35;
      let title = line.title;
      if (title.length > maxTitleLen) {
        title = title.slice(0, maxTitleLen - 1) + "…";
      }

      const marker = selected ? " ▸ " : "   ";
      const text = `${marker}${line.prefix}${title}${line.status}`;
      return text;
    })
    .join("\n");
}

function ensureTreeLineVisible(
  scrollBox: ScrollBoxRenderable,
  lineIdx: number,
  totalLines: number
): void {
  // Each tree line is ~1 row. Scroll to keep the selected line near the middle.
  // This is approximate since we don't know exact viewport height.
  const approxViewport = 15;
  const targetScroll = Math.max(0, lineIdx - Math.floor(approxViewport / 2));
  scrollBox.scrollTo(0, targetScroll);
}

// ============================================================================
// Node panel rendering
// ============================================================================

function updateNodePanel(
  state: AppState,
  breadcrumbEl: TextRenderable,
  contentEl: TextRenderable,
  graph: Graph
): void {
  const node = graph.getNode(state.selectedNodeId);
  if (!node) return;

  // Breadcrumb: root > parent > ... > current
  const ancestors = graph.getAncestorChain(state.selectedNodeId);
  const crumbs = [...ancestors, node]
    .map((n) => {
      const name = n.title || n.id;
      return name.length > 20 ? name.slice(0, 19) + "…" : name;
    })
    .join(" > ");
  breadcrumbEl.content = crumbs;

  // Build full content
  const parts: string[] = [];

  // Title
  parts.push(node.title || node.id);
  parts.push("─".repeat(Math.min(60, (node.title || node.id).length)));
  parts.push("");

  // Metadata
  parts.push(`ID: ${node.id}`);
  parts.push(`Depth: ${node.depth}  |  Branch: ${node.branchIndex}  |  Status: ${node.status}`);
  if (node.model) parts.push(`Model: ${node.model} (${node.provider})`);
  if (node.planSummary) {
    parts.push("");
    parts.push(`Direction: ${node.planSummary}`);
  }
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
    parts.push("Cross-links:");
    for (const cl of crosslinks) {
      const otherId = cl.sourceId === node.id ? cl.targetId : cl.sourceId;
      const otherNode = graph.getNode(otherId);
      const otherName = otherNode?.title || otherId;
      parts.push(`  → ${otherName}${cl.label ? ` (${cl.label})` : ""}`);
    }
  }

  // Children summary
  const children = state.nodes.filter(
    (n) => n.parentId === node.id && n.status !== "pruned"
  );
  if (children.length > 0) {
    parts.push("");
    parts.push(`Children (${children.length}):`);
    for (const child of children) {
      parts.push(`  ${child.branchIndex}. ${child.title || child.id}`);
    }
  }

  contentEl.content = parts.join("\n");
}

// ============================================================================
// Footer
// ============================================================================

function buildFooterText(state: AppState): string {
  if (state.activePanel === "tree") {
    return " j/k navigate  |  enter view  |  tab switch panel  |  ? help  |  q quit";
  }
  return " j/k scroll  |  tab switch panel  |  ? help  |  q quit";
}

// ============================================================================
// Help
// ============================================================================

function buildHelpText(): string {
  return [
    "lain TUI — Keyboard Shortcuts",
    "═".repeat(40),
    "",
    "Navigation",
    "  j / ↓        Move down in tree / scroll content",
    "  k / ↑        Move up in tree / scroll content",
    "  g            Jump to top of tree",
    "  enter        Switch to content panel",
    "  tab          Toggle between tree and content panels",
    "  h / l        Switch panels (vim-style)",
    "",
    "General",
    "  ?            Show this help",
    "  q / esc      Quit",
    "",
    "Panels",
    "  Left panel   Tree view — navigate the exploration graph",
    "  Right panel  Node details — content, metadata, cross-links",
    "",
    "The active panel has a blue border.",
    "In tree mode, j/k moves the selection.",
    "In content mode, j/k scrolls the text.",
  ].join("\n");
}
