/**
 * Radial tree graph view with infinite canvas, viewport panning,
 * minimap, depth-scaled visual hierarchy, and guaranteed no-overlap layout.
 */
import {
  FrameBufferRenderable,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  RGBA,
} from "@opentui/core";
import { t, fg, bold } from "@opentui/core";
import type { RenderContext, KeyEvent, StyledText } from "@opentui/core";
import type { LainNode, Crosslink } from "@lain/shared";

// ============================================================================
// Types
// ============================================================================

interface GNode {
  id: string;
  title: string;
  label: string;
  labelWidth: number; // Actual rendered width including padding
  depth: number;
  status: string;
  x: number;
  y: number;
  parentId: string | null;
}

interface GEdge {
  source: string;
  target: string;
  isCrosslink: boolean;
}

// ============================================================================
// Colors — gradient by depth for information hierarchy
// ============================================================================

const BG = RGBA.fromHex("#1a1b26");

const DEPTH_COLORS: { fg: RGBA; bg: RGBA }[] = [
  { fg: RGBA.fromHex("#7aa2f7"), bg: RGBA.fromHex("#1f2335") },  // depth 0: blue on dark — THE root
  { fg: RGBA.fromHex("#c0caf5"), bg: RGBA.fromHex("#1a1b26") },  // depth 1: bright white — primary branches
  { fg: RGBA.fromHex("#a9b1d6"), bg: RGBA.fromHex("#1a1b26") },  // depth 2: normal fg
  { fg: RGBA.fromHex("#787c99"), bg: RGBA.fromHex("#1a1b26") },  // depth 3+: dim
];

const SELECTED_FG = RGBA.fromHex("#1a1b26");
const SELECTED_BG = RGBA.fromHex("#bb9af7");
const PRUNED_FG = RGBA.fromHex("#f7768e");
const EDGE_COLOR = RGBA.fromHex("#565f89");
const CROSSLINK_COLOR = RGBA.fromHex("#bb9af7");

// Minimap
const MM_BG = RGBA.fromHex("#16161e");
const MM_BORDER = RGBA.fromHex("#32344a");
const MM_NODE = RGBA.fromHex("#565f89");
const MM_ROOT = RGBA.fromHex("#7aa2f7");
const MM_SELECTED = RGBA.fromHex("#bb9af7");
const MM_EDGE = RGBA.fromHex("#292e42");
const MM_VIEWPORT = RGBA.fromHex("#3b3f5c");

// ============================================================================
// Label + visual sizing by depth
// ============================================================================

function makeLabel(title: string, depth: number): string {
  const maxLen = depth === 0 ? 44 : depth === 1 ? 30 : depth === 2 ? 20 : 14;
  const t = title || "?";
  const truncated = t.length > maxLen ? t.slice(0, maxLen - 1) + "…" : t;
  // Root gets decorators for visual weight
  if (depth === 0) return `◆ ${truncated} ◆`;
  if (depth === 1) return `▸ ${truncated}`;
  return truncated;
}

// ============================================================================
// Radial Tree Layout with no-overlap guarantee
// ============================================================================

function computeRadialLayout(lainNodes: LainNode[]): GNode[] {
  const active = lainNodes.filter((n) => n.status !== "pruned");
  if (active.length === 0) return [];

  const root = active.find((n) => n.parentId === null);
  if (!root) return [];

  const childrenOf = new Map<string, LainNode[]>();
  for (const n of active) {
    if (n.parentId) {
      const siblings = childrenOf.get(n.parentId) || [];
      siblings.push(n);
      childrenOf.set(n.parentId, siblings);
    }
  }
  for (const [, ch] of childrenOf) ch.sort((a, b) => a.branchIndex - b.branchIndex);

  const maxDepth = Math.max(...active.map((n) => n.depth), 0);

  // Ring spacing scales with how many nodes exist — more nodes need more room
  const ringSpacing = Math.max(10, Math.min(22, 50 / (maxDepth + 1)));

  const result: GNode[] = [];

  function layout(node: LainNode, angleStart: number, angleEnd: number, depth: number) {
    const angle = (angleStart + angleEnd) / 2;
    const radius = depth * ringSpacing;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius * 0.45;
    const label = makeLabel(node.title || node.id, depth);

    result.push({
      id: node.id, title: node.title || node.id, label,
      labelWidth: label.length + 2, // +2 for padding spaces
      depth: node.depth, status: node.status,
      x, y, parentId: node.parentId,
    });

    const children = childrenOf.get(node.id) || [];
    if (children.length === 0) return;
    const arcSpan = angleEnd - angleStart;
    const childArc = arcSpan / children.length;
    children.forEach((child, i) => {
      layout(child, angleStart + childArc * i, angleStart + childArc * (i + 1), depth + 1);
    });
  }

  layout(root, 0, Math.PI * 2, 0);

  // No-overlap pass: push apart nodes whose labels would collide
  for (let pass = 0; pass < 5; pass++) {
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i], b = result[j];
        const dx = b.x - a.x;
        const dy = (b.y - a.y) * 2; // Aspect correction
        const minSepX = (a.labelWidth + b.labelWidth) / 2 + 1;
        const minSepY = 2; // At least 1 row apart

        if (Math.abs(dx) < minSepX && Math.abs(b.y - a.y) < minSepY) {
          // Overlap detected — push apart along the axis with less overlap
          if (Math.abs(dx) < minSepX) {
            const push = (minSepX - Math.abs(dx)) / 2 + 0.5;
            const sign = dx >= 0 ? 1 : -1;
            a.x -= push * sign;
            b.x += push * sign;
          }
          if (Math.abs(b.y - a.y) < minSepY) {
            const push = (minSepY - Math.abs(b.y - a.y)) / 2 + 0.3;
            const sign = (b.y - a.y) >= 0 ? 1 : -1;
            a.y -= push * sign;
            b.y += push * sign;
          }
        }
      }
    }
  }

  return result;
}

