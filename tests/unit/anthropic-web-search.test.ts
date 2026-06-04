import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Native server-side web search on Anthropic complete(): the web_search_20250305
 * tool is attached only when webSearch is true; the response's
 * usage.server_tool_use.web_search_requests is surfaced as searchCount, and
 * citation/result URLs are collected (deduped) as sources. webSearch off must be
 * byte-identical to a non-grounded call.
 */

let capturedParams: Record<string, unknown> | undefined;

const SEARCH_FINAL = {
  content: [
    { type: "text", text: "I'll search." },
    { type: "server_tool_use", id: "srv1", name: "web_search", input: { query: "q" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srv1",
      content: [
        { type: "web_search_result", url: "https://en.wikipedia.org/wiki/X", title: "X - Wikipedia", page_age: "April 2025" },
      ],
    },
    {
      type: "text",
      text: "X was founded in 1916.",
      citations: [
        { type: "web_search_result_location", url: "https://en.wikipedia.org/wiki/X", title: "X - Wikipedia", cited_text: "X was founded..." },
        { type: "web_search_result_location", url: "https://other.example/y", title: "Y", cited_text: "..." },
      ],
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 2 } },
  stop_reason: "end_turn",
};

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: () => {
          throw new Error("create not implemented in mock — complete() must use stream");
        },
        stream: (params: Record<string, unknown>) => {
          capturedParams = params;
          return { finalMessage: async () => SEARCH_FINAL };
        },
      };
    },
  };
});

const { createAnthropicClient } = await import("../../src/lib/anthropic.js");

describe("anthropic complete() — native web search", () => {
  beforeEach(() => {
    capturedParams = undefined;
  });

  it("attaches the web_search_20250305 tool only when webSearch is true", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "Be brief." });
    await claude.complete("who founded X?", { webSearch: true });

    expect(capturedParams).toBeDefined();
    expect(capturedParams!.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 1 },
    ]);
  });

  it("does NOT attach tools when webSearch is off (byte-identical params)", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "Be brief." });
    await claude.complete("hello");

    expect(capturedParams).toBeDefined();
    expect(capturedParams!.tools).toBeUndefined();
  });

  it("surfaces searchCount from usage.server_tool_use.web_search_requests", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "Be brief." });
    const r = await claude.complete("who founded X?", { webSearch: true });
    expect(r.searchCount).toBe(2);
  });

  it("collects deduped sources from citations and web_search_tool_result blocks", async () => {
    const claude = createAnthropicClient({ apiKey: "test-key", systemPrompt: "Be brief." });
    const r = await claude.complete("who founded X?", { webSearch: true });
    expect(r.sources).toEqual([
      { url: "https://en.wikipedia.org/wiki/X", title: "X - Wikipedia" },
      { url: "https://other.example/y", title: "Y" },
    ]);
    // content is the concatenation of text blocks only
    expect(r.content).toBe("I'll search.X was founded in 1916.");
  });
});
