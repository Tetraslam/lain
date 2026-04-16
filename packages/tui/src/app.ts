import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  MarkdownRenderable,
} from "@opentui/core";
import { t, fg, dim, bold, italic, underline } from "@opentui/core";
import type { KeyEvent, SelectOption } from "@opentui/core";
import { Storage, Graph } from "@lain/core";
import type { LainNode, Exploration, Crosslink } from "@lain/shared";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Theme — Tokyo Night palette, no forced backgrounds
// ============================================================================

const c = {
  accent:     "#bb9af7",   // purple — active borders, selection marker
  accentDim:  "#7c6ea3",   // muted purple
  blue:       "#7aa2f7",   // metadata keys, links
  cyan:       "#0db9d7",   // IDs, breadcrumb separators
  bright:     "#c0caf5",   // titles, selected text
  fg:         "#a9b1d6",   // body text
  dim:        "#565f89",   // metadata values, footer, connectors
  muted:      "#3b3f5c",   // borders, separators
  surface:    "#292e42",   // selected row bg
  red:        "#f7768e",
  green:      "#9ece6a",
  yellow:     "#e0af68",
  orange:     "#ff9e64",
};

// ============================================================================
// State
// ============================================================================

type AppMode = "picker" | "exploring" | "reading" | "help";

interface AppState {
  mode: AppMode;
  previousMode: AppMode;
  exploration: Exploration | null;
  nodes: LainNode[];
  treeOptions: TreeItem[];
  selectedIdx: number;
  termWidth: number;
  termHeight: number;
}

interface TreeItem {
  nodeId: string;
  prefix: string;  // tree connectors
  title: string;   // node title
  depth: number;
  status: string;
  node: LainNode;
}

// ============================================================================
// DB Discovery
// ============================================================================

function discoverDbFiles(startDir: string): string[] {
  const results: string[] = [];
  const search = (dir: string, depth: number) => {
    if (depth > 3) return;
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.endsWith(".db")) {
          const full = path.join(dir, entry);
          try {
            // Verify it's a lain db
            const s = new Storage(full);
            const exps = new Graph(s).getAllExplorations();
            s.close();
            if (exps.length > 0) results.push(full);
          } catch {}
        }
      }
    } catch {}
  };

  let dir = startDir;
  for (let i = 0; i < 4; i++) {
    search(dir, i);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return results;
}

// ============================================================================
// Tree Builder
// ============================================================================

function buildTreeItems(
  node: LainNode,
  allNodes: LainNode[],
  prefix = "",
  isLast = true,
  isRoot = true
): TreeItem[] {
  const items: TreeItem[] = [];
  const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";

  items.push({
    nodeId: node.id,
    prefix: prefix + connector,
    title: node.title || node.id,
    depth: node.depth,
    status: node.status,
    node,
  });

  const children = allNodes
    .filter((n) => n.parentId === node.id)
    .sort((a, b) => a.branchIndex - b.branchIndex);

  const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");

  children.forEach((child, i) => {
    items.push(
      ...buildTreeItems(child, allNodes, childPrefix, i === children.length - 1, false)
    );
  });

  return items;
}

// ============================================================================
// Content Builder
// ============================================================================

function buildNodeContent(node: LainNode, graph: Graph, allNodes: LainNode[]): string {
  const parts: string[] = [];

  // Breadcrumb
  const ancestors = graph.getAncestorChain(node.id);
  if (ancestors.length > 0) {
    const crumbs = [...ancestors, node].map((n) => {
      const name = n.title || n.id;
      return name.length > 25 ? name.slice(0, 24) + "…" : name;
    });
    parts.push(crumbs.join("  ›  "));
    parts.push("");
  }

  // Title
  parts.push(`# ${node.title || node.id}`);
  parts.push("");

  // Metadata
  parts.push(`**id** ${node.id}  ·  **depth** ${node.depth}  ·  **branch** ${node.branchIndex}  ·  ${node.status}`);
  if (node.model) parts.push(`**model** ${node.model} (${node.provider})`);
  if (node.planSummary) parts.push(`**direction** ${node.planSummary}`);
  parts.push("");

  // Content
  if (node.content) {
    parts.push(node.content);
  } else {
    parts.push("*no content*");
  }

  // Cross-links
  const crosslinks = graph.getCrosslinksForNode(node.id);
  if (crosslinks.length > 0) {
    parts.push("");
    parts.push("---");
    parts.push("**cross-links**");
    for (const cl of crosslinks) {
      const otherId = cl.sourceId === node.id ? cl.targetId : cl.sourceId;
      const otherNode = graph.getNode(otherId);
      const otherName = otherNode?.title || otherId;
      parts.push(`- → ${otherName}${cl.label ? ` — *${cl.label}*` : ""}`);
    }
  }

  // Children
  const children = allNodes.filter(
    (n) => n.parentId === node.id && n.status !== "pruned"
  );
  if (children.length > 0) {
    parts.push("");
    parts.push("---");
    parts.push(`**children** (${children.length})`);
    for (const child of children) {
      parts.push(`${child.branchIndex}. ${child.title || child.id}`);
    }
  }

  return parts.join("\n");
}

