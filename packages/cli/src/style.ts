// Terminal styling for the CLI — beautiful for humans, invisible to machines.
//
// Color is emitted ONLY when stdout is an interactive TTY (and NO_COLOR isn't
// set). When the CLI is piped — e.g. an agent capturing output — every helper
// degrades to plain ASCII text with no escape codes, so output stays parseable.

const useColor =
  !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

function sgr(open: number, close: number) {
  return (s: string | number): string => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
}
function rgb(r: number, g: number, b: number) {
  return (s: string | number): string => (useColor ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : String(s));
}

// Tokyo Night palette (the project's design language).
export const c = {
  accent: rgb(187, 154, 247), // purple
  blue: rgb(122, 162, 247),
  cyan: rgb(125, 207, 255),
  green: rgb(158, 206, 106),
  yellow: rgb(224, 175, 104),
  red: rgb(247, 118, 142),
  fg: rgb(192, 202, 245),
  muted: rgb(86, 95, 137),
};
export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const italic = sgr(3, 23);

export const icon = {
  ok: (s = "✓") => c.green(s),
  warn: (s = "!") => c.yellow(s),
  err: (s = "✗") => c.red(s),
  partial: (s = "~") => c.yellow(s),
  dot: (s = "·") => c.muted(s),
  bullet: (s = "•") => c.accent(s),
  arrow: (s = "→") => c.muted(s),
  branch: (s = "↳") => c.muted(s),
};

/** A compact wordmark + tagline. Plain text when piped. */
export function banner(version?: string): string {
  const mark = [
    "┬  ┌─┐┬┌┐┌",
    "│  ├─┤││││",
    "┴─┘┴ ┴┴┘└┘",
  ];
  const v = version ? c.muted(`v${version}`) : "";
  return [
    "",
    "  " + c.accent(mark[0]),
    "  " + c.accent(mark[1]) + "    " + dim("a graph-based ideation engine"),
    "  " + c.accent(mark[2]) + "    " + dim("everything is connected") + (v ? "   " + v : ""),
    "",
  ].join("\n");
}

/** A horizontal rule, optionally with an inline label. */
export function rule(label?: string, width = 56): string {
  if (!label) return c.muted("─".repeat(width));
  const line = "─".repeat(Math.max(0, width - label.length - 3));
  return c.muted("── ") + c.accent(label) + " " + c.muted(line);
}

/** A section header. */
export function section(title: string): string {
  return bold(c.fg(title));
}

/** Aligned key/value row. */
export function kv(key: string, value: string, pad = 14): string {
  return `  ${c.muted(key.padEnd(pad))}${value}`;
}
