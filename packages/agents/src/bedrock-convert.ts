// Converters between lain's provider-agnostic agent wire types and the
// Amazon Bedrock Converse API JSON shape.
//
// Bedrock Converse content blocks differ from lain's:
//   text       -> { text }
//   image      -> { image: { format, source: { bytes: <base64> } } }
//   tool_use   -> { toolUse: { toolUseId, name, input } }
//   tool_result-> { toolResult: { toolUseId, content: [...], status } }

import type {
  AgentMessage,
  ContentBlock,
  ImageFormat,
  StopReason,
  ToolSpec,
  ToolResultBlock,
} from "@lain/shared";

interface BedrockBlock {
  text?: string;
  image?: { format: string; source: { bytes: string } };
  toolUse?: { toolUseId: string; name: string; input: Record<string, unknown> };
  toolResult?: {
    toolUseId: string;
    content: Array<{ text?: string; image?: { format: string; source: { bytes: string } } }>;
    status?: "success" | "error";
  };
}

interface BedrockMessage {
  role: "user" | "assistant";
  content: BedrockBlock[];
}

function toBedrockResultContent(block: ToolResultBlock): BedrockBlock {
  if (block.type === "image") {
    return { image: { format: block.format, source: { bytes: block.data } } };
  }
  return { text: block.text };
}

function blockToBedrock(block: ContentBlock): BedrockBlock {
  switch (block.type) {
    case "text":
      return { text: block.text };
    case "image":
      return { image: { format: block.format, source: { bytes: block.data } } };
    case "tool_use":
      return { toolUse: { toolUseId: block.id, name: block.name, input: block.input } };
    case "tool_result":
      return {
        toolResult: {
          toolUseId: block.toolUseId,
          content: block.content.map(toBedrockResultContent),
          status: block.isError ? "error" : "success",
        },
      };
  }
}

export function toBedrockMessages(messages: AgentMessage[]): BedrockMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map(blockToBedrock),
  }));
}

export function toBedrockTools(tools: ToolSpec[]): unknown {
  return {
    tools: tools.map((t) => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: { json: t.inputSchema },
      },
    })),
  };
}

/** Convert Bedrock assistant content blocks back into lain ContentBlocks. */
export function fromBedrockContent(content: BedrockBlock[] | undefined): ContentBlock[] {
  if (!content) return [];
  const out: ContentBlock[] = [];
  for (const b of content) {
    if (b.text !== undefined) {
      out.push({ type: "text", text: b.text });
    } else if (b.toolUse) {
      out.push({
        type: "tool_use",
        id: b.toolUse.toolUseId,
        name: b.toolUse.name,
        input: b.toolUse.input ?? {},
      });
    } else if (b.image) {
      out.push({
        type: "image",
        format: (b.image.format as ImageFormat) ?? "png",
        data: b.image.source.bytes,
      });
    }
  }
  return out;
}

export function mapBedrockStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "guardrail_intervened":
    case "content_filtered":
      return "guardrail";
    default:
      return "unknown";
  }
}
