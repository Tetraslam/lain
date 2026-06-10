// Markdown → styled terminal text for the TUI.
//
// OpenTUI's MarkdownRenderable doesn't work (tree-sitter grammars fail to load),
// so we render markdown into a StyledText: headings, bold, italic, inline code,
// code blocks, lists, blockquotes, rules, and links each get real color/weight
// within terminal constraints. No leading indent on body text.

import { fg, bold, italic, dim, strikethrough, stringToStyledText, StyledText } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import { c } from "./theme.js";

/** Wrap raw text as chunks (no styling). */
function raw(s: string): TextChunk[] {
  return s ? stringToStyledText(s).chunks : [];
}

/** Concatenate StyledText / strings into one StyledText. */
export function joinStyled(...parts: (StyledText | string)[]): StyledText {
  const chunks: TextChunk[] = [];
  for (const p of parts) chunks.push(...(typeof p === "string" ? raw(p) : p.chunks));
  return new StyledText(chunks);
}

/** Tokenize inline markdown (code, bold, italic, strike, links) into chunks. */
function renderInlineChunks(text: string): TextChunk[] {
  const out: TextChunk[] = [];
  const re =
    /(`[^`]+`)|(\*\*\*[^*]+\*\*\*|___[^_]+___)|(\*\*[^*]+\*\*|__[^_]+__)|(~~[^~]+~~)|(\[[^\]]+\]\([^)]+\))|(\*[^*\s][^*]*\*|(?<![A-Za-z0-9])_[^_\s][^_]*_(?![A-Za-z0-9]))/;
  let rest = text;
  let guard = 0;
  while (rest.length && guard++ < 5000) {
    const m = re.exec(rest);
    if (!m) { out.push(...raw(rest)); break; }
    if (m.index > 0) out.push(...raw(rest.slice(0, m.index)));
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(fg(c.green)(tok.slice(1, -1)));
    } else if (/^(\*\*\*|___)/.test(tok)) {
      out.push(bold(italic(fg(c.bright)(tok.slice(3, -3)))));
    } else if (/^(\*\*|__)/.test(tok)) {
      out.push(bold(fg(c.bright)(tok.slice(2, -2))));
    } else if (tok.startsWith("~~")) {
      out.push(strikethrough(dim(tok.slice(2, -2))));
    } else if (tok.startsWith("[")) {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      out.push(fg(c.blue)(mm[1]), fg(c.muted)(` ‹${mm[2]}›`));
    } else {
      out.push(italic(tok.slice(1, -1)));
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GFM tables — rendered as a clean, aligned box (Tokyo Night)
// ---------------------------------------------------------------------------

export type Align = "left" | "right" | "center";

/** Split a table row into trimmed cells (tolerant of missing edge pipes). */
function splitTableRow(s: string): string[] {
  let t = s.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** Is this line a GFM delimiter row, e.g. `|---|:--:|--:|`? */
function isTableDelimiter(s: string): boolean {
  const t = s.trim();
  if (!t.includes("-") || !/^[|\s:.-]+$/.test(t)) return false;
  const cells = splitTableRow(t);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, "")));
}

function colAligns(delim: string): Align[] {
  return splitTableRow(delim).map((cell) => {
    const x = cell.replace(/\s+/g, "");
    const left = x.startsWith(":");
    const right = x.endsWith(":");
    return left && right ? "center" : right ? "right" : "left";
  });
}

/** Strip inline markdown markers to visible text (cells render plain, aligned). */
function plainInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function padCell(s: string, w: number, align: Align): string {
  let txt = s;
  if (txt.length > w) txt = w <= 1 ? txt.slice(0, w) : txt.slice(0, w - 1) + "…";
  const gap = w - txt.length;
  if (gap <= 0) return txt;
  if (align === "right") return " ".repeat(gap) + txt;
  if (align === "center") { const left = Math.floor(gap / 2); return " ".repeat(left) + txt + " ".repeat(gap - left); }
  return txt + " ".repeat(gap);
}

/** Render a parsed table into styled lines (one TextChunk[] per output line). */
function renderTable(header: string[], alignsIn: Align[], bodyRows: string[][], maxWidth: number): TextChunk[][] {
  const ncol = Math.max(header.length, ...bodyRows.map((r) => r.length), 1);
  const aligns: Align[] = Array.from({ length: ncol }, (_, i) => alignsIn[i] ?? "left");
  const norm = (r: string[]) => Array.from({ length: ncol }, (_, i) => plainInline(r[i] ?? ""));
  const H = norm(header);
  const B = bodyRows.map(norm);

  const widths = Array.from({ length: ncol }, (_, i) =>
    Math.max(1, H[i].length, ...B.map((r) => r[i].length)));

  // Shrink the widest columns until the whole table fits maxWidth.
  const frame = ncol + 1; // vertical borders
  const total = () => widths.reduce((a, w) => a + w + 2, 0) + frame;
  let guard = 0;
  while (total() > Math.max(24, maxWidth) && guard++ < 2000) {
    let widest = 0;
    for (let i = 1; i < ncol; i++) if (widths[i] > widths[widest]) widest = i;
    if (widths[widest] <= 4) break;
    widths[widest]--;
  }

  const mut = (s: string) => fg(c.muted)(s);
  const rule = (l: string, mid: string, r: string): TextChunk[] =>
    [mut(l + widths.map((w) => "─".repeat(w + 2)).join(mid) + r)];

  const lines: TextChunk[][] = [];
  lines.push(rule("┌", "┬", "┐"));
  const head: TextChunk[] = [mut("│")];
  H.forEach((cell, i) => { head.push(bold(fg(c.bright)(" " + padCell(cell, widths[i], aligns[i]) + " ")), mut("│")); });
  lines.push(head);
  lines.push(rule("├", "┼", "┤"));
  for (const r of B) {
    const row: TextChunk[] = [mut("│")];
    r.forEach((cell, i) => { row.push(fg(c.fg)(" " + padCell(cell, widths[i], aligns[i]) + " "), mut("│")); });
    lines.push(row);
  }
  lines.push(rule("└", "┴", "┘"));
  return lines;
}

// ---------------------------------------------------------------------------
// Block model — split content into text + table blocks so the content view can
// mount tables as real per-cell renderables (selectable, wrapping) rather than
// as pre-formatted lines inside one TextRenderable.
// ---------------------------------------------------------------------------

export type MdBlock =
  | { kind: "text"; md: string }
  | { kind: "table"; header: string[]; aligns: Align[]; rows: string[][] };

export function splitMarkdownBlocks(md: string): MdBlock[] {
  const lines = md.split("\n");
  const blocks: MdBlock[] = [];
  let buf: string[] = [];
  let inCode = false;
  const flush = () => { if (buf.length) { blocks.push({ kind: "text", md: buf.join("\n") }); buf = []; } };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trimStart().startsWith("```")) { inCode = !inCode; buf.push(ln); continue; }
    if (!inCode && ln.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      flush();
      const header = splitTableRow(ln);
      const aligns = colAligns(lines[i + 1]);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "" && !lines[j].trimStart().startsWith("```")) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      blocks.push({ kind: "table", header, aligns, rows });
      i = j - 1;
      continue;
    }
    buf.push(ln);
  }
  flush();
  return blocks;
}

