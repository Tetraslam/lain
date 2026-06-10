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
import { t, fg, bg, dim, bold, italic, underline, strikethrough, cyan, green, yellow, magenta } from "@opentui/core";
import type { KeyEvent, SelectOption } from "@opentui/core";
import { toast, mountToaster } from "./toast.js";
import { copyToClipboard } from "./clipboard.js";
import { mountNodeContent, clearContainer } from "./content-view.js";
import { tuneScroll } from "./scroll.js";
import { Storage, Graph, Orchestrator, Sync, Exporter, CanvasExporter, SynthesisEngine, Corpus, connectMcpServers, buildToolCatalog, checkForUpdate, planMission, interviewMission, addRecentDb, hasWebSearchTool, type InterviewTurn } from "@lain/core";
import { buildExtensionRegistry } from "@lain/extensions";
import { fileURLToPath } from "url";
import type { LainNode, Exploration, Strategy, PlanDetail, Mission, SettingField, LainConfig, Credentials, ToolCatalog, ToolGroup, ToolSelection, McpServerConfig } from "@lain/shared";
import { generateId, SETTINGS_SECTIONS, SETTINGS_FIELDS, applySettings, resolveSettingValue, coerceSettingValue, saveConfig, normalizeToolSelection, resolveDisabledToolIds, toggleGroup, toggleTool, isGroupEnabled, isToolEnabled, countActiveTools } from "@lain/shared";
import { loadConfig, loadCredentials, createProviderFromCredentials } from "./config-loader.js";
import { GraphView } from "./graph-view.js";
import * as fs from "fs";
import * as path from "path";

/** Human-readable labels for the agentic "thinking" feed. */
const TOOL_LABELS: Record<string, string> = {
  outline: "scanning the whole graph",
  read_node: "reading a related branch",
  search_nodes: "searching other nodes",
  search_corpus: "consulting source material",
  list_corpus_sources: "reviewing sources",
  read_findings: "reading shared findings",
  note_finding: "recording a finding",
  link_to_node: "linking to a branch",
  coin_names: "coining in-world names",
  submit_node: "writing the node",
};
function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (name.startsWith("mcp_")) return `calling ${name.replace(/^mcp_/, "").replace(/_/g, " ")}`;
  return name;
}
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

import { c } from "./theme.js";
import { renderMarkdown, joinStyled } from "./markdown.js";
import { rankCommands, groupRanked, type PaletteHost, type RankedCommand } from "./palette.js";
import {
  discoverDbs,
  buildTreeItems,
  buildHelpContent,
  type TreeItem,
  type AppMode,
} from "./views.js";

// ============================================================================
// Main App
// ============================================================================

