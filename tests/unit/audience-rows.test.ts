import { describe, it, expect } from "vitest";
import { AUDIENCE_PAGE_SIZE, toAudienceRows, type Audience } from "../../src/lib/audience-client.js";

// Shaped like the 26 audiences list_audiences returned in prod on 2026-10-12
// (~4.3 KB each: filters, nlPrompt, targetText, channels, description).
function prodLikeAudience(i: number): Audience {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    orgId: "7dacdda1-b719-45ea-9bfe-94cb46d0967d",
    brandId: "9febcbd7-0fc2-4e77-8c27-a838d4b442b1",
    offerId: "f63f7b54-d5c6-4f4b-bae7-fefc4400cf27",
    name: `Switzerland (Engaged with competitor posts) ${i}`,
    nlPrompt: "Heads of Learning & Development ".repeat(27),
    targetText: "Heads of Learning & Development, Talent Development and Leadership Development ".repeat(11),
    provider: "apollo",
    status: i % 2 ? "active" : "paused",
    source: "linkedin_engagement_signal",
    filters: { person_titles: Array.from({ length: 60 }, (_, k) => `Title number ${k}`) },
    avatarUrl: null,
    apolloCount: i === 0 ? null : 1000 + i,
    apifyCount: null,
    countedAt: null,
    createdByUserId: "cfe148ed-e3d8-40a2-8920-f8c040a81934",
    createdAt: "2026-10-12T10:23:30.975Z",
    updatedAt: "2026-10-12T10:23:30.975Z",
    channels: [{ channel: "cold_email" }, { channel: "cold_email" }],
  };
}

const PROD = Array.from({ length: 26 }, (_, i) => prodLikeAudience(i));

describe("toAudienceRows (what the chat model reads from list_audiences)", () => {
  it("fits the whole first page under ~2k tokens, where the raw list weighed 80 KB+ (111 KB in prod)", () => {
    expect(JSON.stringify({ audiences: PROD }).length).toBeGreaterThan(80_000);
    const page = toAudienceRows(PROD, 0);
    expect(page.audiences).toHaveLength(AUDIENCE_PAGE_SIZE);
    expect(JSON.stringify(page).length).toBeLessThan(8_000);
  });

  it("keeps what the model acts on and drops the heavy fields", () => {
    const row = toAudienceRows(PROD, 0).audiences[1];
    expect(row).toEqual({
      id: PROD[1].id,
      name: PROD[1].name,
      status: "active",
      offerId: PROD[1].offerId,
      size: 1001,
      channels: ["cold_email"],
      target: expect.stringMatching(/^Heads of Learning & Development, Talent.*…$/),
    });
    expect(row.target!.length).toBeLessThanOrEqual(121);
  });

  it("pages with nextOffset and ends with null", () => {
    const first = toAudienceRows(PROD, 0);
    expect(first.total).toBe(26);
    expect(first.nextOffset).toBe(15);
    const second = toAudienceRows(PROD, 15);
    expect(second.audiences.map((a) => a.id)).toEqual(PROD.slice(15).map((a) => a.id));
    expect(second.nextOffset).toBeNull();
  });

  it("falls back to the nlPrompt when no targetText is served, and to null when neither is", () => {
    const [a] = toAudienceRows([{ ...PROD[0], targetText: null, nlPrompt: "Founders in France" }], 0).audiences;
    expect(a.target).toBe("Founders in France");
    const [b] = toAudienceRows([{ ...PROD[0], targetText: null, nlPrompt: null }], 0).audiences;
    expect(b.target).toBeNull();
  });

  it("refuses an offset that is not a whole number >= 0", () => {
    expect(() => toAudienceRows(PROD, -1)).toThrow(/offset/);
    expect(() => toAudienceRows(PROD, Number.NaN)).toThrow(/offset/);
  });
});
