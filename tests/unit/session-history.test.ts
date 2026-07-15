import { describe, it, expect } from "vitest";
import { serializeSessionHistory } from "../../src/lib/session-history.js";
import type { Session, Message } from "../../src/db/schema.js";

const baseSession: Session = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  orgId: "org-1",
  userId: "user-1",
  runId: null,
  parentRunId: null,
  campaignId: null,
  brandIds: null,
  workflowSlug: null,
  featureSlug: null,
  audienceId: null,
  createdAt: new Date("2026-07-16T10:00:00.000Z"),
  updatedAt: new Date("2026-07-16T10:05:00.000Z"),
};

function msg(overrides: Partial<Message>): Message {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    sessionId: baseSession.id,
    role: "user",
    content: "",
    contentBlocks: null,
    toolCalls: null,
    buttons: null,
    tokenCount: null,
    createdAt: new Date("2026-07-16T10:00:01.000Z"),
    ...overrides,
  };
}

describe("serializeSessionHistory", () => {
  it("maps session metadata and ISO timestamps", () => {
    const out = serializeSessionHistory(baseSession, []);
    expect(out.sessionId).toBe(baseSession.id);
    expect(out.orgId).toBe("org-1");
    expect(out.createdAt).toBe("2026-07-16T10:00:00.000Z");
    expect(out.updatedAt).toBe("2026-07-16T10:05:00.000Z");
    expect(out.messages).toEqual([]);
    expect(out.campaignId).toBeNull();
    expect(out.brandIds).toBeNull();
  });

  it("preserves message order and shape (user + assistant turns)", () => {
    const out = serializeSessionHistory(baseSession, [
      msg({ id: "m1", role: "user", content: "hi", createdAt: new Date("2026-07-16T10:00:01.000Z") }),
      msg({
        id: "m2",
        role: "assistant",
        content: "hello there",
        tokenCount: 42,
        createdAt: new Date("2026-07-16T10:00:02.000Z"),
      }),
    ]);
    expect(out.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(out.messages[0]).toMatchObject({ role: "user", content: "hi", tokenCount: null });
    expect(out.messages[1]).toMatchObject({ role: "assistant", content: "hello there", tokenCount: 42 });
    expect(out.messages[0].createdAt).toBe("2026-07-16T10:00:01.000Z");
  });

  it("surfaces tool calls as name + args + result", () => {
    const out = serializeSessionHistory(baseSession, [
      msg({
        id: "m1",
        role: "assistant",
        content: "",
        toolCalls: [
          { name: "list_workflows", args: { limit: 10 }, result: { workflows: ["a", "b"] } },
        ],
      }),
    ]);
    expect(out.messages[0].toolCalls).toEqual([
      { name: "list_workflows", args: { limit: 10 }, result: { workflows: ["a", "b"] } },
    ]);
  });

  it("omits result for a tool call that has none (paused turn)", () => {
    const out = serializeSessionHistory(baseSession, [
      msg({
        id: "m1",
        role: "assistant",
        toolCalls: [{ name: "request_user_input", args: { field: "brand_url" } }],
      }),
    ]);
    const tc = out.messages[0].toolCalls![0];
    expect(tc).toEqual({ name: "request_user_input", args: { field: "brand_url" } });
    expect("result" in tc).toBe(false);
  });

  it("drops the internal Gemini thoughtSignature from tool calls", () => {
    const out = serializeSessionHistory(baseSession, [
      msg({
        id: "m1",
        role: "assistant",
        toolCalls: [
          { name: "get_workflow_details", args: {}, result: { ok: true }, thoughtSignature: "abc123" },
        ],
      }),
    ]);
    expect(out.messages[0].toolCalls![0]).not.toHaveProperty("thoughtSignature");
  });

  it("passes through provider content blocks (reasoning) and buttons", () => {
    const blocks = [
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "answer" },
    ];
    const out = serializeSessionHistory(baseSession, [
      msg({
        id: "m1",
        role: "assistant",
        content: "answer",
        contentBlocks: blocks,
        buttons: [{ label: "Yes", value: "yes" }],
      }),
    ]);
    expect(out.messages[0].contentBlocks).toEqual(blocks);
    expect(out.messages[0].buttons).toEqual([{ label: "Yes", value: "yes" }]);
  });

  it("carries session tracking metadata when present", () => {
    const out = serializeSessionHistory(
      {
        ...baseSession,
        campaignId: "camp-1",
        brandIds: ["brand-1", "brand-2"],
        workflowSlug: "cold-email-v3",
        featureSlug: "feat-1",
        audienceId: "aud-1",
      },
      [],
    );
    expect(out).toMatchObject({
      campaignId: "camp-1",
      brandIds: ["brand-1", "brand-2"],
      workflowSlug: "cold-email-v3",
      featureSlug: "feat-1",
      audienceId: "aud-1",
    });
  });
});
