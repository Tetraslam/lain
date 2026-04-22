export { AnthropicProvider } from "./anthropic.js";
export { BedrockProvider } from "./bedrock.js";
export { createProvider } from "./factory.js";
export {
  buildGeneratePrompt,
  buildPlanPrompt,
  buildSynthesizePrompt,
  parseSynthesizeResponse,
} from "./prompts.js";

// Re-export from shared for backward compatibility
export {
  buildMergeGenerationPrompt,
  parseMergeGenerationResponse,
  type MergeGenerationRequest,
} from "@lain/shared";
