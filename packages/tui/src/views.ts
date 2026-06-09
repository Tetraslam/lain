// Pure view-builders + shared types for the TUI: db discovery, tree items,
// node content, and the help reference. Extracted from app.ts to shrink the
// main module; these have no renderer/state dependencies.

import { Storage, Graph, collectDbFiles } from "@lain/core";
import type { LainNode } from "@lain/shared";
import { t, fg, dim, bold, type StyledText } from "@opentui/core";
import * as fs from "fs";
import * as path from "path";
import { c } from "./theme.js";
import { renderMarkdown, joinStyled } from "./markdown.js";

export interface DbInfo {
  path: string;
  name: string;
  explorations: { id: string; name: string; nodeCount: number; seed: string; n: number; m: number; ext: string }[];
}

export interface TreeItem {
  nodeId: string; prefix: string; title: string; depth: number; status: string; node: LainNode;
}

export type AppMode = "home" | "exploring" | "reading" | "editing" | "graph" | "help" | "palette" | "creating" | "interview" | "synthesis";

export interface PaletteAction {
  name: string;
  description: string;
  key?: string;
  action: () => void | Promise<void>;
}

/** Discover .db files containing explorations, walking up to 4 dirs from startDir. */
export function discoverDbs(startDir: string): DbInfo[] {
  const results: DbInfo[] = [];
  // cwd (+parents) + configured dirs + recently-opened dbs (deduped).
  for (const full of collectDbFiles(startDir)) {
    try {
      const s = new Storage(full);
      const g = new Graph(s);
      const exps = g.getAllExplorations();
      if (exps.length > 0) {
        results.push({
          path: full,
          name: path.basename(full),
          explorations: exps.map((e) => ({
            id: e.id, name: e.name, seed: e.seed, n: e.n, m: e.m, ext: e.extension,
            nodeCount: g.getAllNodes(e.id).filter((n) => n.status !== "pruned").length,
          })),
        });
      }
      s.close();
    } catch {}
  }
  return results;
}

/** Flatten a node subtree into renderable tree items with box-drawing prefixes. */
export function buildTreeItems(node: LainNode, allNodes: LainNode[], prefix = "", isLast = true, isRoot = true): TreeItem[] {
  const items: TreeItem[] = [];
  const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
  items.push({ nodeId: node.id, prefix: prefix + connector, title: node.title || node.id, depth: node.depth, status: node.status, node });
  const children = allNodes.filter((n) => n.parentId === node.id).sort((a, b) => a.branchIndex - b.branchIndex);
  const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
  children.forEach((child, i) => { items.push(...buildTreeItems(child, allNodes, childPrefix, i === children.length - 1, false)); });
  return items;
}

/** Build the styled content view for a single node (breadcrumb, meta, body, links, notes, children). */
export function buildNodeContent(node: LainNode, graph: Graph, allNodes: LainNode[], storage?: Storage): StyledText {
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

  const head = t`${breadcrumb ? `${breadcrumb}\n\n` : ""}${bold(fg(c.bright)(titleStr))}
${fg(c.muted)(sep)}

${fg(c.blue)("id")}  ${node.id}  ${fg(c.muted)("·")}  ${fg(c.blue)("depth")}  ${String(node.depth)}  ${fg(c.muted)("·")}  ${fg(c.blue)("branch")}  ${String(node.branchIndex)}  ${fg(c.muted)("·")}  ${fg(statusColor)(node.status)}
${metaExtraStr}
`;
  const body = node.content ? renderMarkdown(node.content) : t`${dim("(no content)")}`;
  return joinStyled(head, body, `${crosslinksStr}${notesStr}${childrenStr}`);
}

/** Build the keyboard reference shown in help mode. */
export function buildHelpContent(): StyledText {
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
