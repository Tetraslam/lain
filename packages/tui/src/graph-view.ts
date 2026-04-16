/**
 * Graph view for the TUI.
 * 
 * Uses FrameBufferRenderable with proper clearing and a simpler visual style:
 * - Nodes are short colored labels (no boxes)
 * - Edges are single-character paths
 * - Force-directed layout with strong repulsion to prevent overlap
 * - Selected node highlighted with accent color
 */
import {
  FrameBufferRenderable,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  RGBA,
} from "@opentui/core";
import { t, fg, dim, bold } from "@opentui/core";
import type { RenderContext, KeyEvent, StyledText } from "@opentui/core";
import type { LainNode, Crosslink } from "@lain/shared";

// ============================================================================
// Types
// ============================================================================

interface GNode {
  id: string;
  title: string;
  shortTitle: string;
  depth: number;
  status: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  parentId: string | null;
}

interface GEdge {
  source: string;
  target: string;
  isCrosslink: boolean;
}

// ============================================================================
// Colors
// ============================================================================

const BG = RGBA.fromHex("#1a1b26");
const NODE_FG = RGBA.fromHex("#a9b1d6");
const NODE_DIM = RGBA.fromHex("#565f89");
const SELECTED_FG = RGBA.fromHex("#1a1b26");
const SELECTED_BG = RGBA.fromHex("#bb9af7");
const ROOT_FG = RGBA.fromHex("#7aa2f7");
const EDGE_CH = RGBA.fromHex("#32344a");
const CROSSLINK_CH = RGBA.fromHex("#7c6ea3");
const PRUNED_FG = RGBA.fromHex("#f7768e");

// ============================================================================
// Physics — tuned for terminal character grid (wide chars, tight rows)
// ============================================================================

const REPULSION = 2000;       // Strong repulsion to prevent overlap
const ATTRACTION = 0.015;     // Gentle pull along edges
const CROSSLINK_K = 0.005;
const DAMPING = 0.8;
const CENTER_GRAVITY = 0.003;
const MIN_DIST = 8;           // Minimum distance between nodes

function simulate(nodes: GNode[], edges: GEdge[], w: number, h: number): void {
  const map = new Map(nodes.map((n) => [n.id, n]));

  // Repulsion
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x;
      let dy = (a.y - b.y) * 2; // Scale Y because terminal chars are ~2x tall as wide
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), MIN_DIST);
      const force = REPULSION / (dist * dist);
      const fx = (dx / dist) * force;
      const fy = ((dy / 2) / dist) * force; // Unscale for actual movement
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
  }

  // Attraction along edges
  for (const edge of edges) {
    const a = map.get(edge.source), b = map.get(edge.target);
    if (!a || !b) continue;
    const k = edge.isCrosslink ? CROSSLINK_K : ATTRACTION;
    a.vx += (b.x - a.x) * k;
    a.vy += (b.y - a.y) * k;
    b.vx += (a.x - b.x) * k;
    b.vy += (a.y - b.y) * k;
  }

  // Center gravity
  const cx = w / 2, cy = h / 2;
  for (const n of nodes) {
    n.vx += (cx - n.x) * CENTER_GRAVITY;
    n.vy += (cy - n.y) * CENTER_GRAVITY;
  }

  // Apply + damp + clamp
  for (const n of nodes) {
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    n.x += n.vx;
    n.y += n.vy;
    n.x = Math.max(1, Math.min(w - 14, n.x)); // Leave room for label
    n.y = Math.max(1, Math.min(h - 2, n.y));
  }
}

// ============================================================================
// Rendering
// ============================================================================

function render(
  fb: FrameBufferRenderable,
  nodes: GNode[],
  edges: GEdge[],
  selectedId: string,
  w: number,
  h: number
): void {
  const buf = fb.frameBuffer;
  const map = new Map(nodes.map((n) => [n.id, n]));

  // Clear entire buffer to BG
  buf.fillRect(0, 0, w, h, BG);

  // Draw edges first (behind nodes)
  for (const edge of edges) {
    const a = map.get(edge.source), b = map.get(edge.target);
    if (!a || !b) continue;
    const color = edge.isCrosslink ? CROSSLINK_CH : EDGE_CH;
    const ch = edge.isCrosslink ? "·" : "·";
    drawLineDotted(buf, Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y), ch, color, BG);
  }

  // Draw nodes (selected last for z-order)
  const sorted = [...nodes].sort((a, b) => (a.id === selectedId ? 1 : 0) - (b.id === selectedId ? 1 : 0));
  for (const node of sorted) {
    const x = Math.round(node.x);
    const y = Math.round(node.y);
    const isSelected = node.id === selectedId;
    const label = ` ${node.shortTitle} `;

    if (isSelected) {
      buf.drawText(label, x, y, SELECTED_FG, SELECTED_BG);
    } else if (node.depth === 0) {
      buf.drawText(label, x, y, ROOT_FG, BG);
    } else if (node.status === "pruned") {
      buf.drawText(label, x, y, PRUNED_FG, BG);
    } else {
      buf.drawText(label, x, y, NODE_FG, BG);
    }
  }
}

/** Bresenham dotted line — draws every 3rd cell */
function drawLineDotted(
  buf: any, x0: number, y0: number, x1: number, y1: number,
  ch: string, color: RGBA, bg: RGBA
): void {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, steps = 0;
  while (true) {
    if (steps % 3 === 0) buf.setCell(x0, y0, ch, color, bg);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
    steps++;
    if (steps > 1000) break;
  }
}

// ============================================================================
// Graph View
// ============================================================================

