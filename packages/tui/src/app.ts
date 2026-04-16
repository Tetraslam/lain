import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type StyledText,
} from "@opentui/core";
import { t, fg, dim, bold, italic, underline } from "@opentui/core";
import type { KeyEvent, SelectOption } from "@opentui/core";
import { ToasterRenderable, toast } from "@opentui-ui/toast";
import { Storage, Graph, Orchestrator, Sync, Exporter } from "@lain/core";
import { createProvider } from "@lain/agents";
import type { LainNode, Exploration } from "@lain/shared";
import { loadConfig, loadCredentials, createProviderFromCredentials } from "./config-loader.js";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Theme
// ============================================================================

const c = {
  accent:     "#bb9af7",
  accentDim:  "#7c6ea3",
  blue:       "#7aa2f7",
  cyan:       "#0db9d7",
  bright:     "#c0caf5",
  fg:         "#a9b1d6",
  dim:        "#565f89",
  muted:      "#3b3f5c",
  surface:    "#292e42",
  red:        "#f7768e",
  green:      "#9ece6a",
  yellow:     "#e0af68",
  orange:     "#ff9e64",
};

// ============================================================================
// State
// ============================================================================

type AppMode = "exploring" | "reading" | "help";

interface AppState {
  mode: AppMode;
  previousMode: AppMode;
  exploration: Exploration;
  nodes: LainNode[];
  treeItems: TreeItem[];
  selectedIdx: number;
  termWidth: number;
  termHeight: number;
  dbPath: string;
}

interface TreeItem {
  nodeId: string;
  prefix: string;
  title: string;
  depth: number;
  status: string;
  node: LainNode;
}

// ============================================================================
// DB Discovery
// ============================================================================

function discoverDbFiles(startDir: string): string[] {
  const results: string[] = [];
  let dir = startDir;
  for (let i = 0; i < 4; i++) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith(".db")) continue;
        const full = path.join(dir, entry);
        try {
          const s = new Storage(full);
          const exps = new Graph(s).getAllExplorations();
          s.close();
          if (exps.length > 0) results.push(full);
        } catch {}
      }
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return results;
}

// ============================================================================
// Tree Builder
// ============================================================================

function buildTreeItems(node: LainNode, allNodes: LainNode[], prefix = "", isLast = true, isRoot = true): TreeItem[] {
  const items: TreeItem[] = [];
  const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
  items.push({ nodeId: node.id, prefix: prefix + connector, title: node.title || node.id, depth: node.depth, status: node.status, node });
  const children = allNodes.filter((n) => n.parentId === node.id).sort((a, b) => a.branchIndex - b.branchIndex);
  const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
  children.forEach((child, i) => { items.push(...buildTreeItems(child, allNodes, childPrefix, i === children.length - 1, false)); });
  return items;
}

// ============================================================================
// Styled Content Builder (replaces MarkdownRenderable)
// ============================================================================