// ============================================================================
// Rendering
// ============================================================================

function renderGraph(
  fb: FrameBufferRenderable, nodes: GNode[], edges: GEdge[],
  selectedId: string, vw: number, vh: number, camX: number, camY: number
): void {
  const buf = fb.frameBuffer;
  const map = new Map(nodes.map((n) => [n.id, n]));
  const ox = Math.round(vw / 2 - camX);
  const oy = Math.round(vh / 2 - camY);

  buf.fillRect(0, 0, vw, vh, BG);

  // Edges
  for (const edge of edges) {
    const a = map.get(edge.source), b = map.get(edge.target);
    if (!a || !b) continue;
    const ax = Math.round(a.x + ox), ay = Math.round(a.y + oy);
    const bx = Math.round(b.x + ox), by = Math.round(b.y + oy);
    if ((ax < -40 && bx < -40) || (ax > vw + 40 && bx > vw + 40)) continue;
    if ((ay < -15 && by < -15) || (ay > vh + 15 && by > vh + 15)) continue;
    const color = edge.isCrosslink ? CROSSLINK_COLOR : EDGE_COLOR;
    drawLine(buf, ax, ay, bx, by, "·", color, BG, edge.isCrosslink ? 1 : 2, vw, vh);
  }

  // Nodes — selected last for z-order
  const sorted = [...nodes].sort((a, b) => {
    if (a.id === selectedId) return 1;
    if (b.id === selectedId) return -1;
    return a.depth - b.depth; // Shallower nodes on top
  });

  for (const node of sorted) {
    const sx = Math.round(node.x + ox);
    const sy = Math.round(node.y + oy);
    if (sy < 0 || sy >= vh) continue;
    const padded = ` ${node.label} `;
    if (sx + padded.length < 0 || sx >= vw) continue;

    const isSelected = node.id === selectedId;
    const depthStyle = DEPTH_COLORS[Math.min(node.depth, DEPTH_COLORS.length - 1)];

    let nodeFg = depthStyle.fg;
    let nodeBg = depthStyle.bg;

    if (isSelected) { nodeFg = SELECTED_FG; nodeBg = SELECTED_BG; }
    else if (node.status === "pruned") { nodeFg = PRUNED_FG; nodeBg = BG; }

    buf.drawText(padded, sx, sy, nodeFg, nodeBg);
  }

  // Minimap
  renderMinimap(buf, nodes, edges, map, selectedId, vw, vh, camX, camY);
}

// ============================================================================
// Minimap — with edges and better node representation
// ============================================================================

