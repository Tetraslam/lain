import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentProvider,
  GenerateRequest,
  GenerateResponse,
  PlanRequest,
  PlanResponse,
  SynthesizeRequest,
  SynthesizeResponse,
  ConverseRequest,
  ConverseResult,
  ContentBlock,
  ImageFormat,
  Provider,
  StopReason,
} from "@lain/shared";
import { buildGeneratePrompt, buildPlanPrompt, buildSynthesizePrompt, parseSynthesizeResponse } from "./prompts.js";

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

export class AnthropicProvider implements AgentProvider {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;

  constructor(options: AnthropicProviderOptions = {}) {
    this.client = new Anthropic({
      apiKey: options.apiKey, // falls back to ANTHROPIC_API_KEY env var
    });
    this.model = options.model ?? "claude-sonnet-4-6";
    this.maxTokens = options.maxTokens ?? 2048;
  }

  get modelId(): string {
    return this.model;
  }

  get providerName(): Provider {
    return "anthropic";
  }

  /** Low-level tool-capable converse primitive (Anthropic Messages API). */
  async converse(request: ConverseRequest): Promise<ConverseResult> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      system: request.system,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content.map(toAnthropicBlock),
      })),
    });

    return {
      content: message.content.map(fromAnthropicBlock),
      stopReason: mapAnthropicStop(message.stop_reason),
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const { system, user } = buildGeneratePrompt(request);

    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";

    return this.parseGenerateResponse(text);
  }

  async generateStream(
    request: GenerateRequest,
    onChunk: (chunk: string) => void
  ): Promise<GenerateResponse> {
    const { system, user } = buildGeneratePrompt(request);

    let fullText = "";

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        fullText += event.delta.text;
        onChunk(event.delta.text);
      }
    }

    return this.parseGenerateResponse(fullText);
  }

  async plan(request: PlanRequest): Promise<PlanResponse> {
    const { system, user } = buildPlanPrompt(request);

    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";

    const directions = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, request.n);

    // Pad if model returned fewer than requested
    while (directions.length < request.n) {
      directions.push(`Direction ${directions.length + 1}`);
    }

    return { directions };
  }

  private parseGenerateResponse(text: string): GenerateResponse {
    const lines = text.split("\n");
    const titleLine = lines[0]?.trim() || "Untitled";
    // Remove markdown heading prefix if the model added one
    const title = titleLine.replace(/^#+\s*/, "");
    const content = lines.slice(1).join("\n").trim();

    return { title, content, model: this.model, provider: "anthropic" };
  }

  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResponse> {
    const { system, user } = buildSynthesizePrompt(request);

    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";

    return parseSynthesizeResponse(text, this.model, "anthropic");
  }

  async generateRaw(system: string, user: string, maxTokens = 4096): Promise<string> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    return message.content[0].type === "text" ? message.content[0].text : "";
  }
}

// ---------------------------------------------------------------------------
// Block converters (lain ContentBlock <-> Anthropic content blocks)
// ---------------------------------------------------------------------------

function toAnthropicBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        source: { type: "base64", media_type: `image/${block.format}` as `image/${ImageFormat}`, data: block.data },
      };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        is_error: block.isError ?? false,
        content: block.content.map((c) =>
          c.type === "image"
            ? {
                type: "image" as const,
                source: { type: "base64" as const, media_type: `image/${c.format}` as `image/${ImageFormat}`, data: c.data },
              }
            : { type: "text" as const, text: c.text }
        ),
      };
  }
}

function fromAnthropicBlock(block: Anthropic.ContentBlock): ContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      };
    default:
      // thinking / other block types collapse to empty text
      return { type: "text", text: "" };
  }
}

function mapAnthropicStop(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "unknown";
  }
}