export async function createApp(dbPathArg?: string): Promise<void> {
  const renderer = await createCliRenderer();
  const termW = renderer.width ?? 80;

  // ---- Toast ----
  mountToaster(renderer);

  // ---- Root container ----
  const rootBox = new BoxRenderable(renderer, {
    id: "root", width: "100%", height: "100%", flexDirection: "column", paddingLeft: 1, paddingRight: 1,
  });
  renderer.root.add(rootBox);

  // ---- Copy-on-select (à la opencode) ----
  // OpenTUI captures the mouse and highlights selectable text as you drag.
  // On release, copy whatever is selected to the clipboard, then clear it.
  // clearSelection is deferred to a microtask so the renderer can finish its
  // own selection lifecycle first (otherwise the next drag silently no-ops).
  renderer.root.onMouseUp = () => {
    const text = renderer.getSelection()?.getSelectedText();
    if (!text) return;
    copyToClipboard(text);
    const lines = text.split("\n").length;
    toast.success(lines > 1 ? `Copied ${lines} lines` : "Copied to clipboard");
    queueMicrotask(() => renderer.clearSelection());
  };

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

  // Subtle, fail-silent update check (cached 24h). If a newer lain is on main,
  // append a quiet indicator to the home footer + a one-time toast.
  (async () => {
    try {
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
      const status = await checkForUpdate(repoRoot);
      if (status.available) {
        homeFooterText.content = t`  ${dim("j/k")} navigate  ${fg(c.muted)("·")}  ${dim("enter")} open  ${fg(c.muted)("·")}  ${dim("ctrl+p")} palette  ${fg(c.muted)("·")}  ${dim("q")} quit  ${fg(c.muted)("·")}  ${fg(c.yellow)(`↑ ${status.remote} — run 'lain update'`)}`;
        try { (toast as { info?: (m: string) => void }).info?.(`update available (${status.remote}) — run 'lain update'`); } catch { /* ignore */ }
      }
    } catch { /* never let an update check break the TUI */ }
  })();

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
  // Width available for node content (right pane): term − tree panel − gaps/padding/scrollbar.
  const contentWidth = Math.max(40, termW - treePanelWidth - 7);

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
  tuneScroll(nodeScroll);

  // Simple full-text surface (help, generating feed) — cheap to mutate.
  const nodeText = new TextRenderable(renderer, { id: "node-text", content: "", width: "100%", wrapMode: "word", selectable: true });
  nodeScroll.content.add(nodeText);
  // Structured node view: wrapping text blocks + per-cell table renderables.
  const nodeBlocks = new BoxRenderable(renderer, { id: "node-blocks", width: "100%", flexDirection: "column" });
  nodeScroll.content.add(nodeBlocks);

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
    id: "palette-input", width: "100%", placeholder: "Search commands…  (type to filter)",
  });
  paletteBox.add(paletteInput);

  const paletteDivider = new TextRenderable(renderer, {
    id: "palette-divider", content: "─".repeat(56), fg: c.muted, width: "100%",
  });
  paletteBox.add(paletteDivider);

  // Manually-rendered list (groups, icons, shortcuts, full-width highlight bar).
  const paletteList = new TextRenderable(renderer, {
    id: "palette-list", width: "100%", content: "",
  });
  paletteBox.add(paletteList);

  const paletteFooter = new TextRenderable(renderer, {
    id: "palette-footer", width: "100%", content: "",
  });
  paletteBox.add(paletteFooter);

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
  let createFocusIdx = 0;
  const createExtDisplay = new TextRenderable(renderer, {
    id: "create-ext-display", content: "", fg: c.fg,
  });
  createParamsRow.add(createExtDisplay);

  function updateExtDisplay(focused = false) {
    // Plain string (styled-text objects can't be joined — they stringify to
    // "[object Object]"); the selected lens is bracketed and the whole field is
    // colored to signal focus.
    const label = availableExtensions
      .map((ext, i) => (i === createExtIdx ? `‹${ext}›` : ext))
      .join("  ");
    createExtDisplay.content = focused ? t`${fg(c.accent)(label)}` : t`${fg(c.bright)(label)}`;
  }
  updateExtDisplay();

  // ---- Corpus (optional source material to ground the agents) ----
  const createCorpusLabel = new TextRenderable(renderer, {
    id: "create-corpus-label", content: "corpus — path to a file or folder to ground the agents (optional)", fg: c.dim,
  });
  createForm.add(createCorpusLabel);
  const createCorpusInput = new InputRenderable(renderer, {
    id: "create-corpus-input", width: "100%", placeholder: "./lore/   ·   ~/notes/world.md   ·   data.csv",
  });
  createForm.add(createCorpusInput);

  // ---- Mission toggle (derive a goal + success criteria) ----
  const createMissionRow = new BoxRenderable(renderer, {
    id: "create-mission-row", width: "100%", flexDirection: "row", gap: 2,
  });
  createForm.add(createMissionRow);
  createMissionRow.add(new TextRenderable(renderer, { id: "create-mission-label", content: "mission:", fg: c.blue }));
  let createMission = false;
  const createMissionDisplay = new TextRenderable(renderer, { id: "create-mission-display", content: "" });
  createMissionRow.add(createMissionDisplay);
  function updateMissionDisplay(focused = false) {
    const label = createMission ? "‹on›" : "‹off›";
    const hint = dim("write a goal contract, then validate + auto-fix gaps");
    createMissionDisplay.content = focused
      ? t`${fg(c.accent)(label)}  ${hint}  ${dim("· space")}`
      : t`${fg(c.bright)(label)}  ${hint}`;
  }
  updateMissionDisplay();

  // Tools row — opens the per-run tool picker overlay.
  const createToolsRow = new BoxRenderable(renderer, {
    id: "create-tools-row", width: "100%", flexDirection: "row", gap: 2,
  });
  createForm.add(createToolsRow);
  createToolsRow.add(new TextRenderable(renderer, { id: "create-tools-label", content: "tools:", fg: c.blue }));
  let createToolSelection: ToolSelection | null = null;
  const createToolsDisplay = new TextRenderable(renderer, { id: "create-tools-display", content: "" });
  createToolsRow.add(createToolsDisplay);
  function updateToolsRowDisplay(focused = false) {
    const customized = !!createToolSelection && (createToolSelection.disabledGroups.length > 0 || createToolSelection.disabledTools.length > 0);
    const label = customized ? "‹customized›" : "‹defaults›";
    const hint = dim("choose which tools & MCP servers agents may use");
    createToolsDisplay.content = focused
      ? t`${fg(c.accent)(label)}  ${hint}  ${dim("· enter")}`
      : t`${fg(c.bright)(label)}  ${hint}`;
  }
  updateToolsRowDisplay();

  const createHint = new TextRenderable(renderer, {
    id: "create-hint",
    content: "tab switches fields  ·  ←/→ select lens  ·  enter creates  ·  esc cancels",
    fg: c.dim,
  });
  createForm.add(createHint);

  // ===========================================================================
  // MISSION INTERVIEW (cognitive-frontloading gate)
  // ===========================================================================
  const interviewOverlay = new BoxRenderable(renderer, {
    id: "interview-overlay", width: "100%", height: "100%",
    position: "absolute", left: 0, top: 0,
    justifyContent: "flex-start", alignItems: "center", paddingTop: 3,
  });
  const interviewBox = new BoxRenderable(renderer, {
    id: "interview-box", width: 72, border: true, borderStyle: "rounded", borderColor: c.accent,
    flexDirection: "column", backgroundColor: c.surface,
    paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, gap: 1,
  });
  interviewOverlay.add(interviewBox);
  const interviewTitle = new TextRenderable(renderer, {
    id: "interview-title", content: t`${bold(fg(c.accent)("mission"))}  ${dim("— pin down the goal before exploring")}`,
  });
  interviewBox.add(interviewTitle);
  const interviewBody = new TextRenderable(renderer, { id: "interview-body", content: "", width: "100%" });
  interviewBox.add(interviewBody);
  const interviewInput = new InputRenderable(renderer, {
    id: "interview-input", width: "100%", placeholder: "type your answer — enter to submit, blank to skip",
  });
  interviewBox.add(interviewInput);
  const interviewFooter = new TextRenderable(renderer, { id: "interview-footer", content: "", width: "100%" });
  interviewBox.add(interviewFooter);

  // ===========================================================================
  // SETTINGS VIEW
  // ===========================================================================
  const settingsOverlay = new BoxRenderable(renderer, {
    id: "settings-overlay", width: "100%", height: "100%",
    position: "absolute", left: 0, top: 0,
    justifyContent: "center", alignItems: "center",
  });
  const settingsBox = new BoxRenderable(renderer, {
    id: "settings-box", width: 80, border: true, borderStyle: "rounded", borderColor: c.accent,
    flexDirection: "column", backgroundColor: c.surface,
    paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, gap: 1,
  });
  settingsOverlay.add(settingsBox);
  const settingsTitle = new TextRenderable(renderer, {
    id: "settings-title", content: t`${bold(fg(c.accent)("settings"))}  ${dim("— global config, saved to ~/.config/lain/")}`,
  });
  settingsBox.add(settingsTitle);
  const settingsBody = new TextRenderable(renderer, { id: "settings-body", content: "", width: "100%" });
  settingsBox.add(settingsBody);
  const settingsInput = new InputRenderable(renderer, {
    id: "settings-input", width: "100%", placeholder: "type a value — enter to save, esc to cancel", visible: false,
  });
  settingsBox.add(settingsInput);
  const settingsFooter = new TextRenderable(renderer, { id: "settings-footer", content: "", width: "100%" });
  settingsBox.add(settingsFooter);

  // ===========================================================================
  // TOOLS VIEW (agent toolbelt catalog + selection)
  // ===========================================================================
  const toolsOverlay = new BoxRenderable(renderer, {
    id: "tools-overlay", width: "100%", height: "100%",
    position: "absolute", left: 0, top: 0,
    justifyContent: "center", alignItems: "center",
  });
  const toolsBox = new BoxRenderable(renderer, {
    id: "tools-box", width: 84, border: true, borderStyle: "rounded", borderColor: c.accent,
    flexDirection: "column", backgroundColor: c.surface,
    paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, gap: 1,
  });
  toolsOverlay.add(toolsBox);
  const toolsTitle = new TextRenderable(renderer, { id: "tools-title", content: "" });
  toolsBox.add(toolsTitle);
  const toolsBody = new TextRenderable(renderer, { id: "tools-body", content: "", width: "100%" });
  toolsBox.add(toolsBody);
  const toolsInput = new InputRenderable(renderer, {
    id: "tools-input", width: "100%", placeholder: "", visible: false,
  });
  toolsBox.add(toolsInput);
  const toolsFooter = new TextRenderable(renderer, { id: "tools-footer", content: "", width: "100%" });
  toolsBox.add(toolsFooter);

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
  tuneScroll(synthDetailScroll);
  const synthDetailText = new TextRenderable(renderer, {
    id: "synth-detail-text", content: "", width: "100%", wrapMode: "word", selectable: true,
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

  function showScreen(screen: "home" | "exploration" | "palette" | "create" | "interview" | "settings" | "tools" | "graph" | "synthesis") {
    try { rootBox.remove("home-container"); } catch {}
    try { rootBox.remove("exp-container"); } catch {}
    try { rootBox.remove("graph-container"); } catch {}
    try { rootBox.remove("palette-overlay"); } catch {}
    try { rootBox.remove("create-box"); } catch {}
    try { rootBox.remove("interview-overlay"); } catch {}
    try { rootBox.remove("settings-overlay"); } catch {}
    try { rootBox.remove("tools-overlay"); } catch {}
    try { rootBox.remove("synth-container"); } catch {}

    if (screen === "home") {
      refreshHomeScreen(); // always reflect current dbs (e.g. a just-created exploration)
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
      createCorpusInput.value = "";
      createMission = false;
      createToolSelection = null;
      createFocusIdx = 0;
      updateExtDisplay(false);
      updateMissionDisplay(false);
      updateToolsRowDisplay(false);
      createSeedInput.focus();
    } else if (screen === "interview") {
      rootBox.add(homeContainer); // dim backdrop
      rootBox.add(interviewOverlay);
      homeSelect.focusable = false;
      homeSelect.blur();
      treeSelect.focusable = false;
      treeSelect.blur();
    } else if (screen === "settings") {
      if (previousMode === "graph") rootBox.add(graphContainer);
      else if (previousMode === "synthesis") rootBox.add(synthContainer);
      else if (exploration) rootBox.add(explorationContainer);
      else rootBox.add(homeContainer);
      rootBox.add(settingsOverlay);
      homeSelect.focusable = false;
      homeSelect.blur();
      treeSelect.focusable = false;
      treeSelect.blur();
    } else if (screen === "tools") {
      if (previousMode === "graph") rootBox.add(graphContainer);
      else if (previousMode === "synthesis") rootBox.add(synthContainer);
      else if (exploration) rootBox.add(explorationContainer);
      else rootBox.add(homeContainer);
      rootBox.add(toolsOverlay);
      homeSelect.focusable = false;
      homeSelect.blur();
      treeSelect.focusable = false;
      treeSelect.blur();
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

  function corpusCount(): number {
    if (!storage || !exploration) return 0;
    try { return new Corpus(storage).listSources(exploration.id).length; }
    catch { return 0; }
  }

  function setExpHeader() {
    if (!exploration) return;
    const shortName = exploration.name.length > 50 ? exploration.name.slice(0, 47) + "…" : exploration.name;
    const nc = allNodes.filter((n) => n.status !== "pruned").length;
    const cc = corpusCount();
    expHeaderText.content = cc > 0
      ? t`  ${fg(c.accent)("lain")}  ${dim(shortName)}  ${fg(c.muted)("·")}  ${dim(`${nc} nodes`)}  ${fg(c.muted)("·")}  ${dim(`n=${exploration.n} m=${exploration.m}`)}  ${fg(c.muted)("·")}  ${dim(exploration.extension)}  ${fg(c.muted)("·")}  ${fg(c.green)(`⊕ ${cc} grounded`)}`
      : t`  ${fg(c.accent)("lain")}  ${dim(shortName)}  ${fg(c.muted)("·")}  ${dim(`${nc} nodes`)}  ${fg(c.muted)("·")}  ${dim(`n=${exploration.n} m=${exploration.m}`)}  ${fg(c.muted)("·")}  ${dim(exploration.extension)}`;
  }

  function openExploration(openDbPath: string, expId?: string) {
    if (storage) storage.close();
    dbPath = openDbPath;
    addRecentDb(openDbPath);
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

    setExpHeader();

    treeSelect.options = treeItems.map((item) => {
      const maxTitle = treePanelWidth - item.prefix.length - 6;
      let title = item.title;
      if (title.length > maxTitle && maxTitle > 5) title = title.slice(0, maxTitle - 1) + "…";
      return { name: `${item.prefix}${title}`, description: "", value: item.nodeId };
    });
    treeSelect.setSelectedIndex(0);

    nodeText.content = "";
    mountNodeContent(renderer, nodeBlocks, root, graph, allNodes, storage ?? undefined, contentWidth);
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
    setExpHeader();
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
    nodeText.content = "";
    mountNodeContent(renderer, nodeBlocks, node, graph, allNodes, storage ?? undefined, contentWidth);
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

  // ---- Palette (command registry) ----
  let paletteHost: PaletteHost | null = null;
  let paletteRanked: RankedCommand[] = [];
  let paletteSel = 0;
  let paletteQuery = "";
  const PALETTE_ROWS = 11;
  const PALETTE_W = 54;

  async function doResume() {
    if (!storage || !exploration) return;
    const loadingId = toast.loading("Resuming — generating pending nodes…");
    try {
      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = createProviderFromCredentials(config, credentials);
      const orchestrator = new Orchestrator({ dbPath, agent });
      const { generated, created } = await orchestrator.resume(exploration.id);
      orchestrator.close();
      storage.close();
      storage = new Storage(dbPath);
      graph = new Graph(storage);
      toast.dismiss(loadingId);
      toast.success(generated || created ? `Resumed — ${generated} generated, ${created} created` : "Already complete");
      refreshTree();
      const cur = selectedNode();
      if (cur) showNode(cur);
    } catch (err: any) {
      toast.dismiss(loadingId);
      toast.error(`Resume failed: ${err.message}`);
    }
  }

  function doViewMission() {
    if (!storage || !exploration) return;
    const m = storage.getMission(exploration.id);
    if (!m || m.assertions.length === 0) { toast.info('No mission. Create with: lain "<seed>" --mission'); return; }
    const r = storage.getLatestMissionReport(exploration.id);
    const met = r ? r.results.filter((x) => x.status === "met").length : 0;
    toast.info(`Mission: ${met}/${m.assertions.length} met${r ? ` (round ${r.round})` : " — not validated"}. Full report: lain mission`);
  }

  async function doCheckUpdate() {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const loadingId = toast.loading("Checking for updates…");
    try {
      const s = await checkForUpdate(root, { force: true });
      toast.dismiss(loadingId);
      if (s.available) toast.info(`Update available (${s.remote}) — run: lain update`);
      else toast.success("lain is up to date");
    } catch { toast.dismiss(loadingId); toast.warning("Update check failed"); }
  }

  function buildPaletteHost(): PaletteHost {
    const ctxMode = mode === "palette" ? previousMode : mode;
    const context = (["home", "exploring", "reading", "graph", "synthesis"].includes(ctxMode)
      ? ctxMode : "home") as PaletteHost["context"];
    const node = selectedNode();
    const hasSyn = !!(storage && exploration && storage.getSynthesesForExploration(exploration.id).length > 0);
    return {
      context,
      hasExploration: !!exploration,
      hasSelectedNode: !!node,
      selectedNodeTitle: node?.title ?? null,
      selectedNodeId: node?.id ?? null,
      isRootSelected: node?.id === "root",
      hasCorpus: corpusCount() > 0,
      hasMission: !!(storage && exploration && storage.getMission(exploration.id)),
      hasSynthesis: hasSyn,
      branchN: exploration?.n ?? 3,
      openNode: () => { const n = selectedNode(); if (n) { showNode(n); enterReadingMode(); } },
      editNode: enterEditMode,
      pruneNode: doPrune,
      extendNode: doExtend,
      redirectNode: doRedirect,
      linkNode: () => toast.info("Cross-linking from the TUI is coming — for now: lain link <a> <b>"),
      graphView: enterGraphMode,
      backToTree: () => { if (mode === "graph") exitGraphMode(); else enterExploringMode(); },
      scrollTop: () => { nodeScroll.scrollTop = 0; },
      newExploration: () => { previousMode = mode; mode = "creating"; showScreen("create"); },
      openExploration: () => { mode = "home"; showScreen("home"); },
      synthesize: doSynthesize,
      viewSynthesis: doViewSynthesis,
      resumeExploration: doResume,
      viewMission: doViewMission,
      exportMarkdown: doExport,
      exportCanvas: doCanvasExport,
      syncObsidian: doSync,
      addCorpus: () => toast.info("Add corpus via CLI: lain corpus add <path> --db " + path.basename(dbPath)),
      searchCorpus: () => toast.info("Search corpus via CLI: lain corpus search <query> --db " + path.basename(dbPath)),
      backToHome: () => { mode = "home"; showScreen("home"); },
      openSettings,
      openTools,
      checkUpdate: doCheckUpdate,
      help: showHelpMode,
      quit: cleanup,
    };
  }

  function joinLinesST(parts: (StyledText | string)[]): StyledText {
    const out: (StyledText | string)[] = [];
    parts.forEach((p, i) => { if (i) out.push("\n"); out.push(p); });
    return joinStyled(...out);
  }

  /** Word-wrap plain text to a width (returns a newline-joined string). */
  function wrapText(text: string, width: number): string {
    const out: string[] = [];
    for (const para of text.split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        if (!line) line = word;
        else if ((line + " " + word).length <= width) line += " " + word;
        else { out.push(line); line = word; }
      }
      out.push(line);
    }
    return out.join("\n");
  }

  function renderPalette() {
    const searching = paletteQuery.trim().length > 0;
    type Row = { kind: "header"; label: string } | { kind: "item"; r: RankedCommand; idx: number };
    const rows: Row[] = [];
    if (searching) {
      paletteRanked.forEach((r, idx) => rows.push({ kind: "item", r, idx }));
    } else {
      let idx = 0;
      for (const sec of groupRanked(paletteRanked)) {
        rows.push({ kind: "header", label: sec.group });
        for (const r of sec.items) rows.push({ kind: "item", r, idx: idx++ });
      }
    }

    // Viewport: keep the selected row centered-ish.
    const selRow = rows.findIndex((row) => row.kind === "item" && row.idx === paletteSel);
    let start = Math.max(0, Math.min(selRow - Math.floor(PALETTE_ROWS / 2), rows.length - PALETTE_ROWS));
    if (!isFinite(start) || start < 0) start = 0;
    const visible = rows.slice(start, start + PALETTE_ROWS);

    const lines: (StyledText | string)[] = [];
    if (paletteRanked.length === 0) {
      lines.push(t`  ${dim("no matching commands")}`);
    }
    for (const row of visible) {
      if (row.kind === "header") {
        lines.push(t`${bold(fg(c.accent)(row.label.toUpperCase()))}`);
      } else {
        const cmd = row.r.command;
        const sel = row.idx === paletteSel;
        const left = `${cmd.icon}  ${cmd.title}`;
        const right = cmd.shortcut ?? "";
        const pad = Math.max(2, PALETTE_W - left.length - right.length);
        if (sel) {
          const bar = ` ${left}${" ".repeat(pad)}${right} `;
          lines.push(t`${bg("#33375a")(fg(c.bright)(bar))}`);
        } else {
          const tail = right ? `${" ".repeat(pad)}${right} ` : "";
          lines.push(t`${fg(c.muted)(` ${cmd.icon}  `)}${fg(c.fg)(cmd.title)}${fg(c.muted)(tail)}`);
        }
      }
    }
    // Pad to a stable height so the box doesn't jump.
    while (lines.length < PALETTE_ROWS) lines.push("");
    paletteList.content = joinLinesST(lines);

    const more = rows.length > PALETTE_ROWS ? `  ${paletteSel + 1}/${paletteRanked.length}` : "";
    paletteFooter.content = t`${fg(c.muted)("─".repeat(56))}
${dim("↑↓")} ${fg(c.muted)("navigate")}   ${dim("↵")} ${fg(c.muted)("run")}   ${dim("esc")} ${fg(c.muted)("close")}${fg(c.muted)(more)}`;
  }

  function updatePaletteOptions(filter: string) {
    paletteQuery = filter;
    if (!paletteHost) paletteHost = buildPaletteHost();
    paletteRanked = rankCommands(paletteHost, filter);
    paletteSel = 0;
    renderPalette();
  }

  function paletteMove(delta: number) {
    if (paletteRanked.length === 0) return;
    paletteSel = (paletteSel + delta + paletteRanked.length) % paletteRanked.length;
    renderPalette();
  }

  function executePaletteAction() {
    const r = paletteRanked[paletteSel];
    if (!r) { closePalette(); return; }
    const host = paletteHost;
    closePalette();
    try {
      void Promise.resolve(r.command.run(host!)).catch((e: any) => toast.error(e?.message ?? String(e)));
    } catch (e: any) { toast.error(e?.message ?? String(e)); }
  }

  function openPalette() {
    previousMode = mode;
    mode = "palette";
    treeSelect.focusable = false;
    treeSelect.blur();
    homeSelect.focusable = false;
    homeSelect.blur();
    paletteHost = buildPaletteHost();
    paletteQuery = "";
    paletteSel = 0;
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
    clearContainer(nodeBlocks);
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

    // Hide the rendered view and drop in the editor textarea.
    nodeText.content = "";
    clearContainer(nodeBlocks);
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

    // Remove the editor; the reading refresh below re-mounts the rendered view.
    try { nodeScroll.content.remove("edit-textarea"); } catch {}
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
    const hasCorpus = storage ? new Corpus(storage).listSources(exploration.id).length > 0 : false;
    const loadingId = toast.loading(hasCorpus ? `Extending ${node.id} (grounding in corpus)…` : `Extending ${node.id}…`);
    try {
      const config = loadConfig();
      const credentials = loadCredentials();
      const agent = createProviderFromCredentials(config, credentials);
      const orchestrator = new Orchestrator({ dbPath, agent });
      const children = await orchestrator.extendNode(exploration.id, node.id, exploration.n);
      orchestrator.close();
      if (storage) storage.close();
      storage = new Storage(dbPath);
      graph = new Graph(storage);
      toast.dismiss(loadingId);
      toast.success(`Added ${children.length} ${children.length === 1 ? "child" : "children"} to ${node.id}`);
      refreshTree();
      const current = selectedNode();
      if (current) showNode(current);
    } catch (err: any) {
      toast.dismiss(loadingId);
      toast.error(`Extend failed: ${err.message}`);
    }
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

  // ---- Mission interview (the cognitive-frontloading gate) ----
  type InterviewPending =
    | { kind: "question"; resolve: (a: string | null) => void }
    | { kind: "confirm"; resolve: (c: "proceed" | "refine" | "cancel") => void };
  let interviewPending: InterviewPending | null = null;

  function askInterviewQuestion(question: string): Promise<string | null> {
    return new Promise((resolve) => {
      mode = "interview";
      interviewPending = { kind: "question", resolve };
      interviewBody.content = t`${fg(c.cyan)("?")}  ${fg(c.bright)(question)}`;
      interviewInput.value = "";
      interviewInput.visible = true;
      interviewFooter.content = t`  ${dim("enter")} submit  ${fg(c.muted)("·")}  ${dim("esc")} cancel mission`;
      showScreen("interview");
      interviewInput.focus();
    });
  }

  function confirmContract(m: Mission): Promise<"proceed" | "refine" | "cancel"> {
    return new Promise((resolve) => {
      mode = "interview";
      interviewPending = { kind: "confirm", resolve };
      interviewInput.blur();
      interviewInput.visible = false;
      const lines: (StyledText | string)[] = [
        t`${bold(fg(c.bright)("Intent"))}`,
        wrapText(m.intent, 66),
        "",
        t`${bold(fg(c.bright)("Contract"))}  ${dim(`${m.assertions.length} assertions`)}`,
      ];
      for (const a of m.assertions) lines.push(t`  ${fg(c.green)(a.id)}  ${fg(c.fg)(a.text.length > 62 ? a.text.slice(0, 61) + "…" : a.text)}`);
      if (m.features.length) {
        lines.push("", t`${bold(fg(c.bright)("Branches"))}`);
        for (const f of m.features) lines.push(t`  ${fg(c.blue)(f.id)}  ${fg(c.fg)(f.angle.length > 50 ? f.angle.slice(0, 49) + "…" : f.angle)}  ${dim(`[${f.assertions.join(", ")}]`)}`);
      }
      interviewBody.content = joinLinesST(lines);
      interviewFooter.content = t`  ${dim("enter")} ${fg(c.green)("lock in & explore")}  ${fg(c.muted)("·")}  ${dim("e")} refine  ${fg(c.muted)("·")}  ${dim("esc")} cancel`;
      showScreen("interview");
    });
  }

  /** Run the interview loop. Returns the locked-in mission, or null if cancelled. */
  async function runMissionInterviewTui(seed: string, n: number, ext: string): Promise<Mission | null> {
    const config = loadConfig();
    const credentials = loadCredentials();
    const agent = createProviderFromCredentials(config, credentials);
    const history: InterviewTurn[] = [];

    for (let guard = 0; guard < 8; guard++) {
      mode = "interview";
      interviewPending = null;
      interviewInput.blur();
      interviewInput.visible = false;
      interviewBody.content = t`${fg(c.accent)("◇")}  ${dim(history.length === 0 ? "thinking about what to ask…" : "reconsidering the goal…")}`;
      interviewFooter.content = "";
      showScreen("interview");

      let res;
      try {
        res = await interviewMission(agent, "pending", seed, n, history, { extension: ext });
      } catch (err: any) {
        toast.error(`Mission planning failed: ${err.message}`);
        return null;
      }

      if (!res.done) {
        for (const q of res.questions) {
          const ans = await askInterviewQuestion(q);
          if (ans === null) return null;
          history.push({ question: q, answer: ans.trim() });
        }
        continue;
      }

      const choice = await confirmContract(res.mission);
      if (choice === "proceed") return res.mission;
      if (choice === "cancel") return null;
      const change = await askInterviewQuestion("What should change about the goal or contract?");
      if (change === null) return null;
      history.push({ question: "Requested change", answer: change.trim() });
    }
    return null;
  }

  // ===========================================================================
  // Settings (schema-driven, editable in place)
  // ===========================================================================
  type SettingsRow = { kind: "header"; title: string } | { kind: "field"; field: SettingField };
  let settingsRows: SettingsRow[] = [];
  let settingsFieldIdx: number[] = []; // row indices that are fields (focusable)
  let settingsCursor = 0;             // index into settingsFieldIdx
  let settingsScroll = 0;
  let settingsEditing = false;
  let settingsSnapConfig: LainConfig = loadConfig();
  let settingsSnapCreds: Credentials = loadCredentials();
  const SETTINGS_WINDOW = 16;

  function settingsField(): SettingField | null {
    const rowIdx = settingsFieldIdx[settingsCursor];
    const row = settingsRows[rowIdx];
    return row && row.kind === "field" ? row.field : null;
  }

  function fmtSettingValue(f: SettingField): StyledText {
    const raw = resolveSettingValue(f, settingsSnapConfig, settingsSnapCreds);
    if (raw == null || raw === "") return t`${dim("(unset)")}`;
    if (f.type === "secret") {
      const s = String(raw);
      return t`${fg(c.green)("●●●●")}${dim(s.length > 4 ? `…${s.slice(-4)}` : "")} ${dim("set")}`;
    }
    if (f.type === "boolean") return raw ? t`${fg(c.green)("● on")}` : t`${dim("○ off")}`;
    return t`${fg(c.bright)(String(raw))}`;
  }

  function openSettings() {
    settingsSnapConfig = loadConfig();
    settingsSnapCreds = loadCredentials();
    settingsRows = [];
    settingsFieldIdx = [];
    for (const sec of SETTINGS_SECTIONS) {
      settingsRows.push({ kind: "header", title: sec.title });
      for (const f of SETTINGS_FIELDS.filter((x) => x.section === sec.id)) {
        settingsFieldIdx.push(settingsRows.length);
        settingsRows.push({ kind: "field", field: f });
      }
    }
    settingsCursor = 0;
    settingsScroll = 0;
    settingsEditing = false;
    settingsInput.visible = false;
    previousMode = mode === "settings" ? previousMode : mode;
    mode = "settings";
    showScreen("settings");
    renderSettings();
  }

  function renderSettings() {
    const focusedRow = settingsFieldIdx[settingsCursor];
    // Keep the focused row within the scroll window.
    if (focusedRow < settingsScroll) settingsScroll = focusedRow;
    if (focusedRow >= settingsScroll + SETTINGS_WINDOW) settingsScroll = focusedRow - SETTINGS_WINDOW + 1;
    const end = Math.min(settingsRows.length, settingsScroll + SETTINGS_WINDOW);

    const lines: (StyledText | string)[] = [];
    for (let i = settingsScroll; i < end; i++) {
      const row = settingsRows[i];
      if (row.kind === "header") {
        lines.push(t`${bold(fg(c.accent)(row.title))}`);
      } else {
        const isFocused = i === focusedRow;
        const label = row.field.label.padEnd(22).slice(0, 22);
        const head = isFocused ? t`${fg(c.accent)("▸ ")}${bold(fg(c.bright)(label))}  ` : t`  ${fg(c.fg)(label)}  `;
        lines.push(joinStyled(head, fmtSettingValue(row.field)));
      }
    }
    settingsBody.content = joinLinesST(lines);

    const f = settingsField();
    if (settingsEditing) {
      settingsFooter.content = t`  ${dim("enter")} save  ${fg(c.muted)("·")}  ${dim("esc")} cancel`;
    } else if (f) {
      const hintTxt = f.type === "boolean" ? "space toggle"
        : f.type === "select" ? "←/→ change"
        : f.suggestions ? `enter edit  ·  e.g. ${f.suggestions[0]}`
        : "enter edit";
      const scroll = settingsScroll + SETTINGS_WINDOW < settingsRows.length || settingsScroll > 0 ? "   ↑/↓ scroll" : "";
      settingsFooter.content = t`  ${fg(c.muted)("↑/↓")} move  ${fg(c.muted)("·")}  ${dim(hintTxt)}  ${fg(c.muted)("·")}  ${dim("esc")} close${dim(scroll)}`;
    }
  }

  /** Persist one setting, reload the snapshot, and toast the outcome. */
  function persistSetting(field: SettingField, value: unknown) {
    const res = applySettings([{ key: field.key, value }], { scope: "global" });
    if (res.errors.length) { toast.error(`${field.label}: ${res.errors[0].error}`); return false; }
    settingsSnapConfig = loadConfig();
    settingsSnapCreds = loadCredentials();
    toast.success(`Saved ${field.label}`);
    return true;
  }

  function moveSettings(delta: number) {
    settingsCursor = Math.max(0, Math.min(settingsFieldIdx.length - 1, settingsCursor + delta));
    renderSettings();
  }

  function cycleSettingSelect(dir: number) {
    const f = settingsField();
    if (!f || f.type !== "select" || !f.options) return;
    const cur = String(resolveSettingValue(f, settingsSnapConfig, settingsSnapCreds) ?? f.options[0].value);
    let idx = f.options.findIndex((o) => o.value === cur);
    if (idx < 0) idx = 0;
    idx = (idx + dir + f.options.length) % f.options.length;
    persistSetting(f, f.options[idx].value);
    renderSettings();
  }

  function toggleSettingBool() {
    const f = settingsField();
    if (!f || f.type !== "boolean") return;
    const cur = !!resolveSettingValue(f, settingsSnapConfig, settingsSnapCreds);
    persistSetting(f, !cur);
    renderSettings();
  }

  function beginSettingEdit() {
    const f = settingsField();
    if (!f) return;
    if (f.type === "boolean") { toggleSettingBool(); return; }
    if (f.type === "select") { cycleSettingSelect(1); return; }
    settingsEditing = true;
    const cur = resolveSettingValue(f, settingsSnapConfig, settingsSnapCreds);
    settingsInput.value = f.type === "secret" ? "" : (cur != null ? String(cur) : "");
    settingsInput.visible = true;
    settingsInput.focus();
    renderSettings();
  }

  function commitSettingEdit() {
    const f = settingsField();
    if (!f) return;
    const raw = settingsInput.value;
    if (raw.trim() === "" && f.type !== "string") {
      // empty on a non-string clears nothing for secrets; just cancel
      cancelSettingEdit();
      return;
    }
    const coerced = coerceSettingValue(f, raw);
    if (!coerced.ok) { toast.error(`${f.label}: ${coerced.error}`); return; }
    persistSetting(f, coerced.value);
    settingsEditing = false;
    settingsInput.visible = false;
    settingsInput.blur();
    renderSettings();
  }

  function cancelSettingEdit() {
    settingsEditing = false;
    settingsInput.visible = false;
    settingsInput.blur();
    settingsInput.value = "";
    renderSettings();
  }

  function closeSettings() {
    settingsEditing = false;
    settingsInput.visible = false;
    settingsInput.blur();
    mode = previousMode === "settings" ? "home" : previousMode;
    if (mode === "graph") showScreen("graph");
    else if (mode === "synthesis") showScreen("synthesis");
    else if (exploration) { mode = "exploring"; showScreen("exploration"); }
    else { mode = "home"; showScreen("home"); }
  }

  // ===========================================================================
  // Tools overlay (catalog + selection) — config defaults or per-run override
  // ===========================================================================
  type ToolRow =
    | { kind: "group"; group: ToolGroup }
    | { kind: "tool"; group: ToolGroup; tool: { id: string; title: string; description: string } };
  let toolsCatalog: ToolCatalog = { groups: [] };
  let toolsSelection: ToolSelection = { disabledGroups: [], disabledTools: [] };
  let toolsExpanded = new Set<string>();
  let toolsRows: ToolRow[] = [];
  let toolsCursor = 0;
  let toolsScroll = 0;
  let toolsRunMode = false;
  let toolsResolve: ((sel: ToolSelection | null) => void) | null = null;
  let toolsReturnTo: "create" | "back" = "back";
  // In-overlay "add MCP server" flow: a tiny 3-step prompt (name → url → token).
  let toolsAdd: { step: "name" | "url" | "auth"; name: string; url: string } | null = null;
  const TOOLS_WINDOW = 16;

  async function buildTuiCatalog(): Promise<ToolCatalog> {
    const config = loadConfig();
    const registry = buildExtensionRegistry();
    const { catalog, mcpPool } = await buildToolCatalog({
      hasCorpus: true,
      extensionGroups: registry.describeToolGroups(),
      mcpServers: config.mcpServers,
      probeMcp: true,
    });
    if (mcpPool) await mcpPool.close();
    return catalog;
  }

  function rebuildToolRows() {
    toolsRows = [];
    for (const g of toolsCatalog.groups) {
      toolsRows.push({ kind: "group", group: g });
      if (toolsExpanded.has(g.id)) for (const tool of g.tools) toolsRows.push({ kind: "tool", group: g, tool });
    }
    if (toolsCursor >= toolsRows.length) toolsCursor = Math.max(0, toolsRows.length - 1);
  }

  function renderTools() {
    // While adding an MCP server, the body becomes a focused prompt.
    if (toolsAdd) {
      const step = toolsAdd.step;
      const stepLabel = step === "name" ? "name" : step === "url" ? "URL" : "auth";
      toolsTitle.content = t`${bold(fg(c.accent)("add MCP server"))}  ${fg(c.muted)("·")}  ${dim(`step ${step === "name" ? 1 : step === "url" ? 2 : 3}/3 — ${stepLabel}`)}`;
      const so = toolsAdd.name ? `name ${toolsAdd.name}` : "";
      const su = toolsAdd.url ? `    url ${toolsAdd.url.slice(0, 50)}` : "";
      toolsBody.content = t`${dim("Add a remote MCP server; its tools join the toolbelt for new runs.")}
${fg(c.blue)(so)}${fg(c.blue)(su)}
${dim(
        step === "name" ? "Short local name, e.g. firecrawl" :
        step === "url" ? "Streamable HTTP URL (may embed a key), e.g. https://mcp.firecrawl.dev/<key>/v2/mcp" :
        "Optional Bearer token → sent as Authorization: Bearer <token>. Leave blank for none (or if the key is in the URL)."
      )}`;
      toolsFooter.content = t`  ${fg(c.muted)("enter")} ${step === "auth" ? "save" : "next"}  ${fg(c.muted)("·")}  ${dim("esc")} cancel`;
      return;
    }
    const total = countActiveTools(toolsCatalog, toolsSelection);
    toolsTitle.content = t`${bold(fg(c.accent)("tools"))}  ${dim(toolsRunMode ? "— this run only (d saves as default)" : "— default toolbelt for new runs")}  ${fg(c.muted)("·")}  ${fg(c.green)(`${total} active`)}`;
    if (toolsCursor < toolsScroll) toolsScroll = toolsCursor;
    if (toolsCursor >= toolsScroll + TOOLS_WINDOW) toolsScroll = toolsCursor - TOOLS_WINDOW + 1;
    const end = Math.min(toolsRows.length, toolsScroll + TOOLS_WINDOW);
    const lines: (StyledText | string)[] = [];
    for (let i = toolsScroll; i < end; i++) {
      const row = toolsRows[i];
      const focused = i === toolsCursor;
      const cur = focused ? fg(c.accent)("▸") : " ";
      if (row.kind === "group") {
        const on = isGroupEnabled(toolsSelection, row.group.id);
        const sw = on ? fg(c.green)("●") : dim("○");
        const caret = row.group.tools.length ? (toolsExpanded.has(row.group.id) ? "▾" : "▸") : " ";
        const active = row.group.tools.filter((tl) => isToolEnabled(toolsSelection, row.group.id, tl.id)).length;
        const count = row.group.tools.length ? dim(`${on ? `${active}/${row.group.tools.length}` : "off"}`) : "";
        const kind = fg(c.muted)(`[${row.group.kind}]`);
        const err = row.group.error ? fg(c.red)(`  ✗ ${row.group.error.slice(0, 30)}` ) : "";
        lines.push(t`${cur} ${dim(caret)} ${sw} ${bold(fg(c.bright)(row.group.title))} ${kind} ${count}${err}`);
      } else {
        const ton = isToolEnabled(toolsSelection, row.group.id, row.tool.id);
        const box = !isGroupEnabled(toolsSelection, row.group.id) ? dim("·") : ton ? fg(c.green)("✓") : fg(c.red)("✗");
        lines.push(t`${cur}      ${box} ${fg(c.fg)(row.tool.id.padEnd(24))} ${dim(row.tool.description.slice(0, 40))}`);
      }
    }
    if (toolsRows.length === 0) lines.push(t`${dim("  (no tools)")}`);
    toolsBody.content = joinLinesST(lines);
    const scroll = toolsScroll + TOOLS_WINDOW < toolsRows.length || toolsScroll > 0 ? dim("  ↑/↓ scroll") : "";
    toolsFooter.content = t`  ${fg(c.muted)("↑/↓")} move  ${fg(c.muted)("·")}  ${dim("space")} toggle  ${fg(c.muted)("·")}  ${dim("→")} expand  ${fg(c.muted)("·")}  ${dim("a")} add mcp  ${fg(c.muted)("·")}  ${dim("x")} remove  ${fg(c.muted)("·")}  ${dim("d")} default  ${fg(c.muted)("·")}  ${dim("esc")} ${toolsRunMode ? "apply" : "close"}${scroll}`;
  }

  async function loadToolsOverlay() {
    toolsTitle.content = t`${bold(fg(c.accent)("tools"))}  ${dim("— probing MCP servers…")}`;
    toolsBody.content = t`${fg(c.accent)("◇")}  ${dim("building the catalog…")}`;
    toolsFooter.content = "";
    showScreen("tools");
    toolsCatalog = await buildTuiCatalog();
    toolsExpanded = new Set();
    toolsCursor = 0;
    toolsScroll = 0;
    rebuildToolRows();
    renderTools();
  }

  /** Open the tools overlay to edit the saved default selection. */
  async function openTools() {
    previousMode = mode === "tools" ? previousMode : mode;
    mode = "tools";
    toolsRunMode = false;
    toolsReturnTo = "back";
    toolsResolve = null;
    toolsSelection = normalizeToolSelection(loadConfig().tools);
    await loadToolsOverlay();
  }

  /** Open the tools overlay for a single run; resolves with the chosen selection. */
  function openToolsForRun(initial: ToolSelection): Promise<ToolSelection | null> {
    return new Promise((resolve) => {
      mode = "tools";
      toolsRunMode = true;
      toolsReturnTo = "create";
      toolsResolve = resolve;
      toolsSelection = { disabledGroups: [...initial.disabledGroups], disabledTools: [...initial.disabledTools] };
      loadToolsOverlay();
    });
  }

  function toolsCurrentRow(): ToolRow | null {
    return toolsRows[toolsCursor] ?? null;
  }

  function moveTools(delta: number) {
    toolsCursor = Math.max(0, Math.min(toolsRows.length - 1, toolsCursor + delta));
    renderTools();
  }

  function persistToolsIfConfig() {
    if (!toolsRunMode) saveConfig({ tools: toolsSelection });
  }

  function toggleToolsCurrent() {
    const row = toolsCurrentRow();
    if (!row) return;
    if (row.kind === "group") toolsSelection = toggleGroup(toolsSelection, row.group.id, !isGroupEnabled(toolsSelection, row.group.id));
    else toolsSelection = toggleTool(toolsSelection, row.tool.id, !isToolEnabled(toolsSelection, row.group.id, row.tool.id));
    persistToolsIfConfig();
    renderTools();
  }

  function expandToolsCurrent(open: boolean) {
    const row = toolsCurrentRow();
    if (!row || row.kind !== "group" || row.group.tools.length === 0) return;
    if (open) toolsExpanded.add(row.group.id);
    else toolsExpanded.delete(row.group.id);
    rebuildToolRows();
    renderTools();
  }

  // ---- Add / remove an MCP server, right here in the overlay ----

  function startAddMcp() {
    toolsAdd = { step: "name", name: "", url: "" };
    toolsInput.value = "";
    toolsInput.visible = true;
    toolsInput.focus();
    renderTools();
  }

  function cancelAddMcp() {
    toolsAdd = null;
    toolsInput.value = "";
    toolsInput.visible = false;
    toolsInput.blur();
    renderTools();
  }

  async function advanceAddMcp() {
    if (!toolsAdd) return;
    const val = toolsInput.value.trim();
    if (toolsAdd.step === "name") {
      if (!val) { toast.warning("Enter a short name"); return; }
      if (/\s/.test(val)) { toast.warning("Name can't contain spaces"); return; }
      if ((loadConfig().mcpServers ?? {})[val]) { toast.warning(`"${val}" already exists`); return; }
      toolsAdd.name = val;
      toolsAdd.step = "url";
      toolsInput.value = "";
      renderTools();
      return;
    }
    if (toolsAdd.step === "url") {
      if (!/^https?:\/\//i.test(val)) { toast.warning("URL must start with http(s)://"); return; }
      toolsAdd.url = val;
      toolsAdd.step = "auth";
      toolsInput.value = "";
      renderTools();
      return;
    }
    // auth step → persist + re-probe
    const cfg: McpServerConfig = { url: toolsAdd.url, ...(val ? { headers: { Authorization: `Bearer ${val}` } } : {}) };
    const servers = { ...(loadConfig().mcpServers ?? {}) };
    servers[toolsAdd.name] = cfg;
    saveConfig({ mcpServers: servers });
    const name = toolsAdd.name;
    toolsAdd = null;
    toolsInput.value = "";
    toolsInput.visible = false;
    toolsInput.blur();
    toast.success(`Added "${name}" — probing its tools…`);
    await loadToolsOverlay();
  }

  async function removeMcpUnderCursor() {
    const row = toolsCurrentRow();
    if (!row || row.kind !== "group" || !row.group.id.startsWith("mcp:")) {
      toast.warning("Move to an MCP server row (mcp:…) to remove it");
      return;
    }
    const name = row.group.id.slice("mcp:".length);
    const servers = { ...(loadConfig().mcpServers ?? {}) };
    if (!servers[name]) { toast.warning(`No server "${name}" in config`); return; }
    delete servers[name];
    saveConfig({ mcpServers: servers });
    toast.success(`Removed "${name}"`);
    await loadToolsOverlay();
  }

  function closeTools(apply: boolean) {
    const resolve = toolsResolve;
    const runMode = toolsRunMode;
    const sel = toolsSelection;
    toolsResolve = null;
    if (runMode && resolve) {
      resolve(apply ? sel : null);
      return; // caller restores the screen
    }
    mode = previousMode === "tools" ? "home" : previousMode;
    if (mode === "graph") showScreen("graph");
    else if (mode === "synthesis") showScreen("synthesis");
    else if (exploration) { mode = "exploring"; showScreen("exploration"); }
    else { mode = "home"; showScreen("home"); }
  }

  async function doCreate(seed: string, n?: number, m?: number, ext?: string, opts: { corpusPath?: string; mission?: boolean; prebuiltMission?: Mission | null; toolSelection?: ToolSelection | null } = {}) {
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
    clearContainer(nodeBlocks);
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
    for (let d = 1; d <= useM; d++) totalExpected += Math.pow(useN, d);

    // Live "thinking" feed (newest last). Plain strings so they compose into `t`.
    const feed: string[] = [];
    const pushFeed = (line: string) => { feed.push(line); if (feed.length > 200) feed.shift(); };
    let spin = 0;

    const renderProgress = () => {
      const frame = SPINNER[spin % SPINNER.length];
      expHeaderText.content = t`  ${fg(c.accent)("lain")}  ${dim(shortName)}  ${fg(c.muted)("·")}  ${fg(c.yellow)(`${frame} ${nodesGenerated}/${totalExpected}`)}  ${fg(c.muted)("·")}  ${fg(c.green)("agentic")}  ${fg(c.muted)("·")}  ${dim(`n=${useN} m=${useM}`)}`;
      const visible = feed.slice(-18).join("\n");
      nodeText.content = t`${bold(fg(c.bright)(seed))}
${fg(c.muted)("─".repeat(Math.min(50, seed.length)))}

${fg(c.yellow)(`${frame} weaving the graph`)}  ${dim(`${nodesGenerated}/${totalExpected} nodes`)}

${dim(visible)}`;
    };
    const spinner = setInterval(() => { spin++; renderProgress(); }, 90);
    renderProgress();

    const extensions = buildExtensionRegistry();
    // Resolve the run's tool selection (per-run override or saved default),
    // connect only enabled MCP servers, and compute disabled tool ids.
    const selection = normalizeToolSelection(opts.toolSelection ?? config.tools);
    const enabledServers: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(config.mcpServers ?? {})) {
      if (!cfg.disabled && isGroupEnabled(selection, `mcp:${name}`)) enabledServers[name] = cfg;
    }
    const built = await buildToolCatalog({
      hasCorpus: !!opts.corpusPath,
      extensionGroups: extensions.describeToolGroups([useExt]),
      mcpServers: enabledServers,
      probeMcp: true,
    });
    const mcpPool = built.mcpPool ?? { tools: [], connections: [], errors: [], close: async () => {} };
    const disabledToolIds = resolveDisabledToolIds(built.catalog, selection);
    if (mcpPool.tools.length > 0) pushFeed(`mcp: ${mcpPool.tools.length} tool(s) from ${mcpPool.connections.length} server(s)`);
    if (disabledToolIds.length > 0) pushFeed(`tools: ${countActiveTools(built.catalog, selection)} active (${disabledToolIds.length} off)`);
    // The research lens grounds claims in cited web sources — warn (don't block) if none is available.
    const activeMcpIds = mcpPool.tools.map((tl) => tl.spec.name).filter((id) => !disabledToolIds.includes(id));
    if (extensions.get(useExt)?.requiresWebSearch && !hasWebSearchTool(activeMcpIds)) {
      pushFeed(`⚠ the ${useExt} lens cites real web sources, but no web-search tool is active — citations will be sparse. Add one (e.g. firecrawl) via the Tools/MCP overlay.`);
      toast.error(`${useExt}: no web-search tool — add firecrawl (MCP) for citations`);
    }

    try {
      const orchestrator = new Orchestrator({
        dbPath: newDbPath, agent, concurrency: config.concurrency, extensions, agentMaxTokens: config.maxTokens, extraTools: mcpPool.tools, disabledTools: disabledToolIds,
        onEvent: (event) => {
          if (event.type === "plan:complete") {
            const d = event.data as { directions?: string[] } | undefined;
            if (d?.directions) pushFeed(`✦ planned ${d.directions.length} directions from ${event.nodeId}`);
          } else if (event.type === "node:agent-step") {
            const step = event.data as { kind?: string; name?: string } | undefined;
            if (step?.kind === "tool_call") pushFeed(`  ↳ ${event.nodeId}  ${toolLabel(step.name || "")}`);
          } else if (event.type === "node:complete") {
            nodesGenerated++;
            const data = event.data as { title?: string } | undefined;
            pushFeed(`✓ ${event.nodeId}  ${data?.title || "untitled"}`);
          } else if (event.type === "mission:fix") {
            const f = event.data as { assertions?: string[] } | undefined;
            pushFeed(`↻ revising ${event.nodeId} to close [${(f?.assertions ?? []).join(", ")}]`);
          } else if (event.type === "mission:validated") {
            const r = event.data as { round?: number; satisfied?: boolean; results?: { status: string }[] } | undefined;
            const met = (r?.results ?? []).filter((x) => x.status === "met").length;
            pushFeed(`◆ validation round ${r?.round}: ${met}/${r?.results?.length ?? 0} met${r?.satisfied ? " — satisfied" : ""}`);
          }
          renderProgress();
        },
      });
      await orchestrator.explore({
        id: expId, name: seed, seed,
        n: useN, m: useM,
        strategy: (config.defaultStrategy || "bf") as Strategy,
        planDetail: (config.defaultPlanDetail || "sentence") as PlanDetail,
        extension: useExt,
        beforeExpand: async (exp) => {
          if (opts.mission) {
            const mission = opts.prebuiltMission
              ? { ...opts.prebuiltMission, explorationId: exp.id }
              : (pushFeed("◆ planning mission (contract-first)…"), renderProgress(), await planMission(agent, exp.id, seed, useN, { extension: useExt }));
            orchestrator.getStorage().upsertMission(mission);
            pushFeed(`✦ contract set — ${mission.assertions.length} assertions, ${mission.features.length} features`);
          }
          if (opts.corpusPath) {
            const corpus = orchestrator.getCorpus();
            const resolved = path.resolve(opts.corpusPath.replace(/^~/, process.env.HOME || "~"));
            if (corpus && fs.existsSync(resolved)) {
              pushFeed(`◆ ingesting corpus: ${opts.corpusPath}…`);
              renderProgress();
              const results = fs.statSync(resolved).isDirectory()
                ? await corpus.ingestDirectory(exp.id, resolved)
                : [await corpus.ingestFile(exp.id, resolved)];
              const chunks = results.reduce((a, r) => a + r.chunkCount, 0);
              pushFeed(`✦ corpus: ${results.length} source(s), ${chunks} chunk(s) grounded`);
            } else {
              pushFeed(`! corpus path not found: ${opts.corpusPath}`);
            }
          }
          renderProgress();
        },
      });
      if (opts.mission) {
        pushFeed("◆ validating against the contract…");
        renderProgress();
        const report = await orchestrator.pursueMission(expId, { maxRounds: 2 });
        if (report) {
          const met = report.results.filter((r) => r.status === "met").length;
          pushFeed(`✦ mission ${report.satisfied ? "satisfied" : "incomplete"} — ${met}/${report.results.length} assertions met (${report.round} round)`);
        }
      }
      orchestrator.close();
      await mcpPool.close();
      clearInterval(spinner);
      generating = false;
      toast.success("Exploration complete!");
      refreshHomeScreen();
      openExploration(newDbPath, expId);
    } catch (err: any) {
      clearInterval(spinner);
      await mcpPool.close();
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

    // ---- "," : open settings from any non-input view ----
    if (key.name === "," && !key.ctrl && (mode === "home" || mode === "exploring" || mode === "reading" || mode === "graph" || mode === "synthesis")) {
      key.stopPropagation();
      openSettings();
      return;
    }

    // ---- Palette mode — stop propagation only for handled keys ----
    if (mode === "palette") {
      if (key.name === "escape") { key.stopPropagation(); closePalette(); return; }
      if (key.name === "return") { key.stopPropagation(); executePaletteAction(); return; }
      if (key.name === "down" || (key.name === "n" && key.ctrl) || (key.name === "tab" && !key.shift)) { key.stopPropagation(); paletteMove(1); return; }
      if (key.name === "up" || (key.name === "p" && key.ctrl) || (key.name === "tab" && key.shift)) { key.stopPropagation(); paletteMove(-1); return; }
      // Don't stopPropagation for other keys — let InputRenderable handle typing
      return;
    }

    // ---- Mission interview mode ----
    if (mode === "interview") {
      const p = interviewPending;
      if (!p) { if (key.name === "escape") key.stopPropagation(); return; }
      if (p.kind === "question") {
        if (key.name === "escape") { key.stopPropagation(); interviewPending = null; p.resolve(null); return; }
        if (key.name === "return") { key.stopPropagation(); const v = interviewInput.value; interviewPending = null; p.resolve(v); return; }
        return; // let the input handle typing
      } else {
        if (key.name === "escape") { key.stopPropagation(); interviewPending = null; p.resolve("cancel"); return; }
        if (key.name === "return") { key.stopPropagation(); interviewPending = null; p.resolve("proceed"); return; }
        if (key.name === "e") { key.stopPropagation(); interviewPending = null; p.resolve("refine"); return; }
        key.stopPropagation();
        return;
      }
    }

    // ---- Settings mode ----
    if (mode === "settings") {
      if (settingsEditing) {
        if (key.name === "escape") { key.stopPropagation(); cancelSettingEdit(); return; }
        if (key.name === "return") { key.stopPropagation(); commitSettingEdit(); return; }
        return; // let the input handle typing
      }
      if (key.name === "escape" || (key.name === "," && !key.ctrl)) { key.stopPropagation(); closeSettings(); return; }
      if (key.name === "up" || key.name === "k") { key.stopPropagation(); moveSettings(-1); return; }
      if (key.name === "down" || key.name === "j") { key.stopPropagation(); moveSettings(1); return; }
      if (key.name === "left" || key.name === "h") { key.stopPropagation(); cycleSettingSelect(-1); return; }
      if (key.name === "right" || key.name === "l") { key.stopPropagation(); cycleSettingSelect(1); return; }
      if (key.name === "space") { key.stopPropagation(); toggleSettingBool(); return; }
      if (key.name === "return") { key.stopPropagation(); beginSettingEdit(); return; }
      key.stopPropagation();
      return;
    }

    // ---- Tools mode ----
    if (mode === "tools") {
      // Adding an MCP server: the input owns typing; we only handle enter/esc.
      if (toolsAdd) {
        if (key.name === "escape") { key.stopPropagation(); cancelAddMcp(); return; }
        if (key.name === "return") { key.stopPropagation(); advanceAddMcp(); return; }
        return; // let the focused input handle the keystroke
      }
      if (key.name === "escape") { key.stopPropagation(); closeTools(true); return; }
      if (key.name === "up" || key.name === "k") { key.stopPropagation(); moveTools(-1); return; }
      if (key.name === "down" || key.name === "j") { key.stopPropagation(); moveTools(1); return; }
      if (key.name === "right" || key.name === "l") { key.stopPropagation(); expandToolsCurrent(true); return; }
      if (key.name === "left" || key.name === "h") { key.stopPropagation(); expandToolsCurrent(false); return; }
      if (key.name === "space" || key.name === "return") { key.stopPropagation(); toggleToolsCurrent(); return; }
      if (key.name === "a") { key.stopPropagation(); startAddMcp(); return; }
      if (key.name === "x") { key.stopPropagation(); removeMcpUnderCursor(); return; }
      if (key.name === "d") {
        key.stopPropagation();
        saveConfig({ tools: toolsSelection });
        toast.success("Saved as default toolbelt");
        return;
      }
      key.stopPropagation();
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
      // Unified focus model over all create fields.
      // zones: 0 seed, 1 n, 2 m, 3 ext (←/→), 4 corpus, 5 mission (space/←/→)
      const inputs: Record<number, InputRenderable> = { 0: createSeedInput, 1: createNInput, 2: createMInput, 4: createCorpusInput };
      const applyCreateFocus = () => {
        for (const r of Object.values(inputs)) (r as any).blur();
        updateExtDisplay(createFocusIdx === 3);
        updateMissionDisplay(createFocusIdx === 5);
        updateToolsRowDisplay(createFocusIdx === 6);
        if (inputs[createFocusIdx]) inputs[createFocusIdx].focus();
      };
      if (key.name === "tab") {
        key.stopPropagation();
        createFocusIdx = (createFocusIdx + (key.shift ? 6 : 1)) % 7;
        applyCreateFocus();
        return;
      }
      const onInput = createFocusIdx === 0 || createFocusIdx === 1 || createFocusIdx === 2 || createFocusIdx === 4;
      if (!onInput && (key.name === "left" || key.name === "right")) {
        key.stopPropagation();
        if (createFocusIdx === 3) {
          createExtIdx = key.name === "right"
            ? (createExtIdx + 1) % availableExtensions.length
            : (createExtIdx - 1 + availableExtensions.length) % availableExtensions.length;
          updateExtDisplay(true);
        } else if (createFocusIdx === 5) {
          createMission = !createMission;
          updateMissionDisplay(true);
        }
        return;
      }
      if (!onInput && createFocusIdx === 5 && key.name === "space") {
        key.stopPropagation();
        createMission = !createMission;
        updateMissionDisplay(true);
        return;
      }
      // Tools row: open the per-run tool picker (enter/space), then return to the form.
      if (!onInput && createFocusIdx === 6 && (key.name === "return" || key.name === "space")) {
        key.stopPropagation();
        const initial = createToolSelection ?? normalizeToolSelection(loadConfig().tools);
        try { rootBox.remove("create-box"); } catch {}
        const picked = await openToolsForRun(initial);
        if (picked) createToolSelection = picked;
        try { rootBox.remove("tools-overlay"); } catch {}
        rootBox.add(createBox);
        mode = "creating";
        createFocusIdx = 6;
        applyCreateFocus();
        return;
      }
      if (key.name === "return") {
        key.stopPropagation();
        const seed = createSeedInput.value;
        if (!seed.trim()) { toast.warning("Seed cannot be empty"); return; }
        const n = Math.max(1, Math.min(10, parseInt(createNInput.value) || 3));
        const m = Math.max(1, Math.min(10, parseInt(createMInput.value) || 2));
        const ext = availableExtensions[createExtIdx];
        const corpus = createCorpusInput.value.trim() || undefined;
        const mission = createMission;
        const toolSelection = createToolSelection;
        try { rootBox.remove("create-box"); } catch {}
        if (mission) {
          // Gate generation behind the clarification interview.
          runMissionInterviewTui(seed, n, ext).then((locked) => {
            if (!locked) { mode = "home"; showScreen("home"); return; }
            mode = previousMode;
            doCreate(seed, n, m, ext, { corpusPath: corpus, mission: true, prebuiltMission: locked, toolSelection });
          });
        } else {
          mode = previousMode;
          doCreate(seed, n, m, ext, { corpusPath: corpus, mission: false, toolSelection });
        }
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

                synthDetailText.content = joinStyled(t`${bold(fg(c.accent)(typeLabel))}

${dim("involved nodes")}
  ${dim("from")}  ${sourceTitle}
  ${dim("from")}  ${targetTitle}

${dim("will create")}
  ${fg(c.green)("+ new node")}  ${bold(preview.title)}
  ${dim("under")}  ${parentTitle}
  ${fg(c.green)("+ crosslink")}  → ${sourceTitle}
  ${fg(c.green)("+ crosslink")}  → ${targetTitle}

${fg(c.muted)("─".repeat(40))}

`, renderMarkdown(preview.content), t`

${fg(c.muted)("─".repeat(40))}
  ${fg(c.yellow)("y")} accept  ${fg(c.muted)("·")}  ${fg(c.yellow)("n")} reject`);
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
