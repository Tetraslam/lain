// @lain/shared — agent substrate wire types
//
// These are the provider-agnostic message/tool primitives that let a node
// behave as a tool-using agent rather than a single completion. They model
// the subset of the Anthropic / Bedrock Converse content-block protocol that
// lain needs: text, tool_use, tool_result, and (multimodal) image blocks.
//
// They are deliberately pure data — no handlers, no graph/corpus access — so
// they can live in @lain/shared and be referenced by every package without
// creating dependency cycles. The executable side (tools with handlers,
// graph/corpus context) lives in @lain/core.

/** Image media types we support passing to/from multimodal models. */
export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

/** A content block inside an agent message. Mirrors Converse content blocks. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; format: ImageFormat; data: string /* base64, no data: prefix */ }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      toolUseId: string;
      content: ToolResultBlock[];
      isError?: boolean;
    };

/** Content that can be returned from a tool back to the model. */
export type ToolResultBlock =
  | { type: "text"; text: string }
  | { type: "image"; format: ImageFormat; data: string };

/** A single turn in the agent conversation. */
export interface AgentMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** Wire description of a tool the model may call. `inputSchema` is JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Why the model stopped generating a turn. */
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "guardrail"
  | "unknown";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** A single low-level Converse call with optional tools. */
export interface ConverseRequest {
  system: string;
  messages: AgentMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

/** Result of one Converse turn — the assistant's content blocks + stop reason. */
export interface ConverseResult {
  content: ContentBlock[];
  stopReason: StopReason;
  usage?: TokenUsage;
}

// ---------------------------------------------------------------------------
// Agentic loop events (for streaming UX across CLI / TUI / web)
// ---------------------------------------------------------------------------

/**
 * Events emitted by the AgentRunner as it works. Surfaces subscribe to these
 * to render the agent "thinking" — tool calls, intermediate text, retrievals —
 * instead of a single opaque blob. This is what makes node generation feel
 * alive rather than a spinner.
 */
export type AgentStepEvent =
  | { kind: "step"; index: number; maxSteps: number }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; id: string; name: string; summary: string; isError: boolean }
  | { kind: "usage"; usage: TokenUsage }
  | { kind: "done"; reason: StopReason };

export type AgentStepHandler = (event: AgentStepEvent) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convenience constructor for a plain user text message. */
export function userText(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

/** Collect all text blocks from a list of content blocks into one string. */
export function collectText(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** Extract all tool_use blocks from assistant content. */
export function collectToolUses(
  content: ContentBlock[]
): Extract<ContentBlock, { type: "tool_use" }>[] {
  return content.filter(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use"
  );
}
