import type { AgentProvider, Provider } from "@lain/shared";
import { AnthropicProvider } from "./anthropic.js";
import { BedrockProvider } from "./bedrock.js";
import { OpenAIProvider } from "./openai.js";

export interface CreateProviderOptions {
  provider: Provider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  region?: string;     // for bedrock
  maxTokens?: number;
}

/**
 * Factory function to create an agent provider from config.
 */
export function createProvider(options: CreateProviderOptions): AgentProvider {
  switch (options.provider) {
    case "anthropic":
      return new AnthropicProvider({
        apiKey: options.apiKey,
        model: options.model,
        maxTokens: options.maxTokens,
      });

    case "bedrock":
      if (!options.apiKey) {
        throw new Error(
          "Bedrock requires an API key. Run `lain init` to configure credentials, " +
          "or set the AWS_BEARER_TOKEN_BEDROCK environment variable."
        );
      }
      return new BedrockProvider({
        apiKey: options.apiKey,
        region: options.region ?? "us-west-2",
        model: options.model,
        maxTokens: options.maxTokens,
      });

    case "openai":
      return new OpenAIProvider({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        model: options.model ?? "gpt-4o",
        maxTokens: options.maxTokens,
        label: "openai",
      });

    case "openrouter":
      return new OpenAIProvider({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1",
        model: options.model ?? "anthropic/claude-sonnet-4.5",
        maxTokens: options.maxTokens,
        label: "openrouter",
        headers: {
          "HTTP-Referer": "https://cli.devin.ai",
          "X-Title": "lain",
        },
      });

    default:
      throw new Error(`Unknown provider: ${options.provider}`);
  }
}