function renderMinimap(
  buf: any, nodes: GNode[], edges: GEdge[], nodeMap: Map<string, GNode>,
  selectedId: string, vw: number, vh: number, camX: number, camY: number
): void {
  if (nodes.length === 0) return;

  const mmW = 22, mmH = 11;
  const mmX = vw - mmW - 1, mmY = vh - mmH - 1;

  // World bounds
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - 5); maxX = Math.max(maxX, n.x + 5);
    minY = Math.min(minY, n.y - 2); maxY = Math.max(maxY, n.y + 2);
  }
  const worldW = Math.max(maxX - minX, 10);
  const worldH = Math.max(maxY - minY, 5);

  const toMmX = (wx: number) => Math.round(((wx - minX) / worldW) * (mmW - 2)) + 1;
  const toMmY = (wy: number) => Math.round(((wy - minY) / worldH) * (mmH - 2)) + 1;

  // Background + border
  buf.fillRect(mmX, mmY, mmW, mmH, MM_BG);
  for (let x = 0; x < mmW; x++) {
    buf.setCell(mmX + x, mmY, "─", MM_BORDER, MM_BG);
    buf.setCell(mmX + x, mmY + mmH - 1, "─", MM_BORDER, MM_BG);
  }
  for (let y = 0; y < mmH; y++) {
    buf.setCell(mmX, mmY + y, "│", MM_BORDER, MM_BG);
    buf.setCell(mmX + mmW - 1, mmY + y, "│", MM_BORDER, MM_BG);
  }
  buf.setCell(mmX, mmY, "╭", MM_BORDER, MM_BG);
  buf.setCell(mmX + mmW - 1, mmY, "╮", MM_BORDER, MM_BG);
  buf.setCell(mmX, mmY + mmH - 1, "╰", MM_BORDER, MM_BG);
  buf.setCell(mmX + mmW - 1, mmY + mmH - 1, "╯", MM_BORDER, MM_BG);

  // Viewport rectangle
  const vpL = toMmX(camX - vw / 2);
  const vpR = toMmX(camX + vw / 2);
  const vpT = toMmY(camY - vh / 2);
  const vpB = toMmY(camY + vh / 2);
  for (let x = Math.max(1, vpL); x <= Math.min(mmW - 2, vpR); x++) {
    for (let y = Math.max(1, vpT); y <= Math.min(mmH - 2, vpB); y++) {
      buf.setCell(mmX + x, mmY + y, " ", MM_VIEWPORT, MM_VIEWPORT);
    }
  }

  // Edges
  for (const edge of edges) {
    const a = nodeMap.get(edge.source), b = nodeMap.get(edge.target);
    if (!a || !b) continue;
    const ax = toMmX(a.x), ay = toMmY(a.y);
    const bx = toMmX(b.x), by = toMmY(b.y);
    drawLine(buf, mmX + ax, mmY + ay, mmX + bx, mmY + by, "·", MM_EDGE, MM_BG, 1, mmX + mmW, mmY + mmH);
  }

  // Nodes
  for (const n of nodes) {
    const nx = toMmX(n.x), ny = toMmY(n.y);
    if (nx >= 1 && nx < mmW - 1 && ny >= 1 && ny < mmH - 1) {
      let ch = "·", color = MM_NODE;
      if (n.id === selectedId) { ch = "◆"; color = MM_SELECTED; }
      else if (n.depth === 0) { ch = "◆"; color = MM_ROOT; }
      else if (n.depth === 1) { ch = "●"; }
      buf.setCell(mmX + nx, mmY + ny, ch, color, MM_BG);
    }
  }
}

