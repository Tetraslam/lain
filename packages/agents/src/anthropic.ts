import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentProvider,
  GenerateRequest,
  GenerateResponse,
  PlanRequest,
  PlanResponse,
  SynthesizeRequest,
  SynthesizeResponse,
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