export interface GraphViewOptions {
  renderer: RenderContext;
  nodes: LainNode[];
  crosslinks: Crosslink[];
  width: number;
  height: number;
  onNodeSelect?: (nodeId: string) => void;
}

export class GraphView {
  private fb: FrameBufferRenderable;
  private nodes: GNode[] = [];
  private edges: GEdge[] = [];
  private selectedIdx = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private renderer: RenderContext;
  private width: number;
  private height: number;
  private onNodeSelect?: (nodeId: string) => void;
  private allLainNodes: LainNode[];

  // Peek
  peekBox: BoxRenderable;
  private peekScroll: ScrollBoxRenderable;
  private peekText: TextRenderable;

  constructor(opts: GraphViewOptions) {
    this.renderer = opts.renderer;
    this.width = opts.width;
    this.height = opts.height;
    this.onNodeSelect = opts.onNodeSelect;
    this.allLainNodes = opts.nodes;

    this.buildGraph(opts.nodes, opts.crosslinks);

    this.fb = new FrameBufferRenderable(this.renderer, {
      id: "graph-fb",
      width: this.width,
      height: this.height,
    });

    // Peek panel
    this.peekBox = new BoxRenderable(this.renderer, {
      id: "graph-peek",
      width: 30,
      height: this.height,
      position: "absolute",
      right: 0,
      top: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: "#bb9af7",
      backgroundColor: "#1a1b26",
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "column",
      overflow: "hidden",
    });

    this.peekScroll = new ScrollBoxRenderable(this.renderer, {
      id: "graph-peek-scroll",
      scrollY: true,
      scrollX: false,
    });
    this.peekBox.add(this.peekScroll);

    this.peekText = new TextRenderable(this.renderer, {
      id: "graph-peek-text",
      content: "",
      width: "100%",
    });
    this.peekScroll.content.add(this.peekText);

    // Initial peek
    if (this.nodes.length > 0) this.updatePeek();
  }

  private buildGraph(lainNodes: LainNode[], crosslinks: Crosslink[]) {
    const active = lainNodes.filter((n) => n.status !== "pruned");
    const maxDepth = Math.max(...active.map((n) => n.depth), 0);

    // Initial layout: spread by depth (Y) and sibling index (X)
    const depthGroups = new Map<number, LainNode[]>();
    for (const n of active) {
      const g = depthGroups.get(n.depth) || [];
      g.push(n);
      depthGroups.set(n.depth, g);
    }

    for (const [depth, group] of depthGroups) {
      const yBase = ((this.height - 4) / (maxDepth + 1)) * depth + 2;
      const xSpacing = (this.width - 20) / (group.length + 1);
      group.forEach((n, i) => {
        const shortTitle = n.title
          ? (n.title.length > 12 ? n.title.slice(0, 11) + "…" : n.title)
          : n.id;
        this.nodes.push({
          id: n.id,
          title: n.title || n.id,
          shortTitle,
          depth: n.depth,
          status: n.status,
          x: xSpacing * (i + 1) + 10 + (Math.random() - 0.5) * 6,
          y: yBase + (Math.random() - 0.5) * 2,
          vx: 0, vy: 0,
          parentId: n.parentId,
        });
      });
    }

    // Parent edges
    for (const gn of this.nodes) {
      if (gn.parentId) {
        this.edges.push({ source: gn.parentId, target: gn.id, isCrosslink: false });
      }
    }

    // Crosslink edges
    for (const cl of crosslinks) {
      const hasSource = this.nodes.some((n) => n.id === cl.sourceId);
      const hasTarget = this.nodes.some((n) => n.id === cl.targetId);
      if (hasSource && hasTarget) {
        this.edges.push({ source: cl.sourceId, target: cl.targetId, isCrosslink: true });
      }
    }
  }

  getRenderables(): { fb: FrameBufferRenderable; peek: BoxRenderable } {
    return { fb: this.fb, peek: this.peekBox };
  }

  start() {
    (this.renderer as any).requestLive?.();
    this.interval = setInterval(() => {
      simulate(this.nodes, this.edges, this.width, this.height);
      render(this.fb, this.nodes, this.edges, this.getSelectedId(), this.width, this.height);
    }, 60); // ~16fps
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    (this.renderer as any).dropLive?.();
  }

  handleKey(key: KeyEvent) {
    if (this.nodes.length === 0) return;
    switch (key.name) {
      case "j": case "down":
        this.selectedIdx = (this.selectedIdx + 1) % this.nodes.length;
        this.updatePeek();
        break;
      case "k": case "up":
        this.selectedIdx = (this.selectedIdx - 1 + this.nodes.length) % this.nodes.length;
        this.updatePeek();
        break;
      case "return":
        this.onNodeSelect?.(this.getSelectedId());
        break;
    }
  }

  private getSelectedId(): string {
    return this.nodes[this.selectedIdx]?.id || "";
  }

  private updatePeek() {
    const gn = this.nodes[this.selectedIdx];
    if (!gn) return;

    // Find full lain node for content
    const lainNode = this.allLainNodes.find((n) => n.id === gn.id);
    const contentPreview = lainNode?.content
      ? (lainNode.content.length > 200 ? lainNode.content.slice(0, 197) + "…" : lainNode.content)
      : "(no content)";

    this.peekText.content = t`${bold(fg("#c0caf5")(gn.title))}

${fg("#7aa2f7")("id")}  ${gn.id}
${fg("#7aa2f7")("depth")}  ${String(gn.depth)}

${contentPreview}
`;
    this.peekScroll.scrollTop = 0;
  }
}