function drawLine(
  buf: any, x0: number, y0: number, x1: number, y1: number,
  ch: string, color: RGBA, bg: RGBA, spacing: number, maxW: number, maxH: number
): void {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, steps = 0;
  while (true) {
    if (steps % spacing === 0 && x0 >= 0 && x0 < maxW && y0 >= 0 && y0 < maxH) {
      buf.setCell(x0, y0, ch, color, bg);
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
    steps++;
    if (steps > 2000) break;
  }
}

// ============================================================================
// Graph View
// ============================================================================

export interface GraphViewOptions {
  renderer: RenderContext;
  nodes: LainNode[];
  crosslinks: Crosslink[];
  graphWidth: number;
  graphHeight: number;
  onNodeSelect?: (nodeId: string) => void;
}

export class GraphView {
  private fb: FrameBufferRenderable;
  private graphNodes: GNode[] = [];
  private edges: GEdge[] = [];
  private selectedIdx = 0;
  private renderer: RenderContext;
  private vw: number;
  private vh: number;
  private camX = 0;
  private camY = 0;
  private targetCamX = 0;
  private targetCamY = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private onNodeSelect?: (nodeId: string) => void;
  private allLainNodes: LainNode[];

  peekBox: BoxRenderable;
  private peekScroll: ScrollBoxRenderable;
  private peekText: TextRenderable;

  constructor(opts: GraphViewOptions) {
    this.renderer = opts.renderer;
    this.vw = opts.graphWidth;
    this.vh = opts.graphHeight;
    this.onNodeSelect = opts.onNodeSelect;
    this.allLainNodes = opts.nodes;

    this.graphNodes = computeRadialLayout(opts.nodes);

    for (const gn of this.graphNodes) {
      if (gn.parentId) this.edges.push({ source: gn.parentId, target: gn.id, isCrosslink: false });
    }
    for (const cl of opts.crosslinks) {
      if (this.graphNodes.some((n) => n.id === cl.sourceId) && this.graphNodes.some((n) => n.id === cl.targetId)) {
        this.edges.push({ source: cl.sourceId, target: cl.targetId, isCrosslink: true });
      }
    }

    this.fb = new FrameBufferRenderable(this.renderer, {
      id: "graph-fb", width: this.vw, height: this.vh,
    });

    this.peekBox = new BoxRenderable(this.renderer, {
      id: "graph-peek", width: 32, height: "100%",
      border: true, borderStyle: "rounded", borderColor: "#bb9af7",
      paddingLeft: 1, paddingRight: 1, paddingTop: 1,
      flexDirection: "column", overflow: "hidden",
    });
    this.peekScroll = new ScrollBoxRenderable(this.renderer, { id: "graph-peek-scroll", scrollY: true, scrollX: false });
    this.peekBox.add(this.peekScroll);
    this.peekText = new TextRenderable(this.renderer, { id: "graph-peek-text", content: "", width: "100%" });
    this.peekScroll.content.add(this.peekText);

    if (this.graphNodes.length > 0) this.updatePeek();
  }

  getRenderables() { return { fb: this.fb, peek: this.peekBox }; }

  start() {
    // Static layout — no physics, just render. Camera panning is the only animation.
    this.renderFrame();

    (this.renderer as any).requestLive?.();
    this.interval = setInterval(() => {
      // Smooth camera pan only (no node movement)
      const dx = this.targetCamX - this.camX;
      const dy = this.targetCamY - this.camY;
      if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
        this.camX += dx * 0.25;
        this.camY += dy * 0.25;
        this.renderFrame();
      }
    }, 33); // 30fps for smooth camera panning
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    (this.renderer as any).dropLive?.();
  }

  resize(w: number, h: number) {
    this.vw = w; this.vh = h;
    this.fb.width = w; this.fb.height = h;
    this.renderFrame();
  }

  private renderFrame() {
    renderGraph(this.fb, this.graphNodes, this.edges, this.getSelectedId(), this.vw, this.vh, this.camX, this.camY);
  }

  handleKey(key: KeyEvent) {
    if (this.graphNodes.length === 0) return;
    const current = this.graphNodes[this.selectedIdx];
    if (!current) return;

    let target: GNode | null = null;
    switch (key.name) {
      case "right": case "l": target = this.findNearest(current, 1, 0); break;
      case "left": case "h": target = this.findNearest(current, -1, 0); break;
      case "down": case "j": target = this.findNearest(current, 0, 1); break;
      case "up": case "k": target = this.findNearest(current, 0, -1); break;
      case "return": this.onNodeSelect?.(this.getSelectedId()); return;
    }

    if (target) {
      this.selectedIdx = this.graphNodes.indexOf(target);
      this.targetCamX = target.x;
      this.targetCamY = target.y;
      this.renderFrame(); // Immediate re-render for selection highlight
      this.updatePeek();
    }
  }

  private findNearest(from: GNode, dx: number, dy: number): GNode | null {
    let best: GNode | null = null, bestScore = Infinity;
    for (const c of this.graphNodes) {
      if (c.id === from.id) continue;
      const cdx = c.x - from.x, cdy = (c.y - from.y) * 2;
      const dot = cdx * dx + cdy * dy;
      if (dot <= 0) continue;
      const dist = Math.sqrt(cdx * cdx + cdy * cdy);
      const alignment = dot / (dist * Math.sqrt(dx * dx + dy * dy) + 0.001);
      const score = dist / (alignment * alignment + 0.01);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  getSelectedId(): string { return this.graphNodes[this.selectedIdx]?.id || ""; }

  private updatePeek() {
    const gn = this.graphNodes[this.selectedIdx];
    if (!gn) return;
    const ln = this.allLainNodes.find((n) => n.id === gn.id);
    const content = ln?.content
      ? (ln.content.length > 300 ? ln.content.slice(0, 297) + "…" : ln.content)
      : "(no content)";

    this.peekText.content = t`${bold(fg("#c0caf5")(gn.title))}

${fg("#7aa2f7")("id")}  ${gn.id}
${fg("#7aa2f7")("depth")}  ${String(gn.depth)}
${fg("#7aa2f7")("status")}  ${gn.status}

${content}
`;
    this.peekScroll.scrollTop = 0;
  }
}
