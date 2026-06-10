// Test helpers for the always-agentic orchestrator: node generation now goes
// through `converse`, so mock providers deliver a node by returning a single
// `submit_node` tool call. These helpers parse the node id out of the task
// prompt and build that turn, so existing per-node assertions still hold.

import type { ConverseResult } from "@lain/shared";

/** Extract the node id from the agent's task prompt (buildTaskMessage). */
export function parseNodeId(messages: unknown): string {
  const msgs = Array.isArray(messages) ? messages : [];
  const text = msgs
    .flatMap((m: any) => (Array.isArray(m?.content) ? m.content : [{ type: "text", text: String(m?.content ?? "") }]))
    .map((b: any) => (b?.type === "text" ? String(b.text ?? "") : ""))
    .join("\n");
  const m = text.match(/this node \((root[\w-]*)\)/i) || text.match(/This is node (root[\w-]*)/);
  return m ? m[1] : "root";
}

/** A single assistant turn that delivers the final node via submit_node. */
export function submitNodeTurn(title: string, content: string): ConverseResult {
  return {
    stopReason: "tool_use",
    content: [{ type: "tool_use", id: "submit", name: "submit_node", input: { title, content } }],
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}
