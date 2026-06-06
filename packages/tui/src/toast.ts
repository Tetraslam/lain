// Minimal in-house toast for the TUI.
//
// Replaces the former `@opentui-ui/toast` add-on (which pinned an old
// @opentui/core). A single floating, bottom-right overlay shows the most recent
// transient message; non-sticky toasts auto-dismiss. Same call surface the app
// already used: toast.success/error/warning/info/loading + dismiss.

import { BoxRenderable, TextRenderable, t, fg } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { c } from "./theme.js";

type Kind = "success" | "error" | "warning" | "info" | "loading";

interface Item {
  id: number;
  kind: Kind;
  msg: string;
  timer?: ReturnType<typeof setTimeout>;
}

const GLYPH: Record<Kind, string> = { success: "✓", error: "✗", warning: "!", info: "·", loading: "…" };
const COLOR: Record<Kind, string> = { success: c.green, error: c.red, warning: c.yellow, info: c.blue, loading: c.accent };

let box: BoxRenderable | null = null;
let text: TextRenderable | null = null;
let items: Item[] = [];
let counter = 0;

function render(): void {
  if (!box || !text) return;
  if (items.length === 0) {
    box.visible = false;
    text.content = "";
    return;
  }
  const it = items[items.length - 1];
  box.visible = true;
  text.content = t`${fg(COLOR[it.kind])(GLYPH[it.kind])}  ${fg(c.bright)(it.msg)}`;
}

/** Create the toast overlay. Call once after the renderer exists. */
export function mountToaster(renderer: CliRenderer): void {
  box = new BoxRenderable(renderer, {
    id: "toaster",
    position: "absolute",
    bottom: 1,
    right: 2,
    zIndex: 1000,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: c.surface,
    visible: false,
  });
  text = new TextRenderable(renderer, { id: "toaster-text", content: "" });
  box.add(text);
  renderer.root.add(box);
}

function push(kind: Kind, msg: string, sticky = false): number {
  const id = ++counter;
  const item: Item = { id, kind, msg };
  items.push(item);
  if (items.length > 4) items.shift();
  if (!sticky) item.timer = setTimeout(() => dismiss(id), 2600);
  render();
  return id;
}

export function dismiss(id?: number): void {
  if (id == null) {
    for (const i of items) if (i.timer) clearTimeout(i.timer);
    items = [];
  } else {
    const i = items.find((x) => x.id === id);
    if (i?.timer) clearTimeout(i.timer);
    items = items.filter((x) => x.id !== id);
  }
  render();
}

export const toast = {
  success: (m: string) => push("success", m),
  error: (m: string) => push("error", m),
  warning: (m: string) => push("warning", m),
  info: (m: string) => push("info", m),
  loading: (m: string) => push("loading", m, true),
  dismiss,
};
