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

export function renderMarkdown(md: string): StyledText {
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

  for (const ln of lines) {
    const trimmed = ln.trimStart();

    // Code fence
    if (trimmed.startsWith("```")) {
      if (!inCode) { inCode = true; codeLang = trimmed.slice(3).trim(); line([fg(c.muted)(`┌─${codeLang ? ` ${codeLang} ` : "─"}${"─".repeat(Math.max(0, 30 - codeLang.length))}`)]); }
      else { inCode = false; codeLang = ""; line([fg(c.muted)("└" + "─".repeat(32))]); }
      continue;
    }
    if (inCode) { line([fg(c.muted)("│ "), fg(c.green)(ln)]); continue; }

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
