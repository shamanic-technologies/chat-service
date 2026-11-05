import { describe, it, expect } from "vitest";
import { cutKeepingNewest } from "../../src/agent/tool-result-cut.js";
import { answerForModel } from "../../src/agent/catalogue-tools.js";

// SOPHIE-TRUTH-1105, prod 2026-11-04 (Beyond Logic): a conversation read, oldest first, was cut
// from its START, so our three answers to Edmund were the part dropped, and Sophie told the
// client three times nobody had answered him.
const conversation = {
  campaignId: "c1",
  messages: [
    { direction: "inbound", timestamp: "2026-11-01T09:00:00Z", text: `Interested, tell me more. ${"x".repeat(900)}` },
    ...[2, 3, 4].map((d) => ({ direction: "outbound", timestamp: `2026-11-0${d}T09:00:00Z`, text: `Our answer ${d}. ${"y".repeat(900)}` })),
  ],
};

describe("a tool answer too big is cut keeping its newest part, and says so", () => {
  it("keeps the newest messages of an oldest-first conversation (the fix: our last answer survives)", () => {
    const out = cutKeepingNewest(conversation, 2_500) as Record<string, unknown>;
    expect(out.cut).toBe(true);
    const kept = out.messages as Array<{ timestamp: string; direction: string }>;
    expect(kept.length).toBeLessThan(4);
    expect(kept.at(-1)!.timestamp).toBe("2026-11-04T09:00:00Z");
    expect(kept.every((m) => m.direction === "outbound")).toBe(true);
    // served order kept
    expect(kept.map((m) => m.timestamp)).toEqual([...kept.map((m) => m.timestamp)].sort());
    expect(out.note).toMatch(/was cut.*newest \(by timestamp\).*Never read an item missing here as absent/);
    expect(out.campaignId).toBe("c1");
  });

  it("keeps the newest when served newest first, too", () => {
    const desc = { messages: [...conversation.messages].reverse() };
    const kept = (cutKeepingNewest(desc, 2_500) as { messages: Array<{ timestamp: string }> }).messages;
    expect(kept[0].timestamp).toBe("2026-11-04T09:00:00Z");
  });

  it("an answer that fits is untouched", () => {
    expect(cutKeepingNewest(conversation, 100_000)).toBe(conversation);
  });

  it("a top-level list is cut the same way and still says so", () => {
    const out = cutKeepingNewest(conversation.messages, 2_500) as { cut: boolean; items: unknown[]; of: number };
    expect(out.cut).toBe(true);
    expect(out.of).toBe(4);
    expect(out.items.length).toBeGreaterThan(0);
  });

  it("an answer with no list is cut to its first characters and says so", () => {
    const out = cutKeepingNewest({ text: "z".repeat(5_000) }, 1_000) as { cut: boolean; firstChars: string; note: string };
    expect(out.cut).toBe(true);
    expect(out.firstChars.length).toBe(1_000);
    expect(out.note).toMatch(/was cut/);
  });
});

describe("run_operation names a filter the operation does not document (Neil never replied)", () => {
  const op = { params: [{ name: "brandId", in: "query" }, { name: "limit", in: "query" }, { name: "id", in: "path" }] } as never;

  it("flags replyClassification, the filter lead-service ignored", () => {
    const out = answerForModel(op, { brandId: "b", replyClassification: "positive" }, 200, { leads: [] });
    expect(out.filtersNotDocumented).toMatchObject({ names: ["replyClassification"] });
    expect((out.filtersNotDocumented as { note: string }).note).toMatch(/may not be filtered by it/);
  });

  it("says nothing when every filter is documented", () => {
    expect(answerForModel(op, { brandId: "b", limit: "5" }, 200, { leads: [] })).not.toHaveProperty("filtersNotDocumented");
  });
});
