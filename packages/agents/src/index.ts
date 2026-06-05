export { AnthropicProvider } from "./anthropic.js";
export { BedrockProvider } from "./bedrock.js";
export { createProvider } from "./factory.js";
export {
  runAgent,
  type AgentRunOptions,
  type AgentRunResult,
  type ToolCall,
  type ToolOutcome,
  type ToolDispatch,
} from "./runner.js";
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
