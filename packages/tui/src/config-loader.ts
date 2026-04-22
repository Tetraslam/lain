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
  switch (provider) {
    case "anthropic":
      return createProvider({
        provider: "anthropic",
        model: config.defaultModel,
        apiKey: credentials.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY,
      });
    case "bedrock":
      return createProvider({
        provider: "bedrock",
        model: config.defaultModel,
        apiKey: credentials.bedrock?.apiKey || process.env.AWS_BEARER_TOKEN_BEDROCK,
        region: credentials.bedrock?.region || process.env.AWS_REGION || "us-west-2",
      });
    case "openai":
      return createProvider({
        provider: "openai",
        model: config.defaultModel,
        apiKey: credentials.openai?.apiKey || process.env.OPENAI_API_KEY,
      });
    default:
      return createProvider({ provider, model: config.defaultModel });
  }
}
