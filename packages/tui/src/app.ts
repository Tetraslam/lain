import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  InputRenderable,
  InputRenderableEvents,
  TextareaRenderable,
  type StyledText,
} from "@opentui/core";
import { t, fg, dim, bold, italic } from "@opentui/core";
import type { KeyEvent, SelectOption } from "@opentui/core";
import { ToasterRenderable, toast } from "@opentui-ui/toast";
import { Storage, Graph, Orchestrator, Sync, Exporter } from "@lain/core";
import type { LainNode, Exploration, Strategy, PlanDetail } from "@lain/shared";
import { generateId } from "@lain/shared";
import { loadConfig, loadCredentials, createProviderFromCredentials } from "./config-loader.js";
import { GraphView } from "./graph-view.js";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Theme
// ============================================================================

const c = {
  accent: "#bb9af7", accentDim: "#7c6ea3", blue: "#7aa2f7", cyan: "#0db9d7",
  bright: "#c0caf5", fg: "#a9b1d6", dim: "#565f89", muted: "#3b3f5c",
  surface: "#292e42", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68", orange: "#ff9e64",
};

// ============================================================================
// Types
// ============================================================================

interface DbInfo {
  path: string;
  name: string;
  explorations: { id: string; name: string; nodeCount: number; seed: string; n: number; m: number; ext: string }[];
}

interface TreeItem {
  nodeId: string; prefix: string; title: string; depth: number; status: string; node: LainNode;
}

type AppMode = "home" | "exploring" | "reading" | "help" | "palette" | "creating";

// ============================================================================
// DB Discovery
// ============================================================================

