import type {
  AgentProvider,
  GenerateRequest,
  GenerateResponse,
  PlanRequest,
  PlanResponse,
} from "@lain/shared";
import { buildGeneratePrompt, buildPlanPrompt } from "./prompts.js";

export interface BedrockProviderOptions {
  apiKey: string;            // Bedrock API key (ABSK...)
  region?: string;           // AWS region, default us-west-2
  model?: string;            // Anthropic model name, mapped to bedrock model ID
  maxTokens?: number;
}

/**
 * Map common Anthropic model names to Bedrock model IDs.
 */
function toBedrockModelId(model: string): string {
  if (model.startsWith("anthropic.") || model.startsWith("us.anthropic.") || model.includes(":")) {
    return model;
  }

  const map: Record<string, string> = {
    "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6",
    "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1",
    "claude-sonnet-4-20250514": "us.anthropic.claude-sonnet-4-20250514-v1:0",
    "claude-haiku-4-20250414": "us.anthropic.claude-haiku-4-20250414-v1:0",
    "claude-opus-4-20250514": "us.anthropic.claude-opus-4-20250514-v1:0",
    "claude-3-5-sonnet-20241022": "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "claude-3-5-haiku-20241022": "us.anthropic.claude-3-5-haiku-20241022-v1:0",
    "claude-3-haiku-20240307": "anthropic.claude-3-haiku-20240307-v1:0",
  };

  return map[model] || `us.anthropic.${model}-v1:0`;
}

/**
 * Bedrock provider using the Bedrock API key (bearer token) auth.
 * Hits the Bedrock Converse API directly via fetch.
 */
export class BedrockProvider implements AgentProvider {
  private apiKey: string;
  private region: string;
  private model: string;
  private maxTokens: number;
  private baseUrl: string;

  constructor(options: BedrockProviderOptions) {
    this.apiKey = options.apiKey;
    this.region = options.region ?? "us-west-2";
    this.model = toBedrockModelId(options.model ?? "claude-sonnet-4-6");
    this.maxTokens = options.maxTokens ?? 2048;
    this.baseUrl = `https://bedrock-runtime.${this.region}.amazonaws.com`;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const { system, user } = buildGeneratePrompt(request);
    const text = await this.converse(system, user, this.maxTokens);
    return this.parseGenerateResponse(text);
  }

  async generateStream(
    request: GenerateRequest,
    onChunk: (chunk: string) => void
  ): Promise<GenerateResponse> {
    const { system, user } = buildGeneratePrompt(request);
    const text = await this.converseStream(system, user, this.maxTokens, onChunk);
    return this.parseGenerateResponse(text);
  }

  async plan(request: PlanRequest): Promise<PlanResponse> {
    const { system, user } = buildPlanPrompt(request);
    const text = await this.converse(system, user, 1024);

    const directions = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, request.n);

    while (directions.length < request.n) {
      directions.push(`Direction ${directions.length + 1}`);
    }

    return { directions };
  }

  /**
   * Call the Bedrock Converse API with bearer token auth.
   * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
   */
  private async converse(
    system: string,
    userMessage: string,
    maxTokens: number
  ): Promise<string> {
    const url = `${this.baseUrl}/model/${encodeURIComponent(this.model)}/converse`;

    const body = {
      messages: [
        {
          role: "user",
          content: [{ text: userMessage }],
        },
      ],
      system: [{ text: system }],
      inferenceConfig: {
        maxTokens,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Bedrock API error (${response.status}): ${errorBody}`
      );
    }

    const result = await response.json() as {
      output?: {
        message?: {
          content?: Array<{ text?: string }>;
        };
      };
    };

    const text = result.output?.message?.content?.[0]?.text;
    if (!text) {
      throw new Error(
        `Bedrock returned empty response: ${JSON.stringify(result)}`
      );
    }

    return text;
  }

  /**
   * Call the Bedrock ConverseStream API for streaming responses.
   * Parses the AWS event stream format and emits text chunks.
   */
  private async converseStream(
    system: string,
    userMessage: string,
    maxTokens: number,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    const url = `${this.baseUrl}/model/${encodeURIComponent(this.model)}/converse-stream`;

    const body = {
      messages: [
        { role: "user", content: [{ text: userMessage }] },
      ],
      system: [{ text: system }],
      inferenceConfig: { maxTokens },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Bedrock stream error (${response.status}): ${errorBody}`);
    }

    if (!response.body) {
      throw new Error("Bedrock stream: no response body");
    }

    // Parse AWS event stream format
    // Events come as lines of JSON, each containing a type field
    let fullText = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // AWS event streams use newline-delimited JSON events
      // Each event has a :event-type header and a JSON payload
      // The actual content comes in contentBlockDelta events with delta.text
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        try {
          const event = JSON.parse(trimmed);

          if (event.contentBlockDelta?.delta?.text) {
            const chunk = event.contentBlockDelta.delta.text;
            fullText += chunk;
            onChunk(chunk);
          }
        } catch {
          // Not JSON — might be AWS event stream framing, skip
          // Try to extract JSON from binary event stream frames
          const jsonMatch = trimmed.match(/\{.*"contentBlockDelta".*\}/);
          if (jsonMatch) {
            try {
              const event = JSON.parse(jsonMatch[0]);
              if (event.contentBlockDelta?.delta?.text) {
                const chunk = event.contentBlockDelta.delta.text;
                fullText += chunk;
                onChunk(chunk);
              }
            } catch {}
          }
        }
      }
    }

    if (!fullText) {
      throw new Error("Bedrock stream returned empty response");
    }

    return fullText;
  }

  private parseGenerateResponse(text: string): GenerateResponse {
    const lines = text.split("\n");
    const titleLine = lines[0]?.trim() || "Untitled";
    const title = titleLine.replace(/^#+\s*/, "");
    const content = lines.slice(1).join("\n").trim();
    return { title, content, model: this.model, provider: "bedrock" };
  }
}