function buildNodeContent(node: LainNode, graph: Graph, allNodes: LainNode[]): StyledText {
  // Build breadcrumb
  const ancestors = graph.getAncestorChain(node.id);
  let breadcrumb = "";
  if (ancestors.length > 0) {
    breadcrumb = [...ancestors, node]
      .map((n) => {
        const name = n.title || n.id;
        return name.length > 22 ? name.slice(0, 21) + "…" : name;
      })
      .join("  ›  ");
  }

  // Build metadata
  const statusColor = node.status === "complete" ? c.green : node.status === "pruned" ? c.red : c.yellow;

  // Build cross-links section as plain string
  const crosslinks = graph.getCrosslinksForNode(node.id);
  let crosslinksStr = "";
  if (crosslinks.length > 0) {
    crosslinksStr += "\n────────────────────────────────\ncross-links\n";
    for (const cl of crosslinks) {
      const otherId = cl.sourceId === node.id ? cl.targetId : cl.sourceId;
      const other = graph.getNode(otherId);
      const name = other?.title || otherId;
      crosslinksStr += `  → ${name}${cl.label ? `  ${cl.label}` : ""}\n`;
    }
  }

  // Build children section as plain string
  const children = allNodes.filter((n) => n.parentId === node.id && n.status !== "pruned");
  let childrenStr = "";
  if (children.length > 0) {
    childrenStr += `\n────────────────────────────────\nchildren (${children.length})\n`;
    for (const child of children) {
      childrenStr += `  ${child.branchIndex}. ${child.title || child.id}\n`;
    }
  }

  // Build model and direction lines
  let metaExtraStr = "";
  if (node.model) {
    metaExtraStr += `model  ${node.model} (${node.provider})\n`;
  }
  if (node.planSummary) {
    metaExtraStr += `direction  ${node.planSummary}\n`;
  }

  // Build content section
  const contentBody = node.content || "(no content)";

  // Assemble as one template
  const titleStr = node.title || node.id;
  const sep = "─".repeat(Math.min(50, titleStr.length));

  return t`${breadcrumb ? `${breadcrumb}\n\n` : ""}${bold(fg(c.bright)(titleStr))}
${fg(c.muted)(sep)}

${fg(c.blue)("id")}  ${node.id}  ${fg(c.muted)("·")}  ${fg(c.blue)("depth")}  ${String(node.depth)}  ${fg(c.muted)("·")}  ${fg(c.blue)("branch")}  ${String(node.branchIndex)}  ${fg(c.muted)("·")}  ${fg(statusColor)(node.status)}
${metaExtraStr}
${contentBody}
${crosslinksStr}${childrenStr}`;
}

// ============================================================================
// Help Content (styled)
// ============================================================================

function buildHelpContent(): StyledText {
  return t`${bold(fg(c.bright)("lain — keyboard reference"))}

${bold(fg(c.accent)("tree panel"))}
  ${fg(c.yellow)("j/k  ↑/↓")}     navigate nodes
  ${fg(c.yellow)("enter  →")}     open in content panel
  ${fg(c.yellow)("tab")}          switch to content panel
  ${fg(c.yellow)("p")}            prune selected node
  ${fg(c.yellow)("e")}            extend selected node (add children)
  ${fg(c.yellow)("r")}            redirect (regenerate) selected node
  ${fg(c.yellow)("x")}            export to obsidian markdown
  ${fg(c.yellow)("s")}            sync with obsidian folder

${bold(fg(c.accent)("content panel"))}
  ${fg(c.yellow)("j/k  ↑/↓")}     scroll content
  ${fg(c.yellow)("d/u")}          half page down/up
  ${fg(c.yellow)("g/G")}          scroll to top/bottom
  ${fg(c.yellow)("esc  ←  h")}    back to tree
  ${fg(c.yellow)("tab")}          switch to tree panel

${bold(fg(c.accent)("general"))}
  ${fg(c.yellow)("?")}            this help
  ${fg(c.yellow)("q")}            quit
`;
}

// ============================================================================
// Main App
// ============================================================================

