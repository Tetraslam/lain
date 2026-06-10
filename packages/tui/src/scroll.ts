// Scrollbar polish shared across the TUI's scroll areas:
//   • gentler thumb scaling — OpenTUI floors the thumb to ~1 cell on long
//     content; we keep a grabbable minimum and ease the shrink so it stays
//     useful without decoupling drag distance from scroll position.
//   • predictable wheel scrolling — drop the acceleration curve so a small
//     wheel nudge moves a few lines, not a screenful.
//   • hover animation — the thumb warms from muted → accent when the pointer is
//     over the bar, tweened over a few frames.

import type { ScrollBoxRenderable } from "@opentui/core";
import { c } from "./theme.js";

/** Linear (no-acceleration) scroll: every wheel tick advances one step. */
const LINEAR_ACCEL = { tick: () => 1, reset: () => {} };

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c2(r)}${c2(g)}${c2(b)}`;
}
function lerpHex(from: string, to: string, t: number): string {
  const a = hexToRgb(from), b = hexToRgb(to);
  return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

/** Tune a ScrollBox's vertical scrollbar: thumb sizing, wheel feel, hover glow. */
export function tuneScroll(scroll: ScrollBoxRenderable): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = scroll as any;
  try { s.scrollAccel = LINEAR_ACCEL; } catch { /* ignore */ }

  const bar = s.verticalScrollBar;
  const slider = bar?.slider;
  if (!slider) return;

  // Gentler thumb: ease the shrink and never go below ~3 rows (6 half-cells).
  slider.getVirtualThumbSize = function (this: any): number {
    const track = this.height * 2;
    const range = this._max - this._min;
    if (range === 0) return track;
    const vp = Math.max(1, this._viewPortSize);
    const content = range + vp;
    if (content <= vp) return track;
    const ratio = vp / content;
    const eased = Math.max(ratio, Math.sqrt(ratio) * 0.6); // less aggressive than linear
    const minThumb = Math.min(track, 6);
    return Math.max(minThumb, Math.min(Math.floor(track * eased), track));
  };

  // Hover glow: tween the thumb colour between muted and accent. We track the
  // current colour locally (the renderable's getter returns RGBA, not hex).
  const BASE = c.dim, HOVER = c.accent;
  let current = BASE;
  try { slider.foregroundColor = BASE; slider.backgroundColor = c.surface; } catch { /* ignore */ }
  let timer: ReturnType<typeof setInterval> | null = null;
  const animateTo = (target: string) => {
    if (timer) clearInterval(timer);
    const from = current;
    let step = 0;
    const steps = 8;
    timer = setInterval(() => {
      step++;
      current = lerpHex(from, target, Math.min(1, step / steps));
      try { slider.foregroundColor = current; } catch { /* ignore */ }
      if (step >= steps && timer) { clearInterval(timer); timer = null; current = target; }
    }, 16);
  };
  // Attach to both the bar and its thumb so hovering anywhere on it glows.
  for (const target of [bar, slider]) {
    if (!target) continue;
    target.onMouseOver = () => animateTo(HOVER);
    target.onMouseOut = () => animateTo(BASE);
  }
}
