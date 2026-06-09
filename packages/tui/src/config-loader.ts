/**
 * TUI config loader — re-exports from @lain/shared config module
 * plus a convenience function for creating an agent provider.
 */
import { createProvider } from "@lain/agents";
import { loadConfig as _loadConfig, loadCredentials as _loadCredentials, type Credentials } from "@lain/shared";
import type { LainConfig, AgentProvider } from "@lain/shared";

export { loadConfig, loadCredentials } from "@lain/shared";

export function createProviderFromCredentials(config: LainConfig, credentials: Credentials): AgentProvider {
  const provider = config.defaultProvider;
  const maxTokens = config.maxTokens;
  switch (provider) {
    case "anthropic":
      return createProvider({
        provider: "anthropic",
        model: config.defaultModel,
        apiKey: credentials.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY,
        maxTokens,
      });
    case "bedrock":
      return createProvider({
        provider: "bedrock",
        model: config.defaultModel,
        apiKey: credentials.bedrock?.apiKey || process.env.AWS_BEARER_TOKEN_BEDROCK,
        region: credentials.bedrock?.region || process.env.AWS_REGION || "us-west-2",
        maxTokens,
      });
    case "openai":
      return createProvider({
        provider: "openai",
        model: config.defaultModel,
        apiKey: credentials.openai?.apiKey || process.env.OPENAI_API_KEY,
        baseUrl: credentials.openai?.baseUrl || process.env.OPENAI_BASE_URL,
        maxTokens,
      });
    case "openrouter":
      return createProvider({
        provider: "openrouter",
        model: config.defaultModel,
        apiKey: credentials.openrouter?.apiKey || process.env.OPENROUTER_API_KEY,
        baseUrl: credentials.openrouter?.baseUrl,
        maxTokens,
      });
    default:
      return createProvider({ provider, model: config.defaultModel, maxTokens });
  }
}
