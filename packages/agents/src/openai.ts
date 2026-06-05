// OpenAI-compatible provider (Chat Completions). Powers OpenAI, OpenRouter,
// and any OpenAI-compatible endpoint via `baseUrl`. Tool-capable + multimodal.
//
// Implemented with raw fetch (no SDK dependency) so it works uniformly across
// every compatible backend and stays easy to reason about — same philosophy as
// the Bedrock provider.

import type {
  AgentProvider,
  ConverseRequest,
  ConverseResult,
  GenerateRequest,
  GenerateResponse,
  PlanRequest,
  PlanResponse,
  Provider,
  SynthesizeRequest,
  SynthesizeResponse,
} from "@lain/shared";
import { userText } from "@lain/shared";
import {
  buildGeneratePrompt,
  buildPlanPrompt,
  buildSynthesizePrompt,
  parseSynthesizeResponse,
} from "./prompts.js";
import {
  toOpenAIMessages,
  toOpenAITools,
  fromOpenAIMessage,
  mapOpenAIStop,
} from "./openai-convert.js";

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  /** Provider label for attribution (openai | openrouter). */
  label?: Provider;
  /** Extra headers (e.g. OpenRouter ranking headers). */
  headers?: Record<string, string>;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export class OpenAIProvider implements AgentProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private maxTokens: number;
  private label: Provider;
  private headers: Record<string, string>;

  constructor(options: OpenAIProviderOptions = {}) {
    this.apiKey = options.apiKey ?? "";
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = options.model ?? "gpt-4o";
    this.maxTokens = options.maxTokens ?? 2048;
    this.label = options.label ?? "openai";
    this.headers = options.headers ?? {};
  }

  get modelId(): string {
    return this.model;
  }

  get providerName(): Provider {
    return this.label;
  }

  async converse(request: ConverseRequest): Promise<ConverseResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(request.system, request.messages),
      max_tokens: request.maxTokens ?? this.maxTokens,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools && request.tools.length > 0) {
      body.tools = toOpenAITools(request.tools);
      body.tool_choice = "auto";
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...this.headers,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`${this.label} API error (${response.status}): ${errBody}`);
    }

    const result = (await response.json()) as {
      choices?: Array<{ message?: { content: string | null; tool_calls?: never }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = result.choices?.[0];

    return {
      content: fromOpenAIMessage(choice?.message as never),
      stopReason: mapOpenAIStop(choice?.finish_reason),
      usage: result.usage
        ? { inputTokens: result.usage.prompt_tokens ?? 0, outputTokens: result.usage.completion_tokens ?? 0 }
        : undefined,
    };
  }

  // ---- High-level methods built on converse + shared prompt builders ----

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const { system, user } = buildGeneratePrompt(request);
    const text = await this.text(system, user, this.maxTokens);
    return this.parseGenerate(text);
  }

  async generateStream(
    request: GenerateRequest,
    onChunk: (chunk: string) => void
  ): Promise<GenerateResponse> {
    // Non-streaming fallback that emits a single chunk — keeps the interface
    // honest without a separate SSE parser (streaming is a later refinement).
    const result = await this.generate(request);
    onChunk(`${result.title}\n${result.content}`);
    return result;
  }

  async plan(request: PlanRequest): Promise<PlanResponse> {
    const { system, user } = buildPlanPrompt(request);
    const text = await this.text(system, user, 1024);
    const directions = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, request.n);
    while (directions.length < request.n) directions.push(`Direction ${directions.length + 1}`);
    return { directions };
  }

  async synthesize(request: SynthesizeRequest): Promise<SynthesizeResponse> {
    const { system, user } = buildSynthesizePrompt(request);
    const text = await this.text(system, user, 4096);
    return parseSynthesizeResponse(text, this.model, this.label);
  }

  async generateRaw(system: string, user: string, maxTokens = 4096): Promise<string> {
    return this.text(system, user, maxTokens);
  }

  private async text(system: string, user: string, maxTokens: number): Promise<string> {
    const result = await this.converse({ system, messages: [userText(user)], maxTokens });
    return result.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  }

  private parseGenerate(text: string): GenerateResponse {
    const lines = text.split("\n");
    const title = (lines[0] ?? "Untitled").trim().replace(/^#+\s*/, "") || "Untitled";
    const content = lines.slice(1).join("\n").trim();
    return { title, content, model: this.model, provider: this.label };
  }
}
