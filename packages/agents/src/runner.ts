// AgentRunner — the multi-step tool-use loop that sits on top of any
// AgentProvider's `converse` primitive.
//
// This is the heart of the agent substrate. A node is no longer a single
// completion: the model is given a toolbelt and runs until it produces a
// final answer (end_turn) or hits the step budget. The runner is generic —
// it knows nothing about the graph or corpus. Callers (in @lain/core) supply
// the tool specs and a `dispatch` function that actually executes a tool
// call. This keeps the dependency graph clean (agents -> shared only).

import type {
  AgentMessage,
  AgentProvider,
  AgentStepHandler,
  ContentBlock,
  StopReason,
  ToolResultBlock,
  ToolSpec,
  TokenUsage,
} from "@lain/shared";
import { collectText, collectToolUses } from "@lain/shared";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Result of executing one tool call. */
export interface ToolOutcome {
  content: ToolResultBlock[];
  isError?: boolean;
  /** Short human-readable summary for event streams / logs. */
  summary?: string;
}

export type ToolDispatch = (call: ToolCall) => Promise<ToolOutcome>;

export interface AgentRunOptions {
  provider: AgentProvider;
  system: string;
  /** Initial conversation (usually a single user message with the task). */
  messages: AgentMessage[];
  tools?: ToolSpec[];
  dispatch?: ToolDispatch;
  /** Maximum assistant turns before we force-stop. Default 12. */
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  onEvent?: AgentStepHandler;
  /** Optional AbortSignal to cancel an in-flight run between steps. */
  signal?: AbortSignal;
}

export interface AgentRunResult {
  /** Concatenated text of the final assistant turn. */
  text: string;
  /** Full transcript including tool calls/results. */
  messages: AgentMessage[];
  stopReason: StopReason;
  steps: number;
  usage: TokenUsage;
  toolCalls: number;
}

/**
 * Run an agent to completion. Drives the converse/tool loop until the model
 * stops requesting tools, the step budget is exhausted, or it's aborted.
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const maxSteps = opts.maxSteps ?? 12;
  const onEvent = opts.onEvent ?? (() => {});
  const messages: AgentMessage[] = opts.messages.map((m) => ({
    role: m.role,
    content: [...m.content],
  }));

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "unknown";
  let lastText = "";
  let toolCalls = 0;
  let steps = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) {
      stopReason = "unknown";
      break;
    }

    steps++;
    onEvent({ kind: "step", index: step, maxSteps });

    const result = await opts.provider.converse({
      system: opts.system,
      messages,
      tools: opts.tools,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
    });

    if (result.usage) {
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      onEvent({ kind: "usage", usage: result.usage });
    }

    stopReason = result.stopReason;
    messages.push({ role: "assistant", content: result.content });

    const text = collectText(result.content);
    if (text) {
      lastText = text;
      onEvent({ kind: "text", text });
    }

    const toolUses = collectToolUses(result.content);

    // Whenever the assistant emitted tool_use blocks we MUST reply with paired
    // tool_result blocks (the API rejects an unpaired tool_use), even if the
    // stop reason was something other than "tool_use" (e.g. max_tokens). If
    // there are no tool uses, the model is done with this turn.
    if (toolUses.length === 0) {
      break;
    }

    if (!opts.dispatch) {
      // Tools were requested but we can't run them; surface an error result.
      const errResults: ContentBlock[] = toolUses.map((tu) => ({
        type: "tool_result",
        toolUseId: tu.id,
        isError: true,
        content: [{ type: "text", text: "No tool dispatcher available." }],
      }));
      messages.push({ role: "user", content: errResults });
      continue;
    }

    // Execute all requested tool calls (sequentially for deterministic logs).
    const resultBlocks: ContentBlock[] = [];
    for (const tu of toolUses) {
      toolCalls++;
      onEvent({ kind: "tool_call", id: tu.id, name: tu.name, input: tu.input });
      let outcome: ToolOutcome;
      try {
        outcome = await opts.dispatch({ id: tu.id, name: tu.name, input: tu.input });
      } catch (err) {
        outcome = {
          content: [{ type: "text", text: `Tool "${tu.name}" threw: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
      onEvent({
        kind: "tool_result",
        id: tu.id,
        name: tu.name,
        summary: outcome.summary ?? summarize(outcome.content),
        isError: outcome.isError ?? false,
      });
      resultBlocks.push({
        type: "tool_result",
        toolUseId: tu.id,
        content: outcome.content,
        isError: outcome.isError,
      });
    }

    messages.push({ role: "user", content: resultBlocks });
  }

  onEvent({ kind: "done", reason: stopReason });

  return { text: lastText, messages, stopReason, steps, usage, toolCalls };
}

function summarize(content: ToolResultBlock[]): string {
  const text = content
    .map((c) => (c.type === "text" ? c.text : "[image]"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 120 ? text.slice(0, 117) + "..." : text;
}
