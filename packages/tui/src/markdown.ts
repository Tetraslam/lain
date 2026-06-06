// Markdown → terminal-text renderer for the TUI.
//
// OpenTUI's MarkdownRenderable doesn't work (tree-sitter grammars fail to
// load), so we render markdown to plain text with box-drawing affordances.
// Pure string-in/string-out — no renderer or theme dependencies.

/**
 * Render markdown content into terminal text.
 * Handles: headings, bold, italic, strikethrough, inline code, code blocks,
 * lists, blockquotes, horizontal rules, and links.
 */
export function renderMarkdown(md: string): string {
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
 */
export function renderInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "‹$1›")
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/___(.+?)___/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ‹$2›");
}