function discoverDbs(startDir: string): DbInfo[] {
  const results: DbInfo[] = [];
  let dir = startDir;
  for (let i = 0; i < 4; i++) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith(".db")) continue;
        const full = path.join(dir, entry);
        try {
          const s = new Storage(full);
          const g = new Graph(s);
          const exps = g.getAllExplorations();
          if (exps.length > 0) {
            results.push({
              path: full,
              name: entry,
              explorations: exps.map((e) => ({
                id: e.id, name: e.name, seed: e.seed, n: e.n, m: e.m, ext: e.extension,
                nodeCount: g.getAllNodes(e.id).filter((n) => n.status !== "pruned").length,
              })),
            });
          }
          s.close();
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
// Content Builder
// ============================================================================

function buildNodeContent(node: LainNode, graph: Graph, allNodes: LainNode[]): StyledText {
  const ancestors = graph.getAncestorChain(node.id);
  let breadcrumb = "";
  if (ancestors.length > 0) {
    breadcrumb = [...ancestors, node].map((n) => {
      const name = n.title || n.id;
      return name.length > 22 ? name.slice(0, 21) + "…" : name;
    }).join("  ›  ");
  }

  const statusColor = node.status === "complete" ? c.green : node.status === "pruned" ? c.red : c.yellow;

  const crosslinks = graph.getCrosslinksForNode(node.id);
  let crosslinksStr = "";
  if (crosslinks.length > 0) {
    crosslinksStr += "\n────────────────────────────────\ncross-links\n";
    for (const cl of crosslinks) {
      const otherId = cl.sourceId === node.id ? cl.targetId : cl.sourceId;
      const other = graph.getNode(otherId);
      crosslinksStr += `  → ${other?.title || otherId}${cl.label ? `  ${cl.label}` : ""}\n`;
    }
  }

  const children = allNodes.filter((n) => n.parentId === node.id && n.status !== "pruned");
  let childrenStr = "";
  if (children.length > 0) {
    childrenStr += `\n────────────────────────────────\nchildren (${children.length})\n`;
    for (const child of children) childrenStr += `  ${child.branchIndex}. ${child.title || child.id}\n`;
  }

  let metaExtraStr = "";
  if (node.model) metaExtraStr += `model  ${node.model} (${node.provider})\n`;
  if (node.planSummary) metaExtraStr += `direction  ${node.planSummary}\n`;

  const titleStr = node.title || node.id;
  const sep = "─".repeat(Math.min(50, titleStr.length));

  return t`${breadcrumb ? `${breadcrumb}\n\n` : ""}${bold(fg(c.bright)(titleStr))}
${fg(c.muted)(sep)}

${fg(c.blue)("id")}  ${node.id}  ${fg(c.muted)("·")}  ${fg(c.blue)("depth")}  ${String(node.depth)}  ${fg(c.muted)("·")}  ${fg(c.blue)("branch")}  ${String(node.branchIndex)}  ${fg(c.muted)("·")}  ${fg(statusColor)(node.status)}
${metaExtraStr}
${node.content || "(no content)"}
${crosslinksStr}${childrenStr}`;
}

function buildHelpContent(): StyledText {
  return t`${bold(fg(c.bright)("lain — keyboard reference"))}

${bold(fg(c.accent)("tree panel"))}
  ${fg(c.yellow)("j/k  ↑/↓")}     navigate nodes
  ${fg(c.yellow)("enter  →")}     open in content panel
  ${fg(c.yellow)("tab")}          switch to content panel
  ${fg(c.yellow)("p")}            prune selected node
  ${fg(c.yellow)("e")}            extend (add children)
  ${fg(c.yellow)("r")}            redirect (regenerate)
  ${fg(c.yellow)("x")}            export to obsidian
  ${fg(c.yellow)("s")}            sync with obsidian
  ${fg(c.yellow)("ctrl+p")}       command palette

${bold(fg(c.accent)("content panel"))}
  ${fg(c.yellow)("j/k  ↑/↓")}     scroll content
  ${fg(c.yellow)("d/u")}          half page down/up
  ${fg(c.yellow)("g")}            scroll to top
  ${fg(c.yellow)("esc  ←  h")}    back to tree
  ${fg(c.yellow)("ctrl+p")}       command palette

${bold(fg(c.accent)("general"))}
  ${fg(c.yellow)("?")}            this help
  ${fg(c.yellow)("q")}            quit (from tree) / back (from content)
  ${fg(c.yellow)("ctrl+p")}       command palette (from anywhere)
`;
}

// ============================================================================
// Command Palette Actions
// ============================================================================

interface PaletteAction {
  name: string;
  description: string;
  key?: string;
  action: () => void | Promise<void>;
}

// ============================================================================
// Main App
// ============================================================================

export async function createApp(dbPathArg?: string): Promise<void> {
  const renderer = await createCliRenderer();
  const termW = renderer.width ?? 80;

  // ---- Toast ----
  const toaster = new ToasterRenderable(renderer, {
    position: "bottom-right",
    stackingMode: "stack",
  });
  renderer.root.add(toaster);

  // ---- Root container ----
  const rootBox = new BoxRenderable(renderer, {
    id: "root", width: "100%", height: "100%", flexDirection: "column", paddingLeft: 1, paddingRight: 1,
  });
  renderer.root.add(rootBox);

  // ---- State ----
  let mode: AppMode = "home";
  let previousMode: AppMode = "home";
  let storage: Storage | null = null;
  let graph: Graph | null = null;
  let exploration: Exploration | null = null;
  let allNodes: LainNode[] = [];
  let treeItems: TreeItem[] = [];
  let dbPath = "";

  // ---- Discover DBs ----
  const dbs = discoverDbs(process.cwd());

  // If a specific path was given and it exists, go straight to exploration
  if (dbPathArg && fs.existsSync(dbPathArg)) {
    dbPath = dbPathArg;
  }

  // ===========================================================================
  // HOME SCREEN
  // ===========================================================================

  const homeContainer = new BoxRenderable(renderer, {
    id: "home-container", width: "100%", height: "100%", flexDirection: "column",
  });

  // Home header
  const homeHeader = new BoxRenderable(renderer, {
    id: "home-header", width: "100%", height: 5, justifyContent: "center", alignItems: "center",
    marginTop: 2,
  });
  homeContainer.add(homeHeader);
  const homeTitle = new TextRenderable(renderer, {
    id: "home-title",
    content: t`${bold(fg(c.accent)("lain"))}  ${dim("graph-based ideation engine")}`,
  });
  homeHeader.add(homeTitle);

  // Home select
  const homeOptions: SelectOption[] = [];
  for (const db of dbs) {
    for (const exp of db.explorations) {
      const truncName = exp.name.length > 50 ? exp.name.slice(0, 47) + "…" : exp.name;
      homeOptions.push({
        name: truncName,
        description: `${exp.nodeCount} nodes · n=${exp.n} m=${exp.m} · ${exp.ext} · ${db.name}`,
        value: { dbPath: db.path, expId: exp.id },
      });
    }
  }
  homeOptions.push({
    name: "✦  Create new exploration",
    description: "Start a new idea graph from scratch",
    value: { action: "create" },
  });

  const homeSelect = new SelectRenderable(renderer, {
    id: "home-select", width: "100%", height: "100%",
    options: homeOptions, selectedIndex: 0,
    backgroundColor: "transparent", textColor: c.fg,
    focusedBackgroundColor: "transparent", focusedTextColor: c.fg,
    selectedBackgroundColor: c.surface, selectedTextColor: c.bright,
    descriptionColor: c.dim, selectedDescriptionColor: c.accentDim,
    showDescription: true, showScrollIndicator: true, wrapSelection: false,
    itemSpacing: 1,
  });

  // Constrain home list width for aesthetics on wide screens
  const homeMaxWidth = Math.min(termW - 8, 80);

  const homeBody = new BoxRenderable(renderer, {
    id: "home-body", width: "100%", flexGrow: 1, marginTop: 1,
    alignItems: "center",
  });
  homeContainer.add(homeBody);

  const homeBodyInner = new BoxRenderable(renderer, {
    id: "home-body-inner", width: homeMaxWidth, height: "100%",
  });
  homeBody.add(homeBodyInner);
  homeBodyInner.add(homeSelect);

  const homeFooter = new BoxRenderable(renderer, {
    id: "home-footer", width: "100%", height: 1, marginBottom: 1, paddingLeft: 2,
  });
  homeContainer.add(homeFooter);
  const homeFooterText = new TextRenderable(renderer, {
    id: "home-footer-text",
    content: t`  ${dim("j/k")} navigate  ${fg(c.muted)("·")}  ${dim("enter")} open  ${fg(c.muted)("·")}  ${dim("ctrl+p")} command palette  ${fg(c.muted)("·")}  ${dim("q")} quit`,
  });
  homeFooter.add(homeFooterText);

  // ===========================================================================
  // EXPLORATION VIEW
  // ===========================================================================

  const explorationContainer = new BoxRenderable(renderer, {
    id: "exp-container", width: "100%", height: "100%", flexDirection: "column",
  });

  // Header
  const expHeader = new BoxRenderable(renderer, { id: "exp-header", width: "100%", height: 1, marginTop: 1, marginBottom: 1 });
  explorationContainer.add(expHeader);
  const expHeaderText = new TextRenderable(renderer, { id: "exp-header-text", content: "" });
  expHeader.add(expHeaderText);

  // Content area
  const expContent = new BoxRenderable(renderer, { id: "exp-content", width: "100%", flexGrow: 1, flexDirection: "row", gap: 1 });
  explorationContainer.add(expContent);

  const treePanelWidth = termW < 100 ? Math.floor(termW * 0.4) : termW < 160 ? 44 : 54;

  const treePanel = new BoxRenderable(renderer, {
    id: "tree-panel", width: treePanelWidth, height: "100%",
    border: true, borderStyle: "rounded", borderColor: c.accent,
    flexDirection: "column", overflow: "hidden",
  });
  expContent.add(treePanel);

  const treeSelect = new SelectRenderable(renderer, {
    id: "tree-select", width: "100%", height: "100%",
    options: [], selectedIndex: 0,
    backgroundColor: "transparent", textColor: c.dim,
    focusedBackgroundColor: "transparent", focusedTextColor: c.dim,
    selectedBackgroundColor: c.surface, selectedTextColor: c.bright,
    showDescription: false, showScrollIndicator: true, wrapSelection: false,
    itemSpacing: 0,
  });
  treePanel.add(treeSelect);

  const nodePanel = new BoxRenderable(renderer, {
    id: "node-panel", flexGrow: 1, height: "100%",
    border: true, borderStyle: "rounded", borderColor: c.muted,
    flexDirection: "column", overflow: "hidden",
    paddingLeft: 1, paddingRight: 1, paddingTop: 1,
  });
  expContent.add(nodePanel);

  const nodeScroll = new ScrollBoxRenderable(renderer, {
    id: "node-scroll", scrollY: true, scrollX: false, viewportCulling: true,
  });
  nodePanel.add(nodeScroll);

  const nodeText = new TextRenderable(renderer, { id: "node-text", content: "", width: "100%" });
  nodeScroll.content.add(nodeText);

  // Footer
  const expFooter = new BoxRenderable(renderer, { id: "exp-footer", width: "100%", height: 1, marginTop: 1, marginBottom: 1, paddingLeft: 2 });
  explorationContainer.add(expFooter);
  const expFooterText = new TextRenderable(renderer, { id: "exp-footer-text", content: "" });
  expFooter.add(expFooterText);

  // ===========================================================================
  // COMMAND PALETTE (overlay)
  // ===========================================================================

  const paletteOverlay = new BoxRenderable(renderer, {
    id: "palette-overlay", width: "100%", height: "100%",
    position: "absolute", left: 0, top: 0,
    justifyContent: "flex-start", alignItems: "center",
    paddingTop: 3,
  });

  const paletteBox = new BoxRenderable(renderer, {
    id: "palette-box", width: 60, border: true, borderStyle: "rounded", borderColor: c.accent,
    flexDirection: "column", backgroundColor: c.surface,
    paddingLeft: 1, paddingRight: 1,
  });
  paletteOverlay.add(paletteBox);

  const paletteInput = new InputRenderable(renderer, {
    id: "palette-input", width: "100%", placeholder: "Type a command...",
  });
  paletteBox.add(paletteInput);

  const paletteDivider = new TextRenderable(renderer, {
    id: "palette-divider", content: "─".repeat(56), fg: c.muted, width: "100%",
  });
  paletteBox.add(paletteDivider);

  const paletteSelect = new SelectRenderable(renderer, {
    id: "palette-select", width: "100%", height: 12,
    options: [], selectedIndex: 0,
    backgroundColor: "transparent", textColor: c.fg,
    focusedBackgroundColor: "transparent", focusedTextColor: c.fg,
    selectedBackgroundColor: c.surface, selectedTextColor: c.bright,
    descriptionColor: c.dim, selectedDescriptionColor: c.fg,
    showDescription: true, showScrollIndicator: false, wrapSelection: false,
    itemSpacing: 0,
  });
  paletteBox.add(paletteSelect);

  // ===========================================================================
  // CREATE EXPLORATION (inline in palette area)
  // ===========================================================================

  const createBox = new BoxRenderable(renderer, {
    id: "create-box", width: "100%", height: "100%",
    position: "absolute", left: 0, top: 0,
    justifyContent: "flex-start", alignItems: "center",
    paddingTop: 3,
  });

  const createForm = new BoxRenderable(renderer, {
    id: "create-form", width: 60, border: true, borderStyle: "rounded", borderColor: c.accent,
    flexDirection: "column", backgroundColor: c.surface,
    paddingLeft: 1, paddingRight: 1, paddingTop: 1, paddingBottom: 1, gap: 1,
  });
  createBox.add(createForm);

  const createTitle = new TextRenderable(renderer, {
    id: "create-title", content: t`${bold(fg(c.accent)("new exploration"))}`,
  });
  createForm.add(createTitle);

  const createSeedLabel = new TextRenderable(renderer, {
    id: "create-seed-label", content: "seed idea", fg: c.dim,
  });
  createForm.add(createSeedLabel);

  const createSeedInput = new InputRenderable(renderer, {
    id: "create-seed-input", width: "100%", placeholder: "what if trees could talk...",
  });
  createForm.add(createSeedInput);

  const createParamsLabel = new TextRenderable(renderer, {
    id: "create-params-label", content: "parameters (optional — enter to skip)", fg: c.dim,
  });
  createForm.add(createParamsLabel);

  const createParamsRow = new BoxRenderable(renderer, {
    id: "create-params-row", width: "100%", flexDirection: "row", gap: 2,
  });
  createForm.add(createParamsRow);

  const createNLabel = new TextRenderable(renderer, { id: "create-n-label", content: "n:", fg: c.blue });
  createParamsRow.add(createNLabel);
  const createNInput = new InputRenderable(renderer, {
    id: "create-n-input", width: 4, placeholder: "3", value: "3",
  });
  createParamsRow.add(createNInput);

  const createMLabel = new TextRenderable(renderer, { id: "create-m-label", content: "m:", fg: c.blue });
  createParamsRow.add(createMLabel);
  const createMInput = new InputRenderable(renderer, {
    id: "create-m-input", width: 4, placeholder: "2", value: "2",
  });
  createParamsRow.add(createMInput);

  const createExtLabel = new TextRenderable(renderer, { id: "create-ext-label", content: "ext:", fg: c.blue });
  createParamsRow.add(createExtLabel);
  const createExtInput = new InputRenderable(renderer, {
    id: "create-ext-input", width: 15, placeholder: "freeform", value: "freeform",
  });
  createParamsRow.add(createExtInput);

  const createHint = new TextRenderable(renderer, {
    id: "create-hint",
    content: "tab to switch fields  ·  enter to create  ·  esc to cancel",
    fg: c.dim,
  });
  createForm.add(createHint);

  // ===========================================================================
  // Screen management
  // ===========================================================================

  function showScreen(screen: "home" | "exploration" | "palette" | "create") {
    try { rootBox.remove("home-container"); } catch {}
    try { rootBox.remove("exp-container"); } catch {}
    try { rootBox.remove("palette-overlay"); } catch {}
    try { rootBox.remove("create-box"); } catch {}

    if (screen === "home") {
      rootBox.add(homeContainer);
      homeSelect.focusable = true;
      homeSelect.focus();
      treeSelect.focusable = false;
      treeSelect.blur();
      renderer.setTerminalTitle("lain");
    } else if (screen === "exploration") {
      rootBox.add(explorationContainer);
      homeSelect.focusable = false;
      homeSelect.blur();
      if (mode === "exploring") {
        treeSelect.focusable = true;
        treeSelect.focus();
      }
    } else if (screen === "palette") {
      if (previousMode === "home") rootBox.add(homeContainer);
      else rootBox.add(explorationContainer);
      rootBox.add(paletteOverlay);
      paletteInput.value = "";
      paletteInput.focus();
      updatePaletteOptions("");
    } else if (screen === "create") {
      if (previousMode === "home") rootBox.add(homeContainer);
      else rootBox.add(explorationContainer);
      rootBox.add(createBox);
      createSeedInput.value = "";
      createSeedInput.focus();
    }
  }

  function openExploration(openDbPath: string, expId?: string) {
    if (storage) storage.close();
    dbPath = openDbPath;
    storage = new Storage(dbPath);
    graph = new Graph(storage);
    const exps = graph.getAllExplorations();
    exploration = expId ? exps.find((e) => e.id === expId) || exps[0] : exps[0];
    allNodes = graph.getAllNodes(exploration.id);
    const root = allNodes.find((n) => n.parentId === null);
    if (!root) { toast.error("No root node found"); return; }
    treeItems = buildTreeItems(root, allNodes);

    const shortName = exploration.name.length > 50 ? exploration.name.slice(0, 47) + "…" : exploration.name;
    renderer.setTerminalTitle(`lain — ${shortName}`);

    const nc = allNodes.filter((n) => n.status !== "pruned").length;
    expHeaderText.content = t`  ${fg(c.accent)("lain")}  ${dim(shortName)}  ${fg(c.muted)("·")}  ${dim(`${nc} nodes`)}  ${fg(c.muted)("·")}  ${dim(`n=${exploration.n} m=${exploration.m}`)}  ${fg(c.muted)("·")}  ${dim(exploration.extension)}`;

    treeSelect.options = treeItems.map((item) => {
      const maxTitle = treePanelWidth - item.prefix.length - 6;
      let title = item.title;
      if (title.length > maxTitle && maxTitle > 5) title = title.slice(0, maxTitle - 1) + "…";
      return { name: `${item.prefix}${title}`, description: "", value: item.nodeId };
    });
    treeSelect.setSelectedIndex(0);

    nodeText.content = buildNodeContent(root, graph, allNodes);
    expFooterText.content = exploringFooter();

    mode = "exploring";
    showScreen("exploration");
    treeSelect.focus();
    treePanel.borderColor = c.accent;
    nodePanel.borderColor = c.muted;
  }

  function refreshTree() {
    if (!graph || !exploration || !storage) return;
    allNodes = graph.getAllNodes(exploration.id);
    const root = allNodes.find((n) => n.parentId === null)!;
    treeItems = buildTreeItems(root, allNodes);
    const nc = allNodes.filter((n) => n.status !== "pruned").length;
    const shortName = exploration.name.length > 50 ? exploration.name.slice(0, 47) + "…" : exploration.name;
    expHeaderText.content = t`  ${fg(c.accent)("lain")}  ${dim(shortName)}  ${fg(c.muted)("·")}  ${dim(`${nc} nodes`)}  ${fg(c.muted)("·")}  ${dim(`n=${exploration.n} m=${exploration.m}`)}  ${fg(c.muted)("·")}  ${dim(exploration.extension)}`;
    treeSelect.options = treeItems.map((item) => {
      const maxTitle = treePanelWidth - item.prefix.length - 6;
      let title = item.title;
      if (title.length > maxTitle && maxTitle > 5) title = title.slice(0, maxTitle - 1) + "…";
      return { name: `${item.prefix}${title}`, description: "", value: item.nodeId };
    });
  }

  function selectedNode(): LainNode | null {
    if (!graph) return null;
    const item = treeItems[treeSelect.getSelectedIndex()];
    return item ? graph.getNode(item.nodeId) : null;
  }

  function showNode(node: LainNode) {
    if (!graph) return;
    nodeText.content = buildNodeContent(node, graph, allNodes);
    nodeScroll.scrollTop = 0;
  }

  // ---- Footers ----
  function exploringFooter(): StyledText {
    return t`  ${dim("j/k")} navigate  ${fg(c.muted)("·")}  ${dim("enter/→")} open  ${fg(c.muted)("·")}  ${dim("p")}rune ${dim("e")}xtend ${dim("r")}edirect  ${fg(c.muted)("·")}  ${dim("ctrl+p")} palette  ${fg(c.muted)("·")}  ${dim("q")} quit`;
  }
  function readingFooter(): StyledText {
    return t`  ${dim("j/k")} scroll  ${fg(c.muted)("·")}  ${dim("d/u")} page  ${fg(c.muted)("·")}  ${dim("esc/←")} back  ${fg(c.muted)("·")}  ${dim("ctrl+p")} palette  ${fg(c.muted)("·")}  ${dim("?")} help`;
  }

  // ---- Tree selection changed ----
  treeSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
    const node = selectedNode();
    if (node) showNode(node);
  });

  // ---- Palette ----
  function buildPaletteActions(): PaletteAction[] {
    const actions: PaletteAction[] = [];

    if (mode === "exploring" || mode === "reading") {
      const node = selectedNode();
      actions.push({ name: "Prune node", description: `Prune ${node?.title || "selected"} and descendants`, key: "p", action: doPrune });
      actions.push({ name: "Extend node", description: `Add ${exploration?.n || 3} children to ${node?.title || "selected"}`, key: "e", action: doExtend });
      actions.push({ name: "Redirect node", description: `Regenerate ${node?.title || "selected"} with fresh content`, key: "r", action: doRedirect });
      actions.push({ name: "Export to Obsidian", description: "Export as markdown files", key: "x", action: doExport });
      actions.push({ name: "Sync with Obsidian", description: "Bidirectional sync", key: "s", action: doSync });
      actions.push({ name: "Back to home", description: "Return to exploration list", action: () => { mode = "home"; showScreen("home"); } });
    }

    actions.push({ name: "New exploration", description: "Create a new idea graph", action: () => { previousMode = mode; mode = "creating"; showScreen("create"); } });
    actions.push({ name: "Help", description: "Show keyboard shortcuts", key: "?", action: () => showHelpMode() });
    actions.push({ name: "Quit", description: "Exit lain", key: "q", action: cleanup });

    return actions;
  }

  let paletteActions: PaletteAction[] = [];

  function updatePaletteOptions(filter: string) {
    paletteActions = buildPaletteActions();
    const filtered = filter
      ? paletteActions.filter((a) => a.name.toLowerCase().includes(filter.toLowerCase()))
      : paletteActions;
    paletteSelect.options = filtered.map((a) => ({
      name: a.name,
      description: `${a.description}${a.key ? `  [${a.key}]` : ""}`,
      value: a,
    }));
    paletteSelect.setSelectedIndex(0);
  }

  function executePaletteAction() {
    const opt = paletteSelect.getSelectedOption();
    if (!opt?.value) return;
    const action = opt.value as PaletteAction;
    closePalette();
    action.action();
  }

  function openPalette() {
    previousMode = mode;
    mode = "palette";
    treeSelect.focusable = false;
    treeSelect.blur();
    homeSelect.focusable = false;
    homeSelect.blur();
    paletteSelect.focusable = false;
    showScreen("palette");
  }

  function closePalette() {
    mode = previousMode;
    try { rootBox.remove("palette-overlay"); } catch {}
    if (mode === "home") {
      homeSelect.focusable = true;
      homeSelect.focus();
    } else if (mode === "exploring") {
      treeSelect.focusable = true;
      treeSelect.focus();
      treePanel.borderColor = c.accent;
      nodePanel.borderColor = c.muted;
      expFooterText.content = exploringFooter();
    } else if (mode === "reading") {
      treeSelect.focusable = false;
      treePanel.borderColor = c.muted;
      nodePanel.borderColor = c.accent;
      expFooterText.content = readingFooter();
    }
  }

  // ---- Mode transitions ----
  function enterReadingMode() {
    mode = "reading";
    treePanel.borderColor = c.muted;
    nodePanel.borderColor = c.accent;
    treeSelect.blur();
    treeSelect.focusable = false;
    expFooterText.content = readingFooter();
  }

  function enterExploringMode() {
    mode = "exploring";
    treePanel.borderColor = c.accent;
    nodePanel.borderColor = c.muted;
    treeSelect.focusable = true;
    treeSelect.focus();
    expFooterText.content = exploringFooter();
  }

  function showHelpMode() {
    previousMode = mode;
    mode = "help";
    treePanel.borderColor = c.muted;
    nodePanel.borderColor = c.accent;
    treeSelect.blur();
    treeSelect.focusable = false;
    nodeText.content = buildHelpContent();
    nodeScroll.scrollTop = 0;
    expFooterText.content = t`  ${dim("press any key to dismiss")}`;
  }

  // ---- Write operations ----
  async function doPrune() {
    const node = selectedNode();
    if (!node || node.id === "root" || !graph) { toast.warning("Cannot prune root node"); return; }
    graph.pruneNode(node.id);
    toast.success(`Pruned ${node.title || node.id}`);
    refreshTree();
    const current = selectedNode();
    if (current) showNode(current);
  }

  async function doExtend() {
    const node = selectedNode();
    if (!node || !exploration) return;
    if (node.status !== "complete") { toast.warning("Can only extend complete nodes"); return; }
    toast.loading("Extending...");
    try {
      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = createProviderFromCredentials(config, credentials);
      const orchestrator = new Orchestrator({ dbPath, agent });
      await orchestrator.extendNode(exploration.id, node.id, exploration.n);
      orchestrator.close();
      if (storage) storage.close();
      storage = new Storage(dbPath);
      graph = new Graph(storage);
      toast.success(`Extended with ${exploration.n} children`);
      refreshTree();
      const current = selectedNode();
      if (current) showNode(current);
    } catch (err: any) { toast.error(`Extend failed: ${err.message}`); }
  }

  async function doRedirect() {
    const node = selectedNode();
    if (!node || node.id === "root" || !exploration) { toast.warning("Cannot redirect root"); return; }
    toast.loading("Regenerating...");
    try {
      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = createProviderFromCredentials(config, credentials);
      const orchestrator = new Orchestrator({ dbPath, agent });
      await orchestrator.redirectNode(exploration.id, node.id);
      orchestrator.close();
      if (storage) storage.close();
      storage = new Storage(dbPath);
      graph = new Graph(storage);
      toast.success("Regenerated");
      refreshTree();
      const current = selectedNode();
      if (current) showNode(current);
    } catch (err: any) { toast.error(`Redirect failed: ${err.message}`); }
  }

  function doExport() {
    if (!storage || !exploration) return;
    try {
      const outputDir = path.join(path.dirname(dbPath), path.basename(dbPath, ".db"));
      new Exporter(storage).export(exploration.id, outputDir);
      toast.success(`Exported to ${outputDir}/`);
    } catch (err: any) { toast.error(`Export failed: ${err.message}`); }
  }

  function doSync() {
    if (!storage || !exploration) return;
    try {
      const dir = path.join(path.dirname(dbPath), path.basename(dbPath, ".db"));
      const result = new Sync(storage).sync(exploration.id, dir);
      const parts: string[] = [];
      if (result.pushed.length > 0) parts.push(`${result.pushed.length} pushed`);
      if (result.pulled.length > 0) parts.push(`${result.pulled.length} pulled`);
      if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} conflicts`);
      toast.success(parts.length > 0 ? parts.join(", ") : "in sync");
      refreshTree();
      const current = selectedNode();
      if (current) showNode(current);
    } catch (err: any) { toast.error(`Sync failed: ${err.message}`); }
  }

  async function doCreate(seed: string, n?: number, m?: number, ext?: string) {
    if (!seed.trim()) { toast.warning("Seed cannot be empty"); return; }
    const config = loadConfig();
    const credentials = loadCredentials();
    const agent = createProviderFromCredentials(config, credentials);

    const useN = n || config.defaultN;
    const useM = m || config.defaultM;
    const useExt = ext || config.defaultExtension;

    const slugName = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
    const newDbPath = path.resolve(`${slugName}.db`);
    const expId = generateId();

    // Switch to exploration view immediately with a placeholder
    const shortName = seed.length > 50 ? seed.slice(0, 47) + "…" : seed;
    renderer.setTerminalTitle(`lain — creating: ${shortName}`);
    expHeaderText.content = t`  ${fg(c.accent)("lain")}  ${dim(shortName)}  ${fg(c.muted)("·")}  ${fg(c.yellow)("creating...")}  ${fg(c.muted)("·")}  ${dim(`n=${useN} m=${useM}`)}  ${fg(c.muted)("·")}  ${dim(useExt)}`;
    treeSelect.options = [{ name: "generating...", description: "", value: null }];
    nodeText.content = t`${bold(fg(c.bright)(seed))}

${fg(c.yellow)("Generating exploration...")}

This will create ${bold(String(useN))} branches at each node to a depth of ${bold(String(useM))}.
Using extension: ${bold(useExt)}.
`;
    mode = "exploring";
    showScreen("exploration");
    treeSelect.blur();
    treeSelect.focusable = false;
    expFooterText.content = t`  ${fg(c.yellow)("generating...")}  ${dim("please wait")}`;

    try {
      const orchestrator = new Orchestrator({
        dbPath: newDbPath, agent, concurrency: 5,
        onEvent: (event) => {
          if (event.type === "node:complete") {
            const data = event.data as { title?: string } | undefined;
            if (data?.title) {
              toast.success(data.title, { duration: 2000 });
            }
          }
        },
      });
      await orchestrator.explore({
        id: expId, name: seed, seed,
        n: useN, m: useM,
        strategy: (config.defaultStrategy || "bf") as Strategy,
        planDetail: (config.defaultPlanDetail || "sentence") as PlanDetail,
        extension: useExt,
      });
      orchestrator.close();
      toast.success("Exploration complete!");
      openExploration(newDbPath, expId);
    } catch (err: any) {
      toast.error(`Create failed: ${err.message}`);
      mode = "home";
      showScreen("home");
    }
  }

  // ===========================================================================
  // Keyboard
  // ===========================================================================

  // Palette input filtering
  paletteInput.on(InputRenderableEvents.INPUT, () => {
    updatePaletteOptions(paletteInput.value);
  });

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    // ---- Ctrl+P: command palette from anywhere ----
    if (key.name === "p" && key.ctrl) {
      if (mode === "palette") { closePalette(); return; }
      openPalette();
      return;
    }

    // ---- Palette mode — stop propagation to prevent tree/home select intercepting ----
    if (mode === "palette") {
      key.stopPropagation();
      if (key.name === "escape") { closePalette(); return; }
      if (key.name === "return") { executePaletteAction(); return; }
      if (key.name === "down" || (key.name === "n" && key.ctrl)) { paletteSelect.moveDown(); return; }
      if (key.name === "up" || (key.name === "p" && key.ctrl)) { paletteSelect.moveUp(); return; }
      return;
    }

    // ---- Creating mode ----
    if (mode === "creating") {
      key.stopPropagation();
      if (key.name === "escape") {
        mode = previousMode;
        try { rootBox.remove("create-box"); } catch {}
        if (mode === "home") showScreen("home");
        else showScreen("exploration");
        return;
      }
      if (key.name === "tab") {
        // Cycle focus between seed, n, m, ext inputs
        const createFields = [createSeedInput, createNInput, createMInput, createExtInput];
        const currentFocus = createFields.findIndex((f) => (f as any)._focused);
        const next = (currentFocus + 1) % createFields.length;
        createFields.forEach((f) => f.blur());
        createFields[next].focus();
        return;
      }
      if (key.name === "return") {
        const seed = createSeedInput.value;
        const n = parseInt(createNInput.value) || 3;
        const m = parseInt(createMInput.value) || 2;
        const ext = createExtInput.value || "freeform";
        mode = previousMode;
        try { rootBox.remove("create-box"); } catch {}
        doCreate(seed, n, m, ext);
        return;
      }
      return;
    }

    // ---- Home mode ----
    if (mode === "home") {
      if (key.name === "return") {
        const opt = homeSelect.getSelectedOption();
        if (!opt?.value) return;
        const val = opt.value as any;
        if (val.action === "create") {
          previousMode = "home";
          mode = "creating";
          showScreen("create");
        } else if (val.dbPath) {
          openExploration(val.dbPath, val.expId);
        }
        return;
      }
      if (key.name === "q" || key.name === "escape") { cleanup(); return; }
      return;
    }

    // ---- Help mode ----
    if (mode === "help") {
      const node = selectedNode();
      if (node) showNode(node);
      enterExploringMode();
      return;
    }

    // ---- Exploring mode ----
    if (mode === "exploring") {
      switch (key.name) {
        case "return": case "right": enterReadingMode(); return;
        case "tab": enterReadingMode(); return;
        case "?": showHelpMode(); return;
        case "q": case "escape": mode = "home"; showScreen("home"); return;
        case "p": doPrune(); return;
        case "e": doExtend(); return;
        case "r": doRedirect(); return;
        case "x": doExport(); return;
        case "s": doSync(); return;
      }
      return;
    }

    // ---- Reading mode — stop propagation to prevent tree select intercepting ----
    if (mode === "reading") {
      key.stopPropagation();
      switch (key.name) {
        case "j": case "down": nodeScroll.scrollBy({ x: 0, y: 2 }); return;
        case "k": case "up": nodeScroll.scrollBy({ x: 0, y: -2 }); return;
        case "d": nodeScroll.scrollBy({ x: 0, y: 10 }); return;
        case "u": nodeScroll.scrollBy({ x: 0, y: -10 }); return;
        case "g": nodeScroll.scrollTop = 0; return;
        case "escape": case "left": case "h": enterExploringMode(); return;
        case "tab": enterExploringMode(); return;
        case "?": showHelpMode(); return;
        case "q": enterExploringMode(); return;
      }
      return;
    }
  });

  // ---- Cleanup ----
  function cleanup() {
    if (storage) storage.close();
    renderer.setTerminalTitle("");
    renderer.destroy();
    process.exit(0);
  }

  // ===========================================================================
  // Initial screen
  // ===========================================================================

  if (dbPath) {
    openExploration(dbPath);
  } else if (dbs.length === 1 && dbs[0].explorations.length === 1) {
    // Single DB with single exploration — open directly
    openExploration(dbs[0].path, dbs[0].explorations[0].id);
  } else {
    // Show home screen
    mode = "home";
    showScreen("home");
  }
}