export interface TableLayout {
  ncol: number;
  widths: number[];      // content width per column (excludes padding/border)
  aligns: Align[];
  header: string[];      // plain (markdown-stripped) cells, normalized to ncol
  rows: string[][];
}

/**
 * Normalize a parsed table and fit its columns to `maxWidth`. Cells keep their
 * FULL text (the content view wraps them), so nothing is truncated — narrow
 * columns just grow taller. Per-column overhead is paddingLeft+paddingRight+
 * right-border = 3, plus 1 for the table's left border.
 */
export function computeTableLayout(header: string[], alignsIn: Align[], bodyRows: string[][], maxWidth: number): TableLayout {
  const ncol = Math.max(header.length, ...bodyRows.map((r) => r.length), 1);
  const aligns: Align[] = Array.from({ length: ncol }, (_, i) => alignsIn[i] ?? "left");
  const norm = (r: string[]) => Array.from({ length: ncol }, (_, i) => plainInline(r[i] ?? ""));
  const H = norm(header);
  const R = bodyRows.map(norm);

  // Natural width = longest word OR full cell, capped; min 3 so columns stay usable.
  const longestWord = (s: string) => s.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0);
  const widths = Array.from({ length: ncol }, (_, i) =>
    Math.max(3, longestWord(H[i]), H[i].length, ...R.map((r) => Math.min(r[i].length, 28)), ...R.map((r) => longestWord(r[i]))));

  const per = 3;
  const total = () => 1 + widths.reduce((a, w) => a + w + per, 0);
  let guard = 0;
  while (total() > Math.max(20, maxWidth) && guard++ < 5000) {
    let widest = 0;
    for (let i = 1; i < ncol; i++) if (widths[i] > widths[widest]) widest = i;
    if (widths[widest] <= 4) break;
    widths[widest]--;
  }
  return { ncol, widths, aligns, header: H, rows: R };
}

