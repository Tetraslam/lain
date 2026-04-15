import type { AgentProvider, Provider } from "@lain/shared";
import { AnthropicProvider } from "./anthropic.js";
import type { AnthropicProviderOptions } from "./anthropic.js";

export interface CreateProviderOptions {
  provider: Provider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  region?: string;
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
      // Bedrock uses the Anthropic SDK with bedrock-specific config
      // The @anthropic-ai/sdk supports bedrock natively via AnthropicBedrock
      return new AnthropicProvider({
        apiKey: options.apiKey,
        model: options.model ?? "claude-sonnet-4-20250514",
        maxTokens: options.maxTokens,
      });

    case "openai":
      // For v0.1, throw — openai support comes in v0.2
      throw new Error(
        "OpenAI provider not yet implemented. Use 'anthropic' or 'bedrock'."
      );

    default:
      throw new Error(`Unknown provider: ${options.provider}`);
  }
}