export async function createApp(dbPathArg?: string): Promise<void> {
  let dbPath: string;
  if (dbPathArg && fs.existsSync(dbPathArg)) {
    dbPath = dbPathArg;
  } else {
    const found = discoverDbFiles(process.cwd());
    if (found.length === 0) throw new Error("No lain .db files found.");
    dbPath = found[0];
  }

  let storage = new Storage(dbPath);
  let graph = new Graph(storage);
  const explorations = graph.getAllExplorations();
  if (explorations.length === 0) { storage.close(); throw new Error("No explorations."); }
  let exploration = explorations[0];
  let allNodes = graph.getAllNodes(exploration.id);
  const root = allNodes.find((n) => n.parentId === null);
  if (!root) { storage.close(); throw new Error("No root node."); }

  let treeItems = buildTreeItems(root, allNodes);
  const nodeCount = () => allNodes.filter((n) => n.status !== "pruned").length;

  const renderer = await createCliRenderer();
  const termW = renderer.width ?? 80;

  const shortName = exploration.name.length > 50 ? exploration.name.slice(0, 47) + "…" : exploration.name;
  renderer.setTerminalTitle(`lain — ${shortName}`);

  const state: AppState = {
    mode: "exploring",
    previousMode: "exploring",
    exploration,
    nodes: allNodes,
    treeItems,
    selectedIdx: 0,
    termWidth: termW,
    termHeight: renderer.height ?? 24,
    dbPath,
  };

  const treePanelWidth = termW < 100 ? Math.floor(termW * 0.4) : termW < 160 ? 44 : 54;

  // ---- Toast system ----
  const toaster = new ToasterRenderable(renderer, {
    position: "bottom-right",
    stackingMode: "stack",
  });
  renderer.root.add(toaster);

  // ---- Root ----
  const rootBox = new BoxRenderable(renderer, { id: "root", width: "100%", height: "100%", flexDirection: "column", paddingLeft: 1, paddingRight: 1 });
  renderer.root.add(rootBox);

  // ---- Header ----
  const headerBox = new BoxRenderable(renderer, { id: "header", width: "100%", height: 1, marginTop: 1, marginBottom: 1 });
  rootBox.add(headerBox);
  const headerText = new TextRenderable(renderer, {
    id: "header-text",
    content: t`  ${fg(c.accent)("lain")}  ${dim(shortName)}  ${fg(c.muted)("·")}  ${dim(`${nodeCount()} nodes`)}  ${fg(c.muted)("·")}  ${dim(`n=${exploration.n} m=${exploration.m}`)}  ${fg(c.muted)("·")}  ${dim(exploration.extension)}`,
  });
  headerBox.add(headerText);

  // ---- Content area ----
  const contentArea = new BoxRenderable(renderer, { id: "content-area", width: "100%", flexGrow: 1, flexDirection: "row", gap: 1 });
  rootBox.add(contentArea);

  // ---- Tree panel ----
  const treePanel = new BoxRenderable(renderer, {
    id: "tree-panel", width: treePanelWidth, height: "100%",
    border: true, borderStyle: "rounded", borderColor: c.accent,
    flexDirection: "column", overflow: "hidden",
  });
  contentArea.add(treePanel);

  function buildSelectOpts(): SelectOption[] {
    return treeItems.map((item) => {
      const maxTitle = treePanelWidth - item.prefix.length - 6;
      let title = item.title;
      if (title.length > maxTitle && maxTitle > 5) title = title.slice(0, maxTitle - 1) + "…";
      return { name: `${item.prefix}${title}`, description: "", value: item.nodeId };
    });
  }

  const treeSelect = new SelectRenderable(renderer, {
    id: "tree-select", width: "100%", height: "100%",
    options: buildSelectOpts(), selectedIndex: 0,
    backgroundColor: "transparent", textColor: c.dim,
    focusedBackgroundColor: "transparent", focusedTextColor: c.dim,
    selectedBackgroundColor: c.surface, selectedTextColor: c.bright,
    showDescription: false, showScrollIndicator: true, wrapSelection: false,
    itemSpacing: 0,
  });
  treePanel.add(treeSelect);
  treeSelect.focus();

  // ---- Node panel ----
  const nodePanel = new BoxRenderable(renderer, {
    id: "node-panel", flexGrow: 1, height: "100%",
    border: true, borderStyle: "rounded", borderColor: c.muted,
    flexDirection: "column", overflow: "hidden",
    paddingLeft: 1, paddingRight: 1, paddingTop: 1,
  });
  contentArea.add(nodePanel);

  const nodeScroll = new ScrollBoxRenderable(renderer, {
    id: "node-scroll", scrollY: true, scrollX: false, viewportCulling: true,
  });
  nodePanel.add(nodeScroll);

  const nodeText = new TextRenderable(renderer, {
    id: "node-text", content: buildNodeContent(root, graph, allNodes), width: "100%",
  });
  nodeScroll.content.add(nodeText);

  // ---- Footer ----
  const footerBox = new BoxRenderable(renderer, { id: "footer", width: "100%", height: 1, marginTop: 1, marginBottom: 1, paddingLeft: 2 });
  rootBox.add(footerBox);
  const footerText = new TextRenderable(renderer, { id: "footer-text", content: exploringFooter() });
  footerBox.add(footerText);

  // ---- Helpers ----
  function exploringFooter(): StyledText {
    return t`  ${dim("j/k")} navigate  ${fg(c.muted)("·")}  ${dim("enter/→")} open  ${fg(c.muted)("·")}  ${dim("p")}rune ${dim("e")}xtend ${dim("r")}edirect  ${fg(c.muted)("·")}  ${dim("?")} help  ${fg(c.muted)("·")}  ${dim("q")} quit`;
  }
  function readingFooter(): StyledText {
    return t`  ${dim("j/k")} scroll  ${fg(c.muted)("·")}  ${dim("d/u")} page  ${fg(c.muted)("·")}  ${dim("esc/←")} back  ${fg(c.muted)("·")}  ${dim("?")} help`;
  }

  function refreshTree() {
    allNodes = graph.getAllNodes(exploration.id);
    state.nodes = allNodes;
    const r = allNodes.find((n) => n.parentId === null)!;
    treeItems = buildTreeItems(r, allNodes);
    state.treeItems = treeItems;
    treeSelect.options = buildSelectOpts();
    headerText.content = t`  ${fg(c.accent)("lain")}  ${dim(shortName)}  ${fg(c.muted)("·")}  ${dim(`${nodeCount()} nodes`)}  ${fg(c.muted)("·")}  ${dim(`n=${exploration.n} m=${exploration.m}`)}  ${fg(c.muted)("·")}  ${dim(exploration.extension)}`;
  }

  function selectedNode(): LainNode | null {
    const item = treeItems[treeSelect.getSelectedIndex()];
    return item ? graph.getNode(item.nodeId) : null;
  }

  function showNode(node: LainNode) {
    nodeText.content = buildNodeContent(node, graph, allNodes);
    nodeScroll.scrollTop = 0;
  }

  // ---- Selection change ----
  treeSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
    const node = selectedNode();
    if (node) showNode(node);
  });

  // ---- Mode management ----
  function updateMode(newMode: AppMode) {
    state.previousMode = state.mode;
    state.mode = newMode;
    if (newMode === "exploring") {
      treePanel.borderColor = c.accent;
      nodePanel.borderColor = c.muted;
      treeSelect.focusable = true;
      treeSelect.focus();
      footerText.content = exploringFooter();
    } else if (newMode === "reading") {
      treePanel.borderColor = c.muted;
      nodePanel.borderColor = c.accent;
      treeSelect.blur();
      treeSelect.focusable = false;
      footerText.content = readingFooter();
    } else if (newMode === "help") {
      treePanel.borderColor = c.muted;
      nodePanel.borderColor = c.accent;
      treeSelect.blur();
      treeSelect.focusable = false;
      nodeText.content = buildHelpContent();
      nodeScroll.scrollTop = 0;
      footerText.content = t`  ${dim("press any key to dismiss")}`;
    }
  }

  // ---- Write operations ----
  async function doPrune() {
    const node = selectedNode();
    if (!node || node.id === "root") { toast.warning("Cannot prune root node"); return; }
    graph.pruneNode(node.id);
    toast.success(`Pruned ${node.title || node.id}`);
    refreshTree();
    const current = selectedNode();
    if (current) showNode(current);
  }

  async function doExtend() {
    const node = selectedNode();
    if (!node) return;
    if (node.status !== "complete") { toast.warning("Can only extend complete nodes"); return; }

    toast.loading("Extending...");
    try {
      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = createProviderFromCredentials(config, credentials);
      const orchestrator = new Orchestrator({ dbPath: state.dbPath, agent });
      await orchestrator.extendNode(exploration.id, node.id, exploration.n);
      orchestrator.close();

      // Reload from db (orchestrator opened its own connection)
      storage.close();
      storage = new Storage(state.dbPath);
      graph = new Graph(storage);

      toast.success(`Extended ${node.title || node.id} with ${exploration.n} children`);
      refreshTree();
      const current = selectedNode();
      if (current) showNode(current);
    } catch (err: any) {
      toast.error(`Extend failed: ${err.message}`);
    }
  }

  async function doRedirect() {
    const node = selectedNode();
    if (!node || node.id === "root") { toast.warning("Cannot redirect root node"); return; }

    toast.loading("Regenerating...");
    try {
      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = createProviderFromCredentials(config, credentials);
      const orchestrator = new Orchestrator({ dbPath: state.dbPath, agent });
      await orchestrator.redirectNode(exploration.id, node.id);
      orchestrator.close();

      storage.close();
      storage = new Storage(state.dbPath);
      graph = new Graph(storage);

      toast.success("Node regenerated");
      refreshTree();
      const current = selectedNode();
      if (current) showNode(current);
    } catch (err: any) {
      toast.error(`Redirect failed: ${err.message}`);
    }
  }

  function doExport() {
    try {
      const baseName = path.basename(state.dbPath, ".db");
      const outputDir = path.join(path.dirname(state.dbPath), baseName);
      const exporter = new Exporter(storage);
      exporter.export(exploration.id, outputDir);
      toast.success(`Exported to ${outputDir}/`);
    } catch (err: any) {
      toast.error(`Export failed: ${err.message}`);
    }
  }

  function doSync() {
    try {
      const baseName = path.basename(state.dbPath, ".db");
      const dir = path.join(path.dirname(state.dbPath), baseName);
      const sync = new Sync(storage);
      const result = sync.sync(exploration.id, dir);

      const parts: string[] = [];
      if (result.pushed.length > 0) parts.push(`${result.pushed.length} pushed`);
      if (result.pulled.length > 0) parts.push(`${result.pulled.length} pulled`);
      if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} conflicts`);
      if (parts.length === 0) parts.push("everything in sync");

      toast.success(parts.join(", "));
      refreshTree();
      const current = selectedNode();
      if (current) showNode(current);
    } catch (err: any) {
      toast.error(`Sync failed: ${err.message}`);
    }
  }

  // ---- Keyboard ----
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    // Help dismissal
    if (state.mode === "help") {
      const node = selectedNode();
      if (node) showNode(node);
      updateMode(state.previousMode);
      return;
    }

    // ---- Exploring mode ----
    if (state.mode === "exploring") {
      switch (key.name) {
        case "return":
        case "right": updateMode("reading"); return;
        case "tab": updateMode("reading"); return;
        case "?": updateMode("help"); return;
        case "q": case "escape": cleanup(); return;

        // Write operations
        case "p": doPrune(); return;
        case "e": doExtend(); return;
        case "r": doRedirect(); return;
        case "x": doExport(); return;
        case "s": doSync(); return;
      }
      return;
    }

    // ---- Reading mode ----
    if (state.mode === "reading") {
      switch (key.name) {
        case "j": case "down": nodeScroll.scrollBy({ x: 0, y: 2 }); return;
        case "k": case "up": nodeScroll.scrollBy({ x: 0, y: -2 }); return;
        case "d": nodeScroll.scrollBy({ x: 0, y: 10 }); return;
        case "u": nodeScroll.scrollBy({ x: 0, y: -10 }); return;
        case "g": nodeScroll.scrollTop = 0; return;
        case "escape": case "left": case "h": updateMode("exploring"); return;
        case "tab": updateMode("exploring"); return;
        case "?": updateMode("help"); return;
        case "q": cleanup(); return;
      }
      return;
    }
  });

  // ---- Resize ----
  renderer.on("resize", (w: number, h: number) => {
    state.termWidth = w;
    state.termHeight = h;
  });

  function cleanup() {
    storage.close();
    renderer.setTerminalTitle("");
    renderer.destroy();
    process.exit(0);
  }
}
