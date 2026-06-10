// Mounts a node's content into the scroll area as a stack of renderables:
// text blocks wrap (no truncation) and GFM tables become real grids where each
// cell is its own selectable TextRenderable — so selecting inside a cell copies
// just that cell, and wide tables shrink to the pane width instead of vanishing.

import { BoxRenderable, TextRenderable, t, fg, bold, dim, type StyledText, type CliRenderer } from "@opentui/core";
import type { Graph, Storage } from "@lain/core";
import type { LainNode } from "@lain/shared";
import { c } from "./theme.js";
import { renderMarkdown, splitMarkdownBlocks, computeTableLayout, type MdBlock } from "./markdown.js";
import { buildNodeHead, buildNodeTrailer } from "./views.js";

let uidCounter = 0;
const uid = (p: string) => `${p}-${uidCounter++}`;

/** A renderable that can hold children (the ScrollBox content box). */
interface Container {
  add(obj: unknown, index?: number): number;
  remove(id: string): void;
  getChildren(): { id: string; destroyRecursively?: () => void }[];
}

export function clearContainer(container: Container): void {
  for (const child of container.getChildren().slice()) {
    container.remove(child.id);
    child.destroyRecursively?.();
  }
}

function textBlock(renderer: CliRenderer, content: StyledText | string): TextRenderable {
  return new TextRenderable(renderer, { id: uid("nc-text"), content, width: "100%", wrapMode: "word", selectable: true });
}

/** Build a GFM table as a clean grid of independently-selectable cells.
 *
 * Horizontal rules are character-drawn TextRenderables (so junctions are proper
 * ┬┼┴ glyphs); the vertical lines are each cell's left border, which spans the
 * row's full (possibly wrapped) height. Column boundaries line up because the
 * rule segments use the same per-column width (content + 2 padding) and each
 * cell's left border sits exactly under a rule junction. */
function buildTable(renderer: CliRenderer, block: Extract<MdBlock, { kind: "table" }>, maxWidth: number): BoxRenderable {
  const { ncol, widths, header, rows } = computeTableLayout(block.header, block.aligns, block.rows, maxWidth);

  const table = new BoxRenderable(renderer, {
    id: uid("tbl"), flexDirection: "column", alignSelf: "flex-start", marginTop: 1, marginBottom: 1,
  });

  const rule = (l: string, mid: string, r: string) =>
    new TextRenderable(renderer, {
      id: uid("rule"),
      content: t`${fg(c.muted)(l + widths.map((w) => "─".repeat(w + 2)).join(mid) + r)}`,
      width: "100%", selectable: false,
    });

  const makeRow = (cells: string[], isHeader: boolean) => {
    const row = new BoxRenderable(renderer, { id: uid("tr"), flexDirection: "row", alignItems: "stretch" });
    for (let i = 0; i < ncol; i++) {
      const cell = new BoxRenderable(renderer, {
        id: uid("td"), width: widths[i] + 3, // left border (1) + paddingLeft (1) + content + paddingRight (1)
        border: ["left"], borderColor: c.muted, paddingLeft: 1, paddingRight: 1,
      });
      const txt = cells[i] ?? "";
      cell.add(new TextRenderable(renderer, {
        id: uid("tc"),
        content: isHeader ? t`${bold(fg(c.bright)(txt))}` : t`${fg(c.fg)(txt)}`,
        width: "100%", wrapMode: "word", selectable: true,
      }));
      row.add(cell);
    }
    // Trailing 1-wide box draws the table's right edge, spanning the row height.
    row.add(new BoxRenderable(renderer, { id: uid("tedge"), width: 1, border: ["left"], borderColor: c.muted }));
    return row;
  };

  table.add(rule("┌", "┬", "┐"));
  table.add(makeRow(header, true));
  table.add(rule("├", "┼", "┤"));
  rows.forEach((r, i) => {
    table.add(makeRow(r, false));
    table.add(rule(i === rows.length - 1 ? "└" : "├", i === rows.length - 1 ? "┴" : "┼", i === rows.length - 1 ? "┘" : "┤"));
  });
  return table;
}

/**
 * Render `node` into `container` (ScrollBox content): a header block, then the
 * body as interleaved wrapping-text and table renderables, then a trailer.
 */
export function mountNodeContent(
  renderer: CliRenderer,
  container: Container,
  node: LainNode,
  graph: Graph,
  allNodes: LainNode[],
  storage: Storage | undefined,
  contentWidth: number,
): void {
  clearContainer(container);
  container.add(textBlock(renderer, buildNodeHead(node, graph)));

  if (node.content) {
    for (const block of splitMarkdownBlocks(node.content)) {
      if (block.kind === "table") container.add(buildTable(renderer, block, contentWidth));
      else container.add(textBlock(renderer, renderMarkdown(block.md, contentWidth)));
    }
  } else {
    container.add(textBlock(renderer, t`${dim("(no content)")}`));
  }

  const trailer = buildNodeTrailer(node, graph, allNodes, storage);
  if (trailer.trim()) container.add(textBlock(renderer, t`${fg(c.muted)(trailer)}`));
}

/** Replace the container's contents with a single wrapping text block (help, generating, …). */
export function mountText(renderer: CliRenderer, container: Container, content: StyledText | string): void {
  clearContainer(container);
  container.add(textBlock(renderer, content));
}
