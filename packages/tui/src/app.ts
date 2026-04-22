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
import { t, fg, dim, bold, italic, underline, strikethrough, cyan, green, yellow, magenta } from "@opentui/core";
import type { KeyEvent, SelectOption } from "@opentui/core";
import { ToasterRenderable, toast } from "@opentui-ui/toast";
import { Storage, Graph, Orchestrator, Sync, Exporter, CanvasExporter, SynthesisEngine } from "@lain/core";
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
// Markdown → StyledText renderer
// ============================================================================

/**
 * Render markdown content into OpenTUI styled text.
 * Handles: headings, bold, italic, strikethrough, inline code, code blocks,
 * lists, blockquotes, horizontal rules, and links.
 */
function renderMarkdown(md: string): string {
  if (!md) return "";
  const lines = md.split("\n");
  const output: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block fence
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
        codeLines = [];
      } else {
        // Close code block — render it
        output.push(`  ┌─${codeBlockLang ? ` ${codeBlockLang} ` : ""}${"─".repeat(Math.max(0, 36 - codeBlockLang.length))}`);
        for (const cl of codeLines) {
          output.push(`  │ ${cl}`);
        }
        output.push(`  └${"─".repeat(40)}`);
        inCodeBlock = false;
        codeBlockLang = "";
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Horizontal rule
    if (/^---+$|^\*\*\*+$|^___+$/.test(line.trim())) {
      output.push("  ─────────────────────────────────────────");
      continue;
    }

    // Headings
    const h1Match = line.match(/^# (.+)/);
    if (h1Match) {
      const text = renderInline(h1Match[1]);
      output.push("");
      output.push(`  ${text}`);
      output.push(`  ${"━".repeat(Math.min(50, h1Match[1].length))}`);
      output.push("");
      continue;
    }
    const h2Match = line.match(/^## (.+)/);
    if (h2Match) {
      output.push("");
      output.push(`  ${renderInline(h2Match[1])}`);
      output.push("");
      continue;
    }
    const h3Match = line.match(/^### (.+)/);
    if (h3Match) {
      output.push(`  ${renderInline(h3Match[1])}`);
      continue;
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      const content = line.slice(2);
      output.push(`  ▐ ${renderInline(content)}`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[*\-+] (.+)/);
    if (ulMatch) {
      const indent = "  ".repeat(Math.floor(ulMatch[1].length / 2));
      output.push(`  ${indent}• ${renderInline(ulMatch[2])}`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)(\d+)\. (.+)/);
    if (olMatch) {
      const indent = "  ".repeat(Math.floor(olMatch[1].length / 2));
      output.push(`  ${indent}${olMatch[2]}. ${renderInline(olMatch[3])}`);
      continue;
    }

    // Regular paragraph line
    if (line.trim() === "") {
      output.push("");
    } else {
      output.push(`  ${renderInline(line)}`);
    }
  }

  // Handle unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    output.push(`  ┌─${codeBlockLang ? ` ${codeBlockLang} ` : ""}${"─".repeat(Math.max(0, 36 - codeBlockLang.length))}`);
    for (const cl of codeLines) output.push(`  │ ${cl}`);
    output.push(`  └${"─".repeat(40)}`);
  }

  return output.join("\n");
}

/**
 * Render inline markdown: bold, italic, strikethrough, inline code, links.
 * Returns a plain string (styled via ANSI when we upgrade, for now semantic).
 */
function renderInline(text: string): string {
  return text
    // Inline code (must be first to prevent inner patterns matching)
    .replace(/`([^`]+)`/g, "‹$1›")
    // Bold+italic
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/___(.+?)___/g, "$1")
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    // Italic
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    // Strikethrough
    .replace(/~~(.+?)~~/g, "$1")
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ‹$2›");
}

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

type AppMode = "home" | "exploring" | "reading" | "editing" | "graph" | "help" | "palette" | "creating" | "synthesis";

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

function buildNodeContent(node: LainNode, graph: Graph, allNodes: LainNode[], storage?: Storage): StyledText {
  const ancestors = graph.getAncestorChain(node.id);
  let breadcrumb = "";
  if (ancestors.length > 0) {
    breadcrumb = [...ancestors, node].map((n) => {
      const name = n.title || n.id;
      return name.length > 40 ? name.slice(0, 39) + "…" : name;
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

  // Persistent notes attached to this node
  let notesStr = "";
  if (storage) {
    const nodeAnnotations = storage.getNodeAnnotations(node.id);
    if (nodeAnnotations.length > 0) {
      notesStr += `\n────────────────────────────────\nnotes (${nodeAnnotations.length})\n`;
      for (const na of nodeAnnotations) {
        notesStr += `  ◆ ${na.content}\n`;
      }
    }
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
${node.content ? renderMarkdown(node.content) : dim("(no content)")}
${crosslinksStr}${notesStr}${childrenStr}`;
}

function buildHelpContent(): StyledText {
  return t`${bold(fg(c.bright)("lain — keyboard reference"))}

${bold(fg(c.accent)("tree panel"))}
  ${fg(c.yellow)("j/k  ↑/↓")}     navigate nodes
  ${fg(c.yellow)("enter  →")}     open in content panel
  ${fg(c.yellow)("tab")}          switch to content panel
  ${fg(c.yellow)("g")}            graph view
  ${fg(c.yellow)("p")}            prune selected node
  ${fg(c.yellow)("e")}            extend (add children)
  ${fg(c.yellow)("r")}            redirect (regenerate)
  ${fg(c.yellow)("x")}            export to obsidian
  ${fg(c.yellow)("s")}            sync with obsidian
  ${fg(c.yellow)("y")}            synthesize (find connections)
  ${fg(c.yellow)("ctrl+p")}       command palette

${bold(fg(c.accent)("content panel"))}
  ${fg(c.yellow)("j/k  ↑/↓")}     scroll content
  ${fg(c.yellow)("d/u")}          half page down/up
  ${fg(c.yellow)("g")}            scroll to top
  ${fg(c.yellow)("i")}            edit mode
  ${fg(c.yellow)("esc  ←  h")}    back to tree
  ${fg(c.yellow)("ctrl+p")}       command palette

${bold(fg(c.accent)("edit mode"))}
  ${fg(c.yellow)("esc")}          save and exit
  ${fg(c.yellow)("ctrl+s")}       save and exit

${bold(fg(c.accent)("graph view"))}
  ${fg(c.yellow)("j/k  ↑/↓")}     select next/prev node
  ${fg(c.yellow)("h/l  ←/→")}     spatial navigation (move toward direction)
  ${fg(c.yellow)("enter")}        open node in reading mode
  ${fg(c.yellow)("esc  q")}       back to tree

${bold(fg(c.accent)("general"))}
  ${fg(c.yellow)("?")}            this help
  ${fg(c.yellow)("q")}            back / quit
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
    content: t`${bold(fg(c.accent)("lain"))}  ${dim("everything is connected")}`,
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
  // GRAPH VIEW
  // ===========================================================================

  const graphContainer = new BoxRenderable(renderer, {
    id: "graph-container", width: "100%", height: "100%", flexDirection: "column",
  });

  const graphHeader = new BoxRenderable(renderer, { id: "graph-header", width: "100%", height: 1, marginTop: 1, marginBottom: 1 });
  graphContainer.add(graphHeader);
  const graphHeaderText = new TextRenderable(renderer, { id: "graph-header-text", content: "" });
  graphHeader.add(graphHeaderText);

  const graphBody = new BoxRenderable(renderer, {
    id: "graph-body", width: "100%", flexGrow: 1, flexDirection: "row", overflow: "hidden",
  });
  graphContainer.add(graphBody);

  const graphFooter = new BoxRenderable(renderer, { id: "graph-footer", width: "100%", height: 1, marginTop: 1, marginBottom: 1, paddingLeft: 2 });
  graphContainer.add(graphFooter);
  const graphFooterText = new TextRenderable(renderer, {
    id: "graph-footer-text",
    content: t`  ${dim("j/k")} select node  ${fg(c.muted)("·")}  ${dim("enter")} open  ${fg(c.muted)("·")}  ${dim("esc")} back  ${fg(c.muted)("·")}  ${dim("ctrl+p")} palette`,
  });
  graphFooter.add(graphFooterText);

  let graphView: GraphView | null = null;

  // ===========================================================================
  // EDIT MODE (textarea overlay in node panel)
  // ===========================================================================

  const editTextarea = new TextareaRenderable(renderer, {
    id: "edit-textarea", width: "100%", height: "100%",
    textColor: c.fg, backgroundColor: "transparent",
  });
  let editingNodeId: string | null = null;

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
    backgroundColor: "transparent", textColor: c.dim,
    focusedBackgroundColor: "transparent", focusedTextColor: c.dim,
    selectedBackgroundColor: "#2a2e46", selectedTextColor: c.bright,
    descriptionColor: c.muted, selectedDescriptionColor: c.fg,
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
  const availableExtensions = ["freeform", "worldbuilding", "debate", "research"];
  let createExtIdx = 0;
  const createExtDisplay = new TextRenderable(renderer, {
    id: "create-ext-display", content: "", fg: c.fg,
  });
  createParamsRow.add(createExtDisplay);

  function updateExtDisplay(focused = false) {
    const parts = availableExtensions.map((ext, i) => {
      if (i === createExtIdx) {
        return focused ? fg(c.accent)(`▸${ext}`) : fg(c.bright)(`▸${ext}`);
      }
      return dim(` ${ext}`);
    });
    createExtDisplay.content = t`${parts.join(" ")}`;
  }
  updateExtDisplay();

  const createHint = new TextRenderable(renderer, {
    id: "create-hint",
    content: "tab to switch fields  ·  enter to create  ·  esc to cancel",
    fg: c.dim,
  });
  createForm.add(createHint);

  // ===========================================================================
  // SYNTHESIS VIEW
  // ===========================================================================

  const synthContainer = new BoxRenderable(renderer, {
    id: "synth-container", width: "100%", height: "100%",
    flexDirection: "column",
  });

  const synthHeader = new BoxRenderable(renderer, {
    id: "synth-header", width: "100%", height: 1,
    flexDirection: "row", backgroundColor: c.surface,
  });
  synthContainer.add(synthHeader);
  const synthHeaderText = new TextRenderable(renderer, {
    id: "synth-header-text",
    content: t`${bold(fg(c.accent)("synthesis"))}`,
  });
  synthHeader.add(synthHeaderText);

  const synthBody = new BoxRenderable(renderer, {
    id: "synth-body", width: "100%", height: "100%",
    flexDirection: "row",
  });
  synthContainer.add(synthBody);

  // Left: annotation list
  const synthListBox = new BoxRenderable(renderer, {
    id: "synth-list-box", width: 44, height: "100%",
    border: true, borderStyle: "rounded", borderColor: c.accent,
  });
  synthBody.add(synthListBox);
  const synthSelect = new SelectRenderable(renderer, {
    id: "synth-select", width: "100%", height: "100%",
    options: [], selectedIndex: 0,
    backgroundColor: "transparent", textColor: c.fg,
    focusedBackgroundColor: "transparent", focusedTextColor: c.fg,
    selectedBackgroundColor: c.surface, selectedTextColor: c.bright,
    descriptionColor: c.dim, selectedDescriptionColor: c.accentDim,
    showDescription: true, showScrollIndicator: true, wrapSelection: false,
    itemSpacing: 0,
  });
  synthListBox.add(synthSelect);

  // Right: detail view
  const synthDetailBox = new BoxRenderable(renderer, {
    id: "synth-detail-box", width: "100%", height: "100%",
    border: true, borderStyle: "rounded", borderColor: c.muted,
  });
  synthBody.add(synthDetailBox);
  const synthDetailScroll = new ScrollBoxRenderable(renderer, {
    id: "synth-detail-scroll", width: "100%", height: "100%",
  });
  synthDetailBox.add(synthDetailScroll);
  const synthDetailText = new TextRenderable(renderer, {
    id: "synth-detail-text", content: "",
  });
  synthDetailScroll.add(synthDetailText);

  const synthFooter = new BoxRenderable(renderer, {
    id: "synth-footer", width: "100%", height: 1,
  });
  synthContainer.add(synthFooter);
  const synthFooterText = new TextRenderable(renderer, {
    id: "synth-footer-text",
    content: t`  ${dim("j/k")} navigate  ${fg(c.muted)("·")}  ${dim("m")} merge  ${fg(c.muted)("·")}  ${dim("d")} dismiss  ${fg(c.muted)("·")}  ${dim("M")} merge all  ${fg(c.muted)("·")}  ${dim("enter")} jump to node  ${fg(c.muted)("·")}  ${dim("esc")} back`,
  });
  synthFooter.add(synthFooterText);

  // Synthesis state
  let currentSynthesisId: string | null = null;
  let synthAnnotations: any[] = [];
  let synthSummary = "";
  let dismissedIds = new Set<string>(); // track dismissed vs merged
  let pendingMergePreview: { annotationId: string; explorationId: string; preview: any } | null = null;

  function enterSynthesisMode(synthesisId: string) {
    if (!storage) return;
    currentSynthesisId = synthesisId;
    const engine = new SynthesisEngine({ storage, agent: null });
    const result = engine.getSynthesis(synthesisId);
    if (!result) { toast.error("Synthesis not found"); return; }

    synthSummary = result.synthesis.content;
    synthAnnotations = result.annotations;

    // Build select options: summary at top, then annotations
    const options: SelectOption[] = [
      { name: "◈ Summary", description: `${synthAnnotations.length} annotations`, value: "__summary__" },
    ];
    for (const a of synthAnnotations) {
      const typeColors: Record<string, string> = { crosslink: "↔", contradiction: "⚡", note: "●", merge_suggestion: "⊕" };
      const icon = typeColors[a.type] || "•";
      const sourceTitle = graph?.getNode(a.sourceNodeId)?.title?.slice(0, 18) || a.sourceNodeId || "";
      const targetTitle = a.targetNodeId ? (graph?.getNode(a.targetNodeId)?.title?.slice(0, 18) || a.targetNodeId) : "";
      const nodeStr = targetTitle ? `${sourceTitle} → ${targetTitle}` : sourceTitle;
      const status = a.merged ? (dismissedIds.has(a.id) ? " ✕" : " ✓") : "";
      options.push({
        name: `${icon} ${a.type}${status}`,
        description: nodeStr,
        value: a.id,
      });
    }
    synthSelect.options = options;
    synthSelect.setSelectedIndex(0);
    updateSynthDetail();

    previousMode = mode;
    mode = "synthesis";
    showScreen("synthesis");
  }

  function updateSynthDetail() {
    const idx = synthSelect.getSelectedIndex();
    if (idx === 0) {
      // Show summary
      const annotCounts: Record<string, number> = {};
      for (const a of synthAnnotations) annotCounts[a.type] = (annotCounts[a.type] || 0) + 1;
      const countStr = Object.entries(annotCounts).map(([t, c]) => `${c} ${t}`).join("  ·  ");
      const unmerged = synthAnnotations.filter((a: any) => !a.merged).length;

      synthDetailText.content = t`${bold(fg(c.bright)("Synthesis Summary"))}
${fg(c.muted)("─".repeat(40))}

${synthSummary}

${fg(c.muted)("─".repeat(40))}
${fg(c.blue)("annotations")}  ${countStr}
${fg(c.blue)("unmerged")}  ${String(unmerged)} of ${String(synthAnnotations.length)}

${dim("Use j/k to browse annotations, m to merge, d to dismiss, M to merge all.")}`;
    } else {
      // Show annotation detail
      const annotation = synthAnnotations[idx - 1];
      if (!annotation) return;

      const sourceNode = graph?.getNode(annotation.sourceNodeId);
      const targetNode = annotation.targetNodeId ? graph?.getNode(annotation.targetNodeId) : null;

      const typeLabel = annotation.type.replace("_", " ");
      const typeColor = annotation.type === "crosslink" ? c.cyan : annotation.type === "contradiction" ? c.red : annotation.type === "note" ? c.yellow : c.accent;

      const sourceName = sourceNode ? (sourceNode.title || sourceNode.id) : "";
      const targetName = targetNode ? (targetNode.title || targetNode.id) : "";
      const statusLabel = annotation.merged ? "merged ✓" : "pending";
      const statusColor = annotation.merged ? c.green : c.yellow;

      synthDetailText.content = t`${bold(fg(typeColor)(typeLabel))}  ${fg(statusColor)(statusLabel)}
${fg(c.muted)("─".repeat(40))}
${sourceName ? "\nsource" : ""}${sourceName ? "  " + sourceName : ""}${targetName ? "\ntarget" : ""}${targetName ? "  " + targetName : ""}

${annotation.content || "(no content)"}

${fg(c.muted)("─".repeat(40))}
${annotation.merged ? dim("Already merged.") : dim("m — merge  ·  d — dismiss  ·  enter — jump to source node")}`;
    }
    synthDetailScroll.scrollTop = 0;
    // Update footer based on context
    if (idx === 0) {
      const unmerged = synthAnnotations.filter((a: any) => !a.merged).length;
      synthFooterText.content = unmerged > 0
        ? t`  ${dim("j/k")} browse annotations  ${fg(c.muted)("·")}  ${dim("M")} merge all (${String(unmerged)})  ${fg(c.muted)("·")}  ${dim("esc")} back  ${fg(c.muted)("·")}  ${dim("ctrl+d/u")} scroll`
        : t`  ${dim("j/k")} browse annotations  ${fg(c.muted)("·")}  ${fg(c.green)("all merged")}  ${fg(c.muted)("·")}  ${dim("esc")} back`;
    } else {
      const annotation = synthAnnotations[idx - 1];
      if (annotation?.merged) {
        synthFooterText.content = t`  ${dim("j/k")} navigate  ${fg(c.muted)("·")}  ${dim("enter")} jump to node  ${fg(c.muted)("·")}  ${dim("esc")} back  ${fg(c.muted)("·")}  ${dim("ctrl+d/u")} scroll`;
      } else {
        synthFooterText.content = t`  ${dim("j/k")} navigate  ${fg(c.muted)("·")}  ${dim("m")} merge  ${fg(c.muted)("·")}  ${dim("d")} dismiss  ${fg(c.muted)("·")}  ${dim("enter")} jump to node  ${fg(c.muted)("·")}  ${dim("esc")} back`;
      }
    }
  }

  synthSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
    if (mode === "synthesis") updateSynthDetail();
  });

  // ===========================================================================
  // Screen management
  // ===========================================================================

  function showScreen(screen: "home" | "exploration" | "palette" | "create" | "graph" | "synthesis") {
    try { rootBox.remove("home-container"); } catch {}
    try { rootBox.remove("exp-container"); } catch {}
    try { rootBox.remove("graph-container"); } catch {}
    try { rootBox.remove("palette-overlay"); } catch {}
    try { rootBox.remove("create-box"); } catch {}
    try { rootBox.remove("synth-container"); } catch {}

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
    } else if (screen === "graph") {
      rootBox.add(graphContainer);
      homeSelect.focusable = false;
      homeSelect.blur();
      treeSelect.focusable = false;
      treeSelect.blur();
    } else if (screen === "palette") {
      if (previousMode === "home") rootBox.add(homeContainer);
      else if (previousMode === "graph") rootBox.add(graphContainer);
      else if (previousMode === "synthesis") rootBox.add(synthContainer);
      else rootBox.add(explorationContainer);
      rootBox.add(paletteOverlay);
      paletteInput.value = "";
      paletteInput.focus();
      updatePaletteOptions("");
    } else if (screen === "create") {
      if (previousMode === "home") rootBox.add(homeContainer);
      else if (previousMode === "graph") rootBox.add(graphContainer);
      else rootBox.add(explorationContainer);
      rootBox.add(createBox);
      createSeedInput.value = "";
      createSeedInput.focus();
    } else if (screen === "synthesis") {
      rootBox.add(synthContainer);
      homeSelect.focusable = false;
      homeSelect.blur();
      treeSelect.focusable = false;
      treeSelect.blur();
      synthSelect.focusable = true;
      synthSelect.focus();
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

    nodeText.content = buildNodeContent(root, graph, allNodes, storage ?? undefined);
    expFooterText.content = exploringFooter();

    mode = "exploring";
    showScreen("exploration");
    treeSelect.focus();
    treePanel.borderColor = c.accent;
    nodePanel.borderColor = c.muted;
  }

  function refreshHomeScreen() {
    const freshDbs = discoverDbs(process.cwd());
    const newOpts: SelectOption[] = [];
    for (const db of freshDbs) {
      for (const exp of db.explorations) {
        const truncName = exp.name.length > 50 ? exp.name.slice(0, 47) + "…" : exp.name;
        newOpts.push({
          name: truncName,
          description: `${exp.nodeCount} nodes · n=${exp.n} m=${exp.m} · ${exp.ext} · ${db.name}`,
          value: { dbPath: db.path, expId: exp.id },
        });
      }
    }
    newOpts.push({
      name: "✦  Create new exploration",
      description: "Start a new idea graph from scratch",
      value: { action: "create" },
    });
    homeSelect.options = newOpts;
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
    nodeText.content = buildNodeContent(node, graph, allNodes, storage ?? undefined);
    nodeScroll.scrollTop = 0;
  }

  // ---- Footers ----
  function exploringFooter(): StyledText {
    return t`  ${dim("j/k")} navigate  ${fg(c.muted)("·")}  ${dim("enter/→")} open  ${fg(c.muted)("·")}  ${dim("g")}raph  ${fg(c.muted)("·")}  ${dim("p")}rune ${dim("e")}xtend ${dim("r")}edirect  ${fg(c.muted)("·")}  ${dim("y")} synthesize  ${fg(c.muted)("·")}  ${dim("ctrl+p")} palette`;
  }
  function readingFooter(): StyledText {
    return t`  ${dim("j/k")} scroll  ${fg(c.muted)("·")}  ${dim("d/u")} page  ${fg(c.muted)("·")}  ${dim("i")} edit  ${fg(c.muted)("·")}  ${dim("esc/←")} back  ${fg(c.muted)("·")}  ${dim("ctrl+p")} palette`;
  }

  // ---- Tree selection changed ----
  treeSelect.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
    const node = selectedNode();
    if (node) showNode(node);
  });

  // ---- Palette ----
  function buildPaletteActions(): PaletteAction[] {
    const actions: PaletteAction[] = [];
    // When palette is open, check what mode we came from
    const contextMode = mode === "palette" ? previousMode : mode;

    if (contextMode === "exploring" || contextMode === "reading" || contextMode === "synthesis") {
      const node = selectedNode();
      actions.push({ name: "Graph view", description: "Visualize exploration as a radial graph", key: "g", action: enterGraphMode });
      if (contextMode === "reading") {
        actions.push({ name: "Edit node", description: `Edit content of ${node?.title || "selected"}`, key: "i", action: enterEditMode });
      }
      actions.push({ name: "Prune node", description: `Prune ${node?.title || "selected"} and descendants`, key: "p", action: doPrune });
      actions.push({ name: "Extend node", description: `Add ${exploration?.n || 3} children to ${node?.title || "selected"}`, key: "e", action: doExtend });
      actions.push({ name: "Redirect node", description: `Regenerate ${node?.title || "selected"} with fresh content`, key: "r", action: doRedirect });
      actions.push({ name: "Synthesize", description: "Run synthesis pass — find connections across branches", key: "y", action: doSynthesize });
      actions.push({ name: "View synthesis", description: "Open synthesis results view", key: "Y", action: doViewSynthesis });
      actions.push({ name: "Export to markdown", description: "Export as Obsidian-compatible markdown files", key: "x", action: doExport });
      actions.push({ name: "Export to canvas", description: "Export as Obsidian .canvas file (radial graph)", action: doCanvasExport });
      actions.push({ name: "Sync with Obsidian", description: "Bidirectional sync with filesystem", key: "s", action: doSync });
      actions.push({ name: "Back to home", description: "Return to exploration list", action: () => { mode = "home"; showScreen("home"); } });
    }

    actions.push({ name: "New exploration", description: "Create a new idea graph from scratch", action: () => { previousMode = mode; mode = "creating"; showScreen("create"); } });
    actions.push({ name: "Help", description: "Show all keyboard shortcuts", key: "?", action: () => showHelpMode() });
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
    } else if (mode === "synthesis") {
      showScreen("synthesis");
    } else if (mode === "graph") {
      showScreen("graph");
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

  function exitHelpMode() {
    mode = previousMode;
    if (mode === "reading") {
      treePanel.borderColor = c.muted;
      nodePanel.borderColor = c.accent;
      treeSelect.focusable = false;
      expFooterText.content = readingFooter();
      const node = selectedNode();
      if (node) showNode(node);
    } else {
      enterExploringMode();
      const node = selectedNode();
      if (node) showNode(node);
    }
  }

  // ---- Graph mode ----
  function enterGraphMode() {
    if (!graph || !exploration) return;
    previousMode = mode;
    mode = "graph";
    treeSelect.blur();
    treeSelect.focusable = false;

    const currentW = renderer.width ?? termW;
    const currentH = renderer.height ?? 24;
    const peekWidth = 34; // peek panel width + border + gap
    const gw = currentW - peekWidth - 4; // graph canvas width
    const gh = currentH - 6;

    const crosslinks = graph.getCrosslinks(exploration.id);
    graphView = new GraphView({
      renderer,
      nodes: allNodes,
      crosslinks,
      graphWidth: gw,
      graphHeight: gh,
      onNodeSelect: (nodeId) => {
        exitGraphMode();
        const treeIdx = treeItems.findIndex((t) => t.nodeId === nodeId);
        if (treeIdx >= 0) treeSelect.setSelectedIndex(treeIdx);
        enterReadingMode();
      },
    });

    const { fb, peek } = graphView.getRenderables();
    graphBody.add(fb);
    graphBody.add(peek);

    const shortName = exploration.name.length > 50 ? exploration.name.slice(0, 47) + "…" : exploration.name;
    graphHeaderText.content = t`  ${fg(c.accent)("lain")}  ${dim(shortName)}  ${fg(c.muted)("·")}  ${fg(c.cyan)("graph view")}`;

    showScreen("graph");
    graphView.start();
  }

  function exitGraphMode() {
    if (graphView) {
      graphView.stop();
      try { graphBody.remove("graph-fb"); } catch {}
      try { graphBody.remove("graph-peek"); } catch {}
      graphView = null;
    }
    enterExploringMode();
    showScreen("exploration");
  }

  // ---- Edit mode ----
  function enterEditMode() {
    const node = selectedNode();
    if (!node || !graph) return;
    if (node.id === "root") {
      toast.warning("Cannot edit root node (it contains the seed)");
      return;
    }

    previousMode = mode;
    mode = "editing";
    editingNodeId = node.id;

    // Replace nodeText with editTextarea in the scroll container
    try { nodeScroll.content.remove("node-text"); } catch {}
    editTextarea.initialValue = node.content || "";
    nodeScroll.content.add(editTextarea);
    editTextarea.focus();

    treeSelect.blur();
    treeSelect.focusable = false;
    treePanel.borderColor = c.muted;
    nodePanel.borderColor = c.yellow;

    expFooterText.content = t`  ${fg(c.yellow)("EDITING")}  ${dim("type to edit")}  ${fg(c.muted)("·")}  ${dim("esc/ctrl+s")} save & exit`;
  }

  function saveAndExitEdit() {
    if (editingNodeId && graph && storage) {
      const newContent = editTextarea.plainText;
      storage.updateNodeFromSync(editingNodeId, { content: newContent });
      toast.success("Saved");
    }

    // Swap textarea back to text renderable
    try { nodeScroll.content.remove("edit-textarea"); } catch {}
    nodeScroll.content.add(nodeText);
    editTextarea.blur();
    editingNodeId = null;

    // Refresh and go back to reading
    const node = selectedNode();
    if (node) showNode(node);
    mode = "reading";
    treePanel.borderColor = c.muted;
    nodePanel.borderColor = c.accent;
    treeSelect.focusable = false;
    expFooterText.content = readingFooter();
  }

  // ---- Confirmation state ----
  let pendingConfirm: { message: string; action: () => void } | null = null;
  let generating = false; // blocks explore-mode actions during doCreate

  function showConfirm(message: string, action: () => void) {
    pendingConfirm = { message, action };
    expFooterText.content = t`  ${fg(c.yellow)(message)}  ${dim("y")} confirm  ${fg(c.muted)("·")}  ${dim("n/esc")} cancel`;
  }

  // ---- Write operations ----
  async function doPrune() {
    const node = selectedNode();
    if (!node || node.id === "root" || !graph) { toast.warning("Cannot prune root node"); return; }
    const childCount = allNodes.filter((n) => n.parentId === node.id && n.status !== "pruned").length;
    const desc = childCount > 0 ? ` and ${childCount} descendant${childCount > 1 ? "s" : ""}` : "";
    showConfirm(`Prune "${(node.title || node.id).slice(0, 25)}"${desc}?`, () => {
      graph!.pruneNode(node.id);
      toast.success(`Pruned ${node.title || node.id}`);
      // Navigate to sibling or parent
      const siblings = allNodes.filter((n) => n.parentId === node.parentId && n.status !== "pruned" && n.id !== node.id);
      const parent = allNodes.find((n) => n.id === node.parentId);
      const target = siblings[0] || parent;
      refreshTree();
      if (target) {
        const idx = treeItems.findIndex((t) => t.nodeId === target.id);
        if (idx >= 0) treeSelect.setSelectedIndex(idx);
      }
      const current = selectedNode();
      if (current) showNode(current);
    });
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
    showConfirm(`Regenerate "${(node.title || node.id).slice(0, 25)}"? Content will be overwritten.`, async () => {
      const loadingId = toast.loading("Regenerating...");
      try {
        const config = loadConfig();
        const credentials = loadCredentials();
        const agent = createProviderFromCredentials(config, credentials);
        const orchestrator = new Orchestrator({ dbPath, agent });
        await orchestrator.redirectNode(exploration!.id, node.id);
        orchestrator.close();
        if (storage) storage.close();
        storage = new Storage(dbPath);
        graph = new Graph(storage);
        toast.dismiss(loadingId);
        toast.success("Regenerated");
        refreshTree();
        const current = selectedNode();
        if (current) showNode(current);
      } catch (err: any) {
        toast.dismiss(loadingId);
        toast.error(`Redirect failed: ${err.message}`);
      }
    });
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

  async function doSynthesize() {
    if (!storage || !exploration) return;
    const loadingId = toast.loading("Running synthesis...");
    try {
      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = createProviderFromCredentials(config, credentials);
      const engine = new SynthesisEngine({ storage, agent });
      const synthesisId = await engine.synthesize(exploration.id);
      const result = engine.getSynthesis(synthesisId);
      toast.dismiss(loadingId);
      if (result) {
        const n = result.annotations.length;
        toast.success(`Synthesis: ${n} annotation${n === 1 ? "" : "s"} found`);
        refreshTree();
        // Enter synthesis view
        enterSynthesisMode(synthesisId);
      } else {
        toast.error("Synthesis returned no result");
      }
    } catch (err: any) {
      toast.dismiss(loadingId);
      toast.error(`Synthesis failed: ${err.message}`);
    }
  }

  function doViewSynthesis() {
    if (!storage || !exploration) return;
    const engine = new SynthesisEngine({ storage, agent: null });
    const syntheses = engine.getSyntheses(exploration.id);
    if (syntheses.length === 0) {
      toast.warning("No syntheses yet. Press y to run one.");
      return;
    }
    // Open the most recent synthesis
    enterSynthesisMode(syntheses[0].id);
  }

  function doCanvasExport() {
    if (!storage || !exploration) return;
    try {
      const baseName = path.basename(dbPath, ".db");
      const mdDir = path.join(path.dirname(dbPath), baseName);
      const canvasPath = path.join(path.dirname(dbPath), baseName + ".canvas");
      // Export markdown files first
      const exporter = new Exporter(storage);
      exporter.export(exploration.id, mdDir);
      // Then canvas
      const canvasExporter = new CanvasExporter(storage);
      canvasExporter.export(exploration.id, canvasPath, baseName);
      toast.success(`Canvas: ${canvasPath}`);
    } catch (err: any) {
      toast.error(`Canvas export failed: ${err.message}`);
    }
  }

  async function doCreate(seed: string, n?: number, m?: number, ext?: string) {
    if (!seed.trim()) { toast.warning("Seed cannot be empty"); return; }
    generating = true;
    const config = loadConfig();
    const credentials = loadCredentials();
    const agent = createProviderFromCredentials(config, credentials);

    const useN = n || config.defaultN;
    const useM = m || config.defaultM;
    const useExt = ext || config.defaultExtension;

    const slugName = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
    let newDbPath = path.resolve(`${slugName}.db`);
    // Avoid collision with existing file
    if (fs.existsSync(newDbPath)) {
      newDbPath = path.resolve(`${slugName}-${generateId().slice(0, 4)}.db`);
    }
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

    let nodesGenerated = 0;
    let totalExpected = 0;
    let streamingBuffers = new Map<string, string>(); // per-node buffers
    let activeStreamNodeId = "";
    let streamingNodeTitle = "";
    for (let d = 1; d <= useM; d++) totalExpected += Math.pow(useN, d);

    try {
      const orchestrator = new Orchestrator({
        dbPath: newDbPath, agent, concurrency: 5, streaming: true,
        onEvent: (event) => {
          if (event.type === "node:content-chunk") {
            const chunkData = event.data as { chunk?: string; nodeId?: string } | undefined;
            const nodeId = event.nodeId || "";
            if (chunkData?.chunk) {
              const buf = (streamingBuffers.get(nodeId) || "") + chunkData.chunk;
              streamingBuffers.set(nodeId, buf);
              // Only display the first active stream to avoid interleaving
              if (!activeStreamNodeId || activeStreamNodeId === nodeId) {
                activeStreamNodeId = nodeId;
                if (chunkData.chunk.includes("\n") || buf.length < 50) {
                  const lines = buf.split("\n");
                  const visibleLines = lines.slice(-20).join("\n");
                  nodeText.content = t`${bold(fg(c.bright)(seed))}

${fg(c.yellow)(`Generating... ${nodesGenerated}/${totalExpected} nodes complete`)}
${dim(`current: ${streamingNodeTitle || "..."}`)}

${visibleLines}`;
                }
              }
            }
          }
          if (event.type === "node:generating") {
            streamingNodeTitle = event.nodeId || "";
          }
          if (event.type === "node:complete") {
            nodesGenerated++;
            const nodeId = event.nodeId || "";
            streamingBuffers.delete(nodeId);
            if (activeStreamNodeId === nodeId) {
              // Switch to next active stream if any
              const nextActive = streamingBuffers.keys().next().value;
              activeStreamNodeId = nextActive || "";
            }
            const data = event.data as { title?: string } | undefined;
            const title = data?.title || "untitled";
            streamingNodeTitle = title;
            const short = title.length > 30 ? title.slice(0, 29) + "…" : title;
            // Update the generating view with progress
            expHeaderText.content = t`  ${fg(c.accent)("lain")}  ${dim(shortName)}  ${fg(c.muted)("·")}  ${fg(c.yellow)(`generating ${nodesGenerated}/${totalExpected}`)}  ${fg(c.muted)("·")}  ${dim(`n=${useN} m=${useM}`)}`;
            nodeText.content = t`${bold(fg(c.bright)(seed))}

${fg(c.yellow)(`Generating... ${nodesGenerated}/${totalExpected} nodes complete`)}

Latest: ${short}
`;
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
      generating = false;
      toast.success("Exploration complete!");
      refreshHomeScreen();
      openExploration(newDbPath, expId);
    } catch (err: any) {
      generating = false;
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

  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    // ---- Ctrl+P: command palette from anywhere ----
    if (key.name === "p" && key.ctrl) {
      if (mode === "palette") { closePalette(); return; }
      openPalette();
      return;
    }

    // ---- Palette mode — stop propagation only for handled keys ----
    if (mode === "palette") {
      if (key.name === "escape") { key.stopPropagation(); closePalette(); return; }
      if (key.name === "return") { key.stopPropagation(); executePaletteAction(); return; }
      if (key.name === "down" || (key.name === "n" && key.ctrl)) { key.stopPropagation(); paletteSelect.moveDown(); return; }
      if (key.name === "up" || (key.name === "p" && key.ctrl)) { key.stopPropagation(); paletteSelect.moveUp(); return; }
      // Don't stopPropagation for other keys — let InputRenderable handle typing
      return;
    }

    // ---- Creating mode ----
    if (mode === "creating") {
      if (key.name === "escape") {
        key.stopPropagation();
        mode = previousMode;
        try { rootBox.remove("create-box"); } catch {}
        if (mode === "home") showScreen("home");
        else showScreen("exploration");
        return;
      }
      if (key.name === "tab") {
        key.stopPropagation();
        // Cycle focus between seed, n, m fields (ext uses ←/→ when m is focused → tab goes to ext zone)
        const createFields: any[] = [createSeedInput, createNInput, createMInput];
        const currentFocus = createFields.findIndex((f) => f._focused);
        if (currentFocus === 2) {
          // From m, tab goes to ext "zone" — blur everything, ext is active
          createFields.forEach((f: any) => f.blur());
          updateExtDisplay(true);
        } else if (currentFocus === -1) {
          // From ext zone, tab wraps to seed
          createFields[0].focus();
          updateExtDisplay(false);
        } else {
          const next = (currentFocus + 1) % createFields.length;
          createFields.forEach((f: any) => f.blur());
          createFields[next].focus();
          updateExtDisplay(false);
        }
        return;
      }
      // When no input is focused (ext zone active), left/right cycles extensions
      const anyInputFocused = (createSeedInput as any)._focused || (createNInput as any)._focused || (createMInput as any)._focused;
      if (!anyInputFocused && (key.name === "left" || key.name === "right")) {
        key.stopPropagation();
        if (key.name === "right") createExtIdx = (createExtIdx + 1) % availableExtensions.length;
        else createExtIdx = (createExtIdx - 1 + availableExtensions.length) % availableExtensions.length;
        updateExtDisplay(true);
        return;
      }
      if (key.name === "return") {
        key.stopPropagation();
        const seed = createSeedInput.value;
        const n = Math.max(1, Math.min(10, parseInt(createNInput.value) || 3));
        const m = Math.max(1, Math.min(10, parseInt(createMInput.value) || 2));
        const ext = availableExtensions[createExtIdx];
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
      exitHelpMode();
      return;
    }

    // ---- Generation in progress: esc returns to home ----
    if (generating && mode === "exploring" && key.name === "escape") {
      generating = false;
      mode = "home";
      showScreen("home");
      toast.warning("Generation continues in background");
      return;
    }

    // ---- Confirmation prompt intercept ----
    if (pendingConfirm && (mode === "exploring" || mode === "reading")) {
      key.stopPropagation();
      if (key.name === "y") {
        const action = pendingConfirm.action;
        pendingConfirm = null;
        expFooterText.content = exploringFooter();
        action();
      } else {
        pendingConfirm = null;
        expFooterText.content = mode === "reading" ? readingFooter() : exploringFooter();
      }
      return;
    }

    // ---- Exploring mode ----
    if (mode === "exploring") {
      if (generating) return; // block all actions during generation
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
        case "y": if (key.shift) { doViewSynthesis(); } else { doSynthesize(); } return;
        case "g": enterGraphMode(); return;
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
        case "g": if (key.shift) { nodeScroll.scrollTop = 99999; } else { nodeScroll.scrollTop = 0; } return;
        case "escape": case "left": case "h": enterExploringMode(); return;
        case "tab": enterExploringMode(); return;
        case "?": showHelpMode(); return;
        case "q": enterExploringMode(); return;
        case "i": enterEditMode(); return;
      }
      return;
    }

    // ---- Edit mode — only intercept escape and ctrl+s, let textarea handle rest ----
    if (mode === "editing") {
      if (key.name === "escape") {
        key.stopPropagation();
        saveAndExitEdit();
        return;
      }
      if (key.name === "s" && key.ctrl) {
        key.stopPropagation();
        saveAndExitEdit();
        return;
      }
      // Let textarea handle all other keys (typing, cursor movement, etc.)
      return;
    }

    // ---- Synthesis mode ----
    if (mode === "synthesis") {
      // Handle merge preview confirmation
      if (pendingMergePreview) {
        key.stopPropagation();
        if (key.name === "y") {
          const { annotationId, explorationId, preview } = pendingMergePreview;
          pendingMergePreview = null;
          const engine = new SynthesisEngine({ storage: storage!, agent: null });

          if (preview) {
            // Generated content (contradiction/merge_suggestion)
            const nodeId = engine.applyMergePreview(annotationId, explorationId, preview);
            toast.success(`Created node: ${preview.title}`);
          } else {
            // Simple merge (crosslink/note)
            engine.mergeSingle(annotationId);
            toast.success("Merged");
          }

          const annIdx = synthAnnotations.findIndex((a: any) => a.id === annotationId);
          if (annIdx >= 0) synthAnnotations[annIdx].merged = true;
          refreshTree();
          updateSynthDetail();
          if (currentSynthesisId) enterSynthesisMode(currentSynthesisId);
        } else {
          // n or any other key cancels
          pendingMergePreview = null;
          toast.warning("Cancelled");
          updateSynthDetail();
        }
        return;
      }

      if (key.name === "escape" || key.name === "q") {
        key.stopPropagation();
        mode = "exploring";
        showScreen("exploration");
        refreshTree();
        const current = selectedNode();
        if (current) showNode(current);
        return;
      }
      if (key.name === "m" && !key.shift) {
        key.stopPropagation();
        // Merge current annotation
        const idx = synthSelect.getSelectedIndex();
        if (idx > 0 && currentSynthesisId && storage && exploration) {
          const annotation = synthAnnotations[idx - 1];
          if (annotation && !annotation.merged) {
            if (annotation.type === "contradiction" || annotation.type === "merge_suggestion") {
              // These need agent generation — show preview first
              const loadingId = toast.loading(`Generating ${annotation.type === "contradiction" ? "resolution" : "synthesis"}...`);
              try {
                const config = loadConfig();
                const credentials = loadCredentials();
                const agent = createProviderFromCredentials(config, credentials);
                const engine = new SynthesisEngine({ storage, agent });
                const preview = await engine.generateMergePreview(annotation.id, exploration.id);
                toast.dismiss(loadingId);

                const sourceTitle = graph?.getNode(annotation.sourceNodeId)?.title || annotation.sourceNodeId || "?";
                const targetTitle = graph?.getNode(annotation.targetNodeId)?.title || annotation.targetNodeId || "?";
                const parentTitle = graph?.getNode(preview.parentId)?.title || preview.parentId;
                const typeLabel = annotation.type === "contradiction" ? "Resolution" : "Synthesis";

                synthDetailText.content = t`${bold(fg(c.accent)(typeLabel))}

${dim("involved nodes")}
  ${dim("from")}  ${sourceTitle}
  ${dim("from")}  ${targetTitle}

${dim("will create")}
  ${fg(c.green)("+ new node")}  ${bold(preview.title)}
  ${dim("under")}  ${parentTitle}
  ${fg(c.green)("+ crosslink")}  → ${sourceTitle}
  ${fg(c.green)("+ crosslink")}  → ${targetTitle}

${fg(c.muted)("─".repeat(40))}

${renderMarkdown(preview.content)}

${fg(c.muted)("─".repeat(40))}
  ${fg(c.yellow)("y")} accept  ${fg(c.muted)("·")}  ${fg(c.yellow)("n")} reject`;
                synthFooterText.content = t`  ${dim("y")} accept  ${fg(c.muted)("·")}  ${dim("n")} reject`;
                pendingMergePreview = { annotationId: annotation.id, explorationId: exploration.id, preview };
              } catch (err: any) {
                toast.dismiss(loadingId);
                toast.error(`Generation failed: ${err.message}`);
              }
            } else {
              // crosslink and note: show diff then merge on confirmation
              const engine = new SynthesisEngine({ storage, agent: null });
              const diff = engine.computeDiff(annotation.id);
              const change = diff.changes[0];

              if (change?.type === "add_crosslink") {
                synthDetailText.content = t`${bold(fg(c.accent)("Add Crosslink"))}

${dim("between")}
  ${change.sourceTitle}
  ${change.targetTitle}
${change.label ? `\n${dim("reason")}\n  ${change.label}\n` : ""}
${dim("will create")}
  ${fg(c.green)("+ edge")}  ${change.sourceTitle} ↔ ${change.targetTitle}

  ${fg(c.yellow)("y")} apply  ${fg(c.muted)("·")}  ${fg(c.yellow)("n")} cancel`;
              } else if (change?.type === "add_note") {
                synthDetailText.content = t`${bold(fg(c.accent)("Attach Note"))}

${dim("to node")}
  ${change.nodeTitle}

${dim("will add")}
  ${fg(c.green)("+ note")}  ${change.content}

  ${fg(c.yellow)("y")} apply  ${fg(c.muted)("·")}  ${fg(c.yellow)("n")} cancel`;
              }

              synthFooterText.content = t`  ${dim("y")} apply  ${fg(c.muted)("·")}  ${dim("n")} cancel`;
              pendingMergePreview = { annotationId: annotation.id, explorationId: exploration!.id, preview: null };
            }
          }
        }
        return;
      }
      if (key.name === "M" || (key.name === "m" && key.shift)) {
        key.stopPropagation();
        // Merge all
        if (currentSynthesisId && storage) {
          const engine = new SynthesisEngine({ storage, agent: null });
          const { merged, skipped } = engine.mergeAll(currentSynthesisId);
          for (const a of synthAnnotations) {
            if (a.type !== "contradiction" && a.type !== "merge_suggestion") a.merged = true;
          }
          const msg = skipped > 0 ? `Merged ${merged}, ${skipped} need individual review` : `Merged all ${merged}`;
          toast.success(msg);
          updateSynthDetail();
          // Refresh list display
          enterSynthesisMode(currentSynthesisId);
        }
        return;
      }
      if (key.name === "d") {
        key.stopPropagation();
        // Dismiss current annotation
        const idx = synthSelect.getSelectedIndex();
        if (idx > 0 && currentSynthesisId && storage) {
          const annotation = synthAnnotations[idx - 1];
          if (annotation && !annotation.merged) {
            const engine = new SynthesisEngine({ storage, agent: null });
            engine.dismissAnnotation(annotation.id);
            annotation.merged = true;
            dismissedIds.add(annotation.id);
            toast.success(`Dismissed: ${annotation.type}`);
            updateSynthDetail();
            const opts = synthSelect.options;
            if (opts[idx]) opts[idx].name = opts[idx].name.replace(/^([^ ]+)/, "$1 ✕");
            synthSelect.options = opts;
          }
        }
        return;
      }
      if (key.name === "return") {
        key.stopPropagation();
        // Jump to the source node of the selected annotation
        const idx = synthSelect.getSelectedIndex();
        if (idx > 0) {
          const annotation = synthAnnotations[idx - 1];
          if (annotation?.sourceNodeId) {
            mode = "exploring";
            showScreen("exploration");
            refreshTree();
            const treeIdx = treeItems.findIndex((t) => t.nodeId === annotation.sourceNodeId);
            if (treeIdx >= 0) treeSelect.setSelectedIndex(treeIdx);
            enterReadingMode();
          }
        }
        return;
      }
      // Let the select handle j/k/up/down for navigation (don't stopPropagation)
      // But handle scrolling the detail panel with ctrl+d/u
      if (key.ctrl && key.name === "d") {
        key.stopPropagation();
        synthDetailScroll.scrollBy({ x: 0, y: 10 });
        return;
      }
      if (key.ctrl && key.name === "u") {
        key.stopPropagation();
        synthDetailScroll.scrollBy({ x: 0, y: -10 });
        return;
      }
      return;
    }

    // ---- Graph mode ----
    if (mode === "graph") {
      key.stopPropagation();
      if (key.name === "escape" || key.name === "q") {
        exitGraphMode();
        return;
      }
      if (key.name === "return") {
        // Open selected node in exploration view
        if (graphView) {
          const activeNodes = allNodes.filter((n) => n.status !== "pruned");
          const idx = (graphView as any).selectedIdx || 0;
          const node = activeNodes[idx];
          if (node && graph) {
            exitGraphMode();
            // Find the node in the tree and select it
            const treeIdx = treeItems.findIndex((t) => t.nodeId === node.id);
            if (treeIdx >= 0) treeSelect.setSelectedIndex(treeIdx);
            enterReadingMode();
          }
        }
        return;
      }
      graphView?.handleKey(key);
      return;
    }
  });

  // ---- Resize handler ----
  renderer.on("resize", (w: number, h: number) => {
    if (mode === "graph" && graphView) {
      const peekWidth = 34;
      graphView.resize(w - peekWidth - 4, h - 6);
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
