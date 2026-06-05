// Converters between lain's agent wire types and the OpenAI Chat Completions
// JSON shape. This format is shared by OpenAI, OpenRouter, and most
// OpenAI-compatible endpoints (ollama, together, groq, vLLM, …), so a single
// provider covers a huge surface.
//
// Chat Completions specifics:
//   - system prompt is a separate { role: "system" } message
//   - assistant tool calls live in message.tool_calls[] with stringified args
//   - tool results are { role: "tool", tool_call_id, content }
//   - images are user-content parts: { type: "image_url", image_url: { url } }

import type {
  AgentMessage,
  ContentBlock,
  ImageFormat,
  StopReason,
  ToolSpec,
} from "@lain/shared";

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Build the OpenAI `messages` array (system prepended) from lain messages. */
export function toOpenAIMessages(system: string, messages: AgentMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    // tool_result blocks must become separate { role: "tool" } messages.
    const toolResults = m.content.filter((b) => b.type === "tool_result");
    const nonToolResults = m.content.filter((b) => b.type !== "tool_result");

    if (m.role === "assistant") {
      const toolCalls = nonToolResults
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const text = nonToolResults
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // user role: emit any tool results first, then the remaining content.
    for (const tr of toolResults) {
      if (tr.type !== "tool_result") continue;
      const textContent = tr.content
        .map((c) => (c.type === "text" ? c.text : "[image omitted in tool result]"))
        .join("\n");
      out.push({ role: "tool", tool_call_id: tr.toolUseId, content: textContent });
    }
    if (nonToolResults.length > 0) {
      out.push({ role: "user", content: toUserParts(nonToolResults) });
    }
  }
  return out;
}

function toUserParts(blocks: ContentBlock[]): string | OpenAIContentPart[] {
  // If it's purely text, collapse to a string (simpler + broadly compatible).
  if (blocks.every((b) => b.type === "text")) {
    return blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
  }
  const parts: OpenAIContentPart[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "image")
      parts.push({ type: "image_url", image_url: { url: `data:image/${b.format};base64,${b.data}` } });
  }
  return parts;
}

export function toOpenAITools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

interface OpenAIChoiceMessage {
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

/** Convert an OpenAI choice message back into lain ContentBlocks. */
export function fromOpenAIMessage(msg: OpenAIChoiceMessage | undefined): ContentBlock[] {
  const out: ContentBlock[] = [];
  if (!msg) return out;
  if (msg.content) out.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      input = { _raw: tc.function.arguments };
    }
    out.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }
  return out;
}

export function mapOpenAIStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "guardrail";
    default:
      return "unknown";
  }
}

/** Unused but exported for symmetry/testing of image format mapping. */
export function dataUrl(format: ImageFormat, data: string): string {
  return `data:image/${format};base64,${data}`;
}
