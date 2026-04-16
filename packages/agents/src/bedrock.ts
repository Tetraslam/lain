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

    // Parse AWS Event Stream binary format
    // Each frame contains binary headers + JSON payload
    // We extract JSON objects containing contentBlockDelta events
    let fullText = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Extract all JSON objects from the binary stream
      // They appear between binary framing as {...} patterns
      let searchFrom = 0;
      while (searchFrom < buffer.length) {
        const jsonStart = buffer.indexOf("{", searchFrom);
        if (jsonStart === -1) break;

        // Find matching closing brace (handle nested objects)
        let depth = 0;
        let jsonEnd = -1;
        for (let i = jsonStart; i < buffer.length; i++) {
          if (buffer[i] === "{") depth++;
          else if (buffer[i] === "}") {
            depth--;
            if (depth === 0) { jsonEnd = i; break; }
          }
        }

        if (jsonEnd === -1) break; // Incomplete JSON, wait for more data

        const jsonStr = buffer.slice(jsonStart, jsonEnd + 1);
        searchFrom = jsonEnd + 1;

        try {
          const event = JSON.parse(jsonStr);
          if (event.delta?.text) {
            fullText += event.delta.text;
            onChunk(event.delta.text);
          } else if (event.contentBlockDelta?.delta?.text) {
            fullText += event.contentBlockDelta.delta.text;
            onChunk(event.contentBlockDelta.delta.text);
          }
        } catch {
          // Not valid JSON, skip
        }
      }

      // Keep unprocessed tail
      const lastBrace = buffer.lastIndexOf("}");
      if (lastBrace >= 0) {
        buffer = buffer.slice(lastBrace + 1);
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
