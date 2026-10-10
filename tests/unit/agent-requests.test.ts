import { describe, it, expect } from "vitest";
import {
  parseStaffRequestArgs,
  parseSkillUpgradeArgs,
  parseContactHumanArgs,
  buildTelegramMessage,
  buildIssueBody,
  pieceKeyOf,
} from "../../src/lib/staff-requests.js";
import type { StaffRequest } from "../../src/db/schema.js";

describe("request_staff has no friction", () => {
  it("pieceKey and decomposition are optional (pieceKey from the title)", () => {
    const r = parseStaffRequestArgs({
      kind: "bug",
      repo: "features-service",
      title: "Catalogue: no LinkedIn pipes!",
      userRequest: "post on LinkedIn every day",
      missingPiece: "find_pipes returns nothing for LinkedIn posting",
    });
    expect(r.pieceKey).toBe("catalogue-no-linkedin-pipes");
    expect(r.decomposition).toEqual([]);
  });
});

describe("request_skill_upgrade", () => {
  it("a skill goes to chat-service with the proposed text", () => {
    const r = parseSkillUpgradeArgs({ skillSlug: "catalogue-pipes", title: "Explain draft pipes", problem: "I did not know", proposedChange: "Add: a draft pipe..." });
    expect(r).toMatchObject({ kind: "skill_upgrade", repo: "chat-service", skillSlug: "catalogue-pipes" });
    expect(r.pieceKey).toBe("skill-catalogue-pipes-explain-draft-pipes");
    expect(r.missingPiece).toContain("Add: a draft pipe...");
  });
  it("a service doc goes to that service's repo", () => {
    const r = parseSkillUpgradeArgs({ repo: "features-service", title: "Doc", problem: "p", proposedChange: "c" });
    expect(r.repo).toBe("features-service");
  });
  it("needs exactly one target, a fleet repo, and the proposed text", () => {
    expect(() => parseSkillUpgradeArgs({ title: "t", problem: "p", proposedChange: "c" })).toThrow(/skillSlug.*or repo/);
    expect(() => parseSkillUpgradeArgs({ skillSlug: "a", repo: "chat-service", title: "t", problem: "p", proposedChange: "c" })).toThrow(/not both/);
    expect(() => parseSkillUpgradeArgs({ repo: "nope", title: "t", problem: "p", proposedChange: "c" })).toThrow(/not a fleet repo/);
    expect(() => parseSkillUpgradeArgs({ skillSlug: "a", title: "t", problem: "p" })).toThrow(/proposedChange/);
  });
});

describe("contact_human", () => {
  it("has no repo (no issue) and keeps the user's message", () => {
    const r = parseContactHumanArgs({ reason: "Wants to talk pricing", message: "Can someone call me?", urgency: "urgent" });
    expect(r).toMatchObject({ kind: "contact_human", repo: null, title: "Wants to talk pricing", userRequest: "Can someone call me?", urgency: "urgent" });
    expect(r.missingPiece).toContain("URGENT");
  });
  it("defaults to normal urgency and refuses an unknown one", () => {
    expect(parseContactHumanArgs({ reason: "r", message: "m" }).urgency).toBe("normal");
    expect(() => parseContactHumanArgs({ reason: "r", message: "m", urgency: "asap" })).toThrow(/urgency/);
  });
});

describe("pieceKeyOf", () => {
  it("kebab-cases and caps at 80", () => {
    expect(pieceKeyOf("Hello, World!")).toBe("hello-world");
    expect(pieceKeyOf("a".repeat(100)).length).toBe(80);
    expect(() => pieceKeyOf("!!!")).toThrow();
  });
});

describe("messages per kind", () => {
  const base = {
    id: "r-1", orgId: "o", userId: "u", brandId: "b", sessionId: "s-1", pieceKey: "p", decomposition: [],
    requesterIsStaff: false, issueUrl: null, issueNumber: null, issueError: null, telegramSentAt: null,
    telegramSkippedReason: null, telegramError: null, requestCount: 1, createdAt: new Date(), updatedAt: new Date(),
  };
  it("contact_human: the founder reads who, what, and the session", () => {
    const row = { ...base, kind: "contact_human", repo: null, title: "Pricing <call>", userRequest: "Call me", missingPiece: "The user asked to talk to a person (URGENT)." } as StaffRequest;
    const m = buildTelegramMessage(row, "client@acme.com");
    expect(m).toContain("asks for a human");
    expect(m).toContain("URGENT");
    expect(m).toContain("Pricing &lt;call&gt;");
    expect(m).toContain("client@acme.com");
    expect(m).toContain("s-1");
    expect(m).not.toContain("Issue:");
  });
  it("skill_upgrade: labelled, and the issue body has the upgrade without an empty table", () => {
    const row = { ...base, kind: "skill_upgrade", repo: "chat-service", title: "t", userRequest: "u", missingPiece: "Upgrade skill `x`." } as StaffRequest;
    expect(buildTelegramMessage(row, null)).toContain("skill/doc upgrade");
    const body = buildIssueBody(row);
    expect(body).toContain("## Upgrade");
    expect(body).not.toContain("| Piece |");
  });
});
