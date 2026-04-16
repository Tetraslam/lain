import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
} from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { Storage, Graph } from "@lain/core";
import type { LainNode, Exploration } from "@lain/shared";

interface AppState {
  exploration: Exploration;
  nodes: LainNode[];
  selectedNodeId: string;
  treeLines: TreeLine[];
  scrollOffset: number;
}

interface TreeLine {
  nodeId: string;
  prefix: string;
  title: string;
  status: string;
  depth: number;
}

export async function createApp(dbPath: string): Promise<void> {
  const storage = new Storage(dbPath);
  const graph = new Graph(storage);

  const explorations = graph.getAllExplorations();
  if (explorations.length === 0) {
    storage.close();
    throw new Error("No explorations in this database.");
  }

  const exploration = explorations[0];
  const allNodes = graph.getAllNodes(exploration.id);
  const root = allNodes.find((n) => n.parentId === null);
  if (!root) {
    storage.close();
    throw new Error("No root node found.");
  }

  // Build tree lines for display
  const treeLines = buildTreeLines(root, allNodes);

  const state: AppState = {
    exploration,
    nodes: allNodes,
    selectedNodeId: root.id,
    treeLines,
    scrollOffset: 0,
  };

  // Create renderer
  const renderer = await createCliRenderer();

  // Main container - full screen, column layout
  const container = new BoxRenderable(renderer, {
    id: "container",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });
  renderer.root.add(container);

  // Header
  const header = new BoxRenderable(renderer, {
    id: "header",
    width: "100%",
    height: 3,
    border: true,
    borderStyle: "round",
    borderColor: "#555",
    justifyContent: "center",
    alignItems: "center",
    paddingLeft: 1,
    paddingRight: 1,
  });
  container.add(header);

  const headerText = new TextRenderable(renderer, {
    id: "header-text",
    content: `lain — ${exploration.name} (${exploration.id}) | n=${exploration.n} m=${exploration.m} ${exploration.extension}`,
    fg: "#00AAFF",
  });
  header.add(headerText);

  // Content area - row layout (tree | content)
  const contentArea = new BoxRenderable(renderer, {
    id: "content-area",
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
    marginTop: 1,
  });
  container.add(contentArea);

  // Tree panel (left)
  const treePanel = new BoxRenderable(renderer, {
    id: "tree-panel",
    width: "40%",
    height: "100%",
    border: true,
    borderStyle: "round",
    borderColor: "#00AAFF",
    title: " Tree ",
    titleAlignment: "left",
    paddingLeft: 1,
    paddingRight: 1,
    flexDirection: "column",
    overflow: "hidden",
  });
  contentArea.add(treePanel);

  // Content panel (right)
  const contentPanel = new BoxRenderable(renderer, {
    id: "content-panel",
    flexGrow: 1,
    height: "100%",
    border: true,
    borderStyle: "round",
    borderColor: "#555",
    title: " Node ",
    titleAlignment: "left",
    paddingLeft: 1,
    paddingRight: 1,
    marginLeft: 1,
    flexDirection: "column",
    overflow: "hidden",
  });
  contentArea.add(contentPanel);

  // Tree content
  const treeText = new TextRenderable(renderer, {
    id: "tree-text",
    content: renderTree(state),
    fg: "#CCCCCC",
  });
  treePanel.add(treeText);

  // Node content
  const nodeTitle = new TextRenderable(renderer, {
    id: "node-title",
    content: "",
    fg: "#FFAA00",
  });
  contentPanel.add(nodeTitle);

  const nodeInfo = new TextRenderable(renderer, {
    id: "node-info",
    content: "",
    fg: "#888888",
  });
  contentPanel.add(nodeInfo);

  const nodeContent = new TextRenderable(renderer, {
    id: "node-content",
    content: "",
    fg: "#CCCCCC",
  });
  contentPanel.add(nodeContent);

  // Footer / status bar
  const footer = new BoxRenderable(renderer, {
    id: "footer",
    width: "100%",
    height: 1,
    marginTop: 1,
  });
  container.add(footer);

  const footerText = new TextRenderable(renderer, {
    id: "footer-text",
    content: " ↑↓ navigate | enter select | q quit | p prune | e extend | r redirect",
    fg: "#666666",
  });
  footer.add(footerText);

  // Initial render
  updateNodePanel(state, nodeTitle, nodeInfo, nodeContent, graph);

  // Keyboard handling
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    const currentIdx = state.treeLines.findIndex(
      (l) => l.nodeId === state.selectedNodeId
    );

    switch (key.name) {
      case "up":
      case "k": {
        if (currentIdx > 0) {
          state.selectedNodeId = state.treeLines[currentIdx - 1].nodeId;
          treeText.content = renderTree(state);
          updateNodePanel(state, nodeTitle, nodeInfo, nodeContent, graph);
        }
        break;
      }
      case "down":
      case "j": {
        if (currentIdx < state.treeLines.length - 1) {
          state.selectedNodeId = state.treeLines[currentIdx + 1].nodeId;
          treeText.content = renderTree(state);
          updateNodePanel(state, nodeTitle, nodeInfo, nodeContent, graph);
        }
        break;
      }
      case "q":
      case "escape": {
        storage.close();
        renderer.destroy();
        process.exit(0);
      }
    }
  });
}

function buildTreeLines(
  node: LainNode,
  allNodes: LainNode[],
  prefix = "",
  isLast = true,
  isRoot = true
): TreeLine[] {
  const lines: TreeLine[] = [];

  const connector = isRoot ? "" : isLast ? "└── " : "├── ";
  const statusTag =
    node.status === "pruned"
      ? " [pruned]"
      : node.status === "pending"
        ? " [pending]"
        : "";

  lines.push({
    nodeId: node.id,
    prefix: prefix + connector,
    title: node.title || node.id,
    status: statusTag,
    depth: node.depth,
  });

  const children = allNodes
    .filter((n) => n.parentId === node.id)
    .sort((a, b) => a.branchIndex - b.branchIndex);

  const childPrefix = isRoot ? "" : prefix + (isLast ? "    " : "│   ");

  children.forEach((child, i) => {
    lines.push(
      ...buildTreeLines(child, allNodes, childPrefix, i === children.length - 1, false)
    );
  });

  return lines;
}

function renderTree(state: AppState): string {
  return state.treeLines
    .map((line) => {
      const selected = line.nodeId === state.selectedNodeId;
      const marker = selected ? "▶ " : "  ";
      const text = `${marker}${line.prefix}${line.title}${line.status}`;
      return text;
    })
    .join("\n");
}

function updateNodePanel(
  state: AppState,
  titleEl: TextRenderable,
  infoEl: TextRenderable,
  contentEl: TextRenderable,
  graph: Graph
): void {
  const node = graph.getNode(state.selectedNodeId);
  if (!node) return;

  titleEl.content = `# ${node.title || node.id}`;
  infoEl.content = [
    `ID: ${node.id} | Depth: ${node.depth} | Status: ${node.status}`,
    node.model ? `Model: ${node.model} (${node.provider})` : "",
    node.planSummary ? `Direction: ${node.planSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const crosslinks = graph.getNode(node.id)
    ? (graph as any).storage?.getCrosslinksForNode?.(node.id) || []
    : [];

  let body = node.content || "(no content)";

  if (crosslinks.length > 0) {
    body += "\n\nCross-links:";
    for (const cl of crosslinks) {
      const otherId = cl.sourceId === node.id ? cl.targetId : cl.sourceId;
      body += `\n  → ${otherId}${cl.label ? `: ${cl.label}` : ""}`;
    }
  }

  contentEl.content = body;
}