export function renderMarkdown(md: string, maxWidth = 88): StyledText {
  if (!md) return new StyledText([]);
  const lines = md.split("\n");
  const out: TextChunk[] = [];
  let first = true;
  const line = (chunks: TextChunk[]) => {
    if (!first) out.push(...raw("\n"));
    first = false;
    out.push(...chunks);
  };

  let inCode = false;
  let codeLang = "";

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const trimmed = ln.trimStart();

    // Code fence
    if (trimmed.startsWith("```")) {
      if (!inCode) { inCode = true; codeLang = trimmed.slice(3).trim(); line([fg(c.muted)(`┌─${codeLang ? ` ${codeLang} ` : "─"}${"─".repeat(Math.max(0, 30 - codeLang.length))}`)]); }
      else { inCode = false; codeLang = ""; line([fg(c.muted)("└" + "─".repeat(32))]); }
      continue;
    }
    if (inCode) { line([fg(c.muted)("│ "), fg(c.green)(ln)]); continue; }

    // GFM table — a header row followed by a delimiter row (|---|:--:|…).
    if (ln.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const header = splitTableRow(ln);
      const aligns = colAligns(lines[i + 1]);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "" && !lines[j].trimStart().startsWith("```")) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      line([]);
      for (const trow of renderTable(header, aligns, rows, maxWidth)) line(trow);
      line([]);
      i = j - 1;
      continue;
    }

    // Horizontal rule
    if (/^(---+|\*\*\*+|___+)$/.test(ln.trim())) { line([fg(c.muted)("─".repeat(42))]); continue; }

    // Headings
    let m: RegExpMatchArray | null;
    if ((m = ln.match(/^#\s+(.+)/))) { line([]); line([bold(fg(c.accent)(m[1].toUpperCase()))]); continue; }
    if ((m = ln.match(/^##\s+(.+)/))) { line([]); line([bold(fg(c.bright)(m[1]))]); continue; }
    if ((m = ln.match(/^###\s+(.+)/))) { line([bold(fg(c.blue)(m[1]))]); continue; }
    if ((m = ln.match(/^#{4,6}\s+(.+)/))) { line([fg(c.blue)(m[1])]); continue; }

    // Blockquote
    if (ln.startsWith(">")) {
      const content = ln.replace(/^>\s?/, "");
      line([fg(c.accent)("▏ "), ...renderInlineChunks(content).map((ch) => dim(ch))]);
      continue;
    }

    // Lists (preserve relative nesting indent only)
    if ((m = ln.match(/^(\s*)[*\-+]\s+(.+)/))) {
      const pad = " ".repeat(Math.floor(m[1].length / 2) * 2);
      line([...raw(pad), fg(c.accent)("• "), ...renderInlineChunks(m[2])]);
      continue;
    }
    if ((m = ln.match(/^(\s*)(\d+)\.\s+(.+)/))) {
      const pad = " ".repeat(Math.floor(m[1].length / 2) * 2);
      line([...raw(pad), fg(c.accent)(`${m[2]}. `), ...renderInlineChunks(m[3])]);
      continue;
    }

    // Paragraph / blank
    if (ln.trim() === "") line([]);
    else line(renderInlineChunks(ln));
  }

  if (inCode) line([fg(c.muted)("└" + "─".repeat(32))]);
  return new StyledText(out);
}
