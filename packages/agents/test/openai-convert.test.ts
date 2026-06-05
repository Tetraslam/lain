import { describe, it, expect } from "vitest";
import {
  toOpenAIMessages,
  toOpenAITools,
  fromOpenAIMessage,
  mapOpenAIStop,
} from "../src/openai-convert.js";
import type { AgentMessage } from "@lain/shared";

describe("toOpenAIMessages", () => {
  it("prepends the system message", () => {
    const msgs = toOpenAIMessages("be helpful", [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(msgs[0]).toEqual({ role: "system", content: "be helpful" });
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
  });

  it("maps assistant tool_use into tool_calls with stringified args", () => {
    const msgs = toOpenAIMessages("", [
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_use", id: "t1", name: "search", input: { q: "x" } },
        ],
      },
    ]);
    const assistant = msgs[0];
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls?.[0]).toEqual({
      id: "t1",
      type: "function",
      function: { name: "search", arguments: '{"q":"x"}' },
    });
  });

  it("maps tool_result blocks into role:tool messages", () => {
    const msgs = toOpenAIMessages("", [
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "result!" }] },
        ],
      },
    ]);
    expect(msgs[0]).toEqual({ role: "tool", tool_call_id: "t1", content: "result!" });
  });

  it("emits multimodal image parts as data urls", () => {
    const msg: AgentMessage = {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", format: "png", data: "AAAA" },
      ],
    };
    const msgs = toOpenAIMessages("", [msg]);
    const parts = msgs[0].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts[0]).toEqual({ type: "text", text: "look" });
    expect(parts[1].image_url?.url).toBe("data:image/png;base64,AAAA");
  });
});

describe("toOpenAITools", () => {
  it("wraps specs as function tools", () => {
    const tools = toOpenAITools([
      { name: "f", description: "d", inputSchema: { type: "object" } },
    ]) as Array<{ type: string; function: { name: string } }>;
    expect(tools[0].type).toBe("function");
    expect(tools[0].function.name).toBe("f");
  });
});

describe("fromOpenAIMessage", () => {
  it("extracts text and parsed tool calls", () => {
    const blocks = fromOpenAIMessage({
      content: "hello",
      tool_calls: [{ id: "c1", type: "function", function: { name: "go", arguments: '{"a":1}' } }],
    });
    expect(blocks[0]).toEqual({ type: "text", text: "hello" });
    expect(blocks[1]).toEqual({ type: "tool_use", id: "c1", name: "go", input: { a: 1 } });
  });

  it("tolerates malformed tool-call json", () => {
    const blocks = fromOpenAIMessage({
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "go", arguments: "{bad" } }],
    });
    expect(blocks[0].type).toBe("tool_use");
  });
});

describe("mapOpenAIStop", () => {
  it("maps finish reasons", () => {
    expect(mapOpenAIStop("stop")).toBe("end_turn");
    expect(mapOpenAIStop("tool_calls")).toBe("tool_use");
    expect(mapOpenAIStop("length")).toBe("max_tokens");
  });
});
