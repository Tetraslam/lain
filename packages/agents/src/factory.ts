import type { AgentProvider, Provider } from "@lain/shared";
import { AnthropicProvider } from "./anthropic.js";
import { BedrockProvider } from "./bedrock.js";

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
      throw new Error(
        "OpenAI provider not yet implemented. Use 'anthropic' or 'bedrock'."
      );

    default:
      throw new Error(`Unknown provider: ${options.provider}`);
  }
}
