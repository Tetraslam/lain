// Clipboard copy for the TUI.
//
// Mirrors opencode's approach: write the text via the OSC 52 escape sequence
// (which lets the *terminal emulator* own the clipboard, so it works over SSH
// and inside tmux/screen) AND, as a bonus on local sessions, pipe it to the
// platform's native clipboard tool. Either path alone is usually enough; doing
// both maximizes the chance the copy lands.

import { spawn } from "child_process";

/** OSC 52: ask the terminal to set the system clipboard. Works over SSH/tmux. */
function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return;
  const base64 = Buffer.from(text, "utf8").toString("base64");
  const osc52 = `\x1b]52;c;${base64}\x07`;
  // tmux/screen need the sequence wrapped to pass it through to the outer term.
  const passthrough = process.env.TMUX || process.env.STY;
  const seq = passthrough ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52;
  try { process.stdout.write(seq); } catch { /* ignore */ }
}

function which(cmd: string): boolean {
  try {
    const w = (globalThis as { Bun?: { which(c: string): string | null } }).Bun?.which;
    return w ? !!w(cmd) : true; // outside Bun, optimistically try (spawn error is swallowed)
  } catch {
    return true;
  }
}

/** The native clipboard command for this platform, or null if none is available. */
function nativeCopyCommand(): string[] | null {
  const os = process.platform;
  if (os === "darwin") return which("pbcopy") ? ["pbcopy"] : null;
  if (os === "win32") return ["clip"];
  // linux / other unix
  if (process.env.WAYLAND_DISPLAY && which("wl-copy")) return ["wl-copy"];
  if (which("xclip")) return ["xclip", "-selection", "clipboard"];
  if (which("xsel")) return ["xsel", "--clipboard", "--input"];
  return null;
}

/** Copy text to the clipboard via OSC 52 + the native tool (best-effort). */
export function copyToClipboard(text: string): void {
  if (!text) return;
  writeOsc52(text);
  const cmd = nativeCopyCommand();
  if (!cmd) return;
  try {
    const proc = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
    proc.on("error", () => { /* tool missing → OSC 52 still covers us */ });
    proc.stdin.on("error", () => {});
    proc.stdin.write(text);
    proc.stdin.end();
  } catch { /* ignore */ }
}