// ============================================================================
// Main App
// ============================================================================

export async function createApp(dbPathArg?: string): Promise<void> {
  // ---- Discover and load ----
  let dbPath: string;
  let storage: Storage;
  let graph: Graph;
  let exploration: Exploration;
  let allNodes: LainNode[];

  if (dbPathArg && fs.existsSync(dbPathArg)) {
    dbPath = dbPathArg;
  } else {
    const found = discoverDbFiles(process.cwd());
    if (found.length === 0) {
      throw new Error("No lain .db files found. Run from a directory with explorations, or pass a path.");
    }
    dbPath = found[0]; // We'll add a picker later if multiple
  }

  storage = new Storage(dbPath);
  graph = new Graph(storage);
  const explorations = graph.getAllExplorations();
  if (explorations.length === 0) {
    storage.close();
    throw new Error("No explorations in this database.");
  }
  exploration = explorations[0];
  allNodes = graph.getAllNodes(exploration.id);

  const root = allNodes.find((n) => n.parentId === null);
  if (!root) { storage.close(); throw new Error("No root node."); }

  const treeItems = buildTreeItems(root, allNodes);
  const nodeCount = allNodes.filter((n) => n.status !== "pruned").length;

  // ---- Renderer ----
  const renderer = await createCliRenderer();
  const termW = renderer.width ?? 80;
  const termH = renderer.height ?? 24;

  const shortName = exploration.name.length > 50
    ? exploration.name.slice(0, 47) + "…"
    : exploration.name;
  renderer.setTerminalTitle(`lain — ${shortName}`);

  const state: AppState = {
    mode: "exploring",
    previousMode: "exploring",
    exploration,
    nodes: allNodes,
    treeOptions: treeItems,
    selectedIdx: 0,
    termWidth: termW,
    termHeight: termH,
  };

  // ---- Adaptive layout ----
  const treePanelWidth = termW < 100 ? Math.floor(termW * 0.4) : termW < 160 ? 44 : 54;

  // ---- Root ----
  const rootBox = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
  });
  renderer.root.add(rootBox);

  // ---- Header ----
  const headerBox = new BoxRenderable(renderer, {
    id: "header",
    width: "100%",
    height: 1,
    marginTop: 1,
    marginBottom: 1,
  });
  rootBox.add(headerBox);

  const headerText = new TextRenderable(renderer, {
    id: "header-text",
    content: t`  ${fg(c.accent)("lain")}  ${dim(shortName)}  ${fg(c.muted)("·")}  ${dim(`${nodeCount} nodes`)}  ${fg(c.muted)("·")}  ${dim(`n=${exploration.n} m=${exploration.m}`)}  ${fg(c.muted)("·")}  ${dim(exploration.extension)}`,
  });
  headerBox.add(headerText);

  // ---- Content area (tree + node) ----
  const contentArea = new BoxRenderable(renderer, {
    id: "content-area",
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
  });
  rootBox.add(contentArea);

  // ---- Tree panel ----
  const treePanel = new BoxRenderable(renderer, {
    id: "tree-panel",
    width: treePanelWidth,
    height: "100%",
    border: true,
    borderStyle: "round",
    borderColor: c.accent,
    flexDirection: "column",
    overflow: "hidden",
  });
  contentArea.add(treePanel);

  // Build Select options from tree items
  const selectOpts: SelectOption[] = treeItems.map((item) => {
    const maxTitle = treePanelWidth - item.prefix.length - 6;
    let title = item.title;
    if (title.length > maxTitle && maxTitle > 5) {
      title = title.slice(0, maxTitle - 1) + "…";
    }
    return {
      name: `${item.prefix}${title}`,
      description: "",
      value: item.nodeId,
    };
  });

  const treeSelect = new SelectRenderable(renderer, {
    id: "tree-select",
    options: selectOpts,
    selectedIndex: 0,
    backgroundColor: "transparent",
    textColor: c.dim,
    focusedBackgroundColor: "transparent",
    focusedTextColor: c.dim,
    selectedBackgroundColor: c.surface,
    selectedTextColor: c.bright,
    showDescription: false,
    showScrollIndicator: true,
    wrapSelection: false,
    focusable: true,
    itemSpacing: 0,
  });
  treePanel.add(treeSelect);
  treeSelect.focus();

  // ---- Node panel ----
  const nodePanel = new BoxRenderable(renderer, {
    id: "node-panel",
    flexGrow: 1,
    height: "100%",
    border: true,
    borderStyle: "round",
    borderColor: c.muted,
    flexDirection: "column",
    overflow: "hidden",
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1,
  });
  contentArea.add(nodePanel);

  const nodeScroll = new ScrollBoxRenderable(renderer, {
    id: "node-scroll",
    scrollY: true,
    scrollX: false,
    viewportCulling: true,
    scrollbarOptions: {
      trackColor: c.muted,
      thumbColor: c.accentDim,
    },
  });
  nodePanel.add(nodeScroll);

  const nodeMarkdown = new MarkdownRenderable(renderer, {
    id: "node-md",
    content: buildNodeContent(root, graph, allNodes),
  });
  nodeScroll.content.add(nodeMarkdown);

  // ---- Footer ----
  const footerBox = new BoxRenderable(renderer, {
    id: "footer",
    width: "100%",
    height: 1,
    marginTop: 1,
    marginBottom: 1,
    paddingLeft: 2,
  });
  rootBox.add(footerBox);

  const footerText = new TextRenderable(renderer, {
    id: "footer-text",
    content: t`  ${dim("j/k")} navigate  ${fg(c.muted)("·")}  ${dim("enter/→")} open  ${fg(c.muted)("·")}  ${dim("?")} help  ${fg(c.muted)("·")}  ${dim("q")} quit`,
  });
  footerBox.add(footerText);

  // ---- Update content when selection changes ----
  function onSelectionChanged() {
    const idx = treeSelect.getSelectedIndex();
    const item = treeItems[idx];
    if (!item) return;
    state.selectedIdx = idx;

    const node = graph.getNode(item.nodeId);
    if (!node) return;

    nodeMarkdown.content = buildNodeContent(node, graph, allNodes);
    nodeScroll.scrollToTop();
  }

  treeSelect.on(SelectRenderableEvents.SELECTION_CHANGED, onSelectionChanged);

  // ---- Update footer and borders for mode changes ----
  function updateMode(newMode: AppMode) {
    state.previousMode = state.mode;
    state.mode = newMode;

    if (newMode === "exploring") {
      treePanel.borderColor = c.accent;
      nodePanel.borderColor = c.muted;
      treeSelect.focus();
      footerText.content = t`  ${dim("j/k")} navigate  ${fg(c.muted)("·")}  ${dim("enter/→")} open  ${fg(c.muted)("·")}  ${dim("?")} help  ${fg(c.muted)("·")}  ${dim("q")} quit`;
    } else if (newMode === "reading") {
      treePanel.borderColor = c.muted;
      nodePanel.borderColor = c.accent;
      footerText.content = t`  ${dim("j/k")} scroll  ${fg(c.muted)("·")}  ${dim("esc/←")} back  ${fg(c.muted)("·")}  ${dim("g")} top  ${fg(c.muted)("·")}  ${dim("G")} bottom  ${fg(c.muted)("·")}  ${dim("?")} help`;
    } else if (newMode === "help") {
      nodePanel.borderColor = c.accent;
      treePanel.borderColor = c.muted;
      nodeMarkdown.content = HELP_TEXT;
      nodeScroll.scrollToTop();
      footerText.content = t`  ${dim("press any key to dismiss")}`;
    }
  }

  // ---- Keyboard ----
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    // Help dismissal
    if (state.mode === "help") {
      const item = treeItems[state.selectedIdx];
      const node = item ? graph.getNode(item.nodeId) : null;
      if (node) nodeMarkdown.content = buildNodeContent(node, graph, allNodes);
      updateMode(state.previousMode);
      return;
    }

    // ---- Exploring mode (tree focused) ----
    if (state.mode === "exploring") {
      switch (key.name) {
        case "return":
        case "right":
          updateMode("reading");
          return;
        case "tab":
          updateMode("reading");
          return;
        case "?":
          updateMode("help");
          return;
        case "q":
          cleanup();
          return;
        case "escape":
          cleanup();
          return;
        // Let SelectRenderable handle j/k/up/down internally
      }
      return;
    }

    // ---- Reading mode (content focused) ----
    if (state.mode === "reading") {
      switch (key.name) {
        case "j":
        case "down":
          nodeScroll.scrollBy(0, 2);
          return;
        case "k":
        case "up":
          nodeScroll.scrollBy(0, -2);
          return;
        case "d":
          nodeScroll.scrollBy(0, 10);
          return;
        case "u":
          nodeScroll.scrollBy(0, -10);
          return;
        case "g":
          nodeScroll.scrollToTop();
          return;
        case "escape":
        case "left":
        case "h":
          updateMode("exploring");
          return;
        case "tab":
          updateMode("exploring");
          return;
        case "?":
          updateMode("help");
          return;
        case "q":
          cleanup();
          return;
      }
      return;
    }
  });

  // ---- Resize handler ----
  renderer.on("resize", (w: number, h: number) => {
    state.termWidth = w;
    state.termHeight = h;
    // Could recompute tree panel width here for true adaptiveness
  });

  function cleanup() {
    storage.close();
    renderer.setTerminalTitle("");
    renderer.destroy();
    process.exit(0);
  }
}

// ============================================================================
// Help text (markdown)
// ============================================================================

const HELP_TEXT = `# lain — keyboard reference

## tree panel

| key | action |
|---|---|
| **j** / **↓** | next node |
| **k** / **↑** | previous node |
| **enter** / **→** | open in content panel |
| **tab** | switch to content panel |

## content panel

| key | action |
|---|---|
| **j** / **↓** | scroll down |
| **k** / **↑** | scroll up |
| **d** / **u** | half page down / up |
| **g** / **G** | top / bottom |
| **esc** / **←** / **h** | back to tree |
| **tab** | switch to tree panel |

## general

| key | action |
|---|---|
| **?** | this help |
| **q** | quit |
`;
