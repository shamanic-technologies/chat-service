import { describe, it, expect } from "vitest";
import { isStaffEmail, parseStaffRequestArgs, buildTelegramMessage, buildIssueBody } from "../../src/lib/staff-requests.js";
import type { StaffRequest } from "../../src/db/schema.js";
import { RETIRED_TOOL_NAMES, TOOL_REGISTRY, resolveToolSet } from "../../src/lib/anthropic.js";

const args = {
  kind: "feature",
  repo: "campaign-service",
  pieceKey: "linkedin-post-reaction-trigger",
  title: "Trigger on LinkedIn post reactions",
  userRequest: "each time someone reacts to my LinkedIn posts",
  missingPiece: "a trigger",
  decomposition: [{ piece: "qualify", outcome: "exists" }],
};

describe("isStaffEmail (same rule as billing-service)", () => {
  it.each([
    ["kevin@distribute.you", true],
    ["anyone@distribute.you", true],
    ["Kevin.Lourd+test@gmail.com", true],
    ["client@acme.com", false],
    [null, false],
  ])("%s → %s", (email, expected) => expect(isStaffEmail(email)).toBe(expected));
});

describe("parseStaffRequestArgs", () => {
  it("accepts a complete request", () => {
    expect(parseStaffRequestArgs(args).repo).toBe("campaign-service");
  });
  it("refuses a repo outside the fleet", () => {
    expect(() => parseStaffRequestArgs({ ...args, repo: "lead-service" })).toThrow(/not a fleet repo/);
  });
  it("refuses a non-kebab pieceKey", () => {
    expect(() => parseStaffRequestArgs({ ...args, pieceKey: "Some Thing" })).toThrow(/kebab-case/);
  });
  it("refuses an empty decomposition and a bad outcome", () => {
    expect(() => parseStaffRequestArgs({ ...args, decomposition: [] })).toThrow(/decomposition/);
    expect(() => parseStaffRequestArgs({ ...args, decomposition: [{ piece: "x", outcome: "maybe" }] })).toThrow(/outcome/);
  });
});

describe("messages", () => {
  const row = {
    id: "r-1", orgId: "o", userId: "u", brandId: null, sessionId: null, kind: "feature", repo: "campaign-service",
    pieceKey: "p", title: "<b>x</b>", userRequest: "a & b", decomposition: [{ piece: "a|b", outcome: "needs_code" }],
    missingPiece: "m", requesterIsStaff: false, issueUrl: null, issueNumber: null, issueError: "nope",
    telegramSentAt: null, telegramSkippedReason: null, telegramError: null, requestCount: 1,
    createdAt: new Date(), updatedAt: new Date(),
  } as StaffRequest;
  it("escapes user text in the Telegram HTML", () => {
    const m = buildTelegramMessage(row, "c@acme.com");
    expect(m).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(m).toContain("a &amp; b");
    expect(m).toContain("not opened (nope)");
  });
  it("puts the decomposition in the issue body as a table", () => {
    expect(buildIssueBody(row)).toContain("| a\\|b | needs_code |");
  });
});

describe("a new step or trigger is a feature request, never a bare row (owner 2026-10-15, C1)", () => {
  const gap = {
    kind: "trigger",
    name: "Contract signed",
    tool: "HubSpot",
    event: "deal moved to stage Signed",
    example: "Acme signed on 2026-10-14",
  };
  const req = { ...args, repo: "crm-service", pieceKey: undefined, title: "New trigger: Contract signed", newStepOrTrigger: gap };

  it("carries the name, the real event, the tool and an example into the issue text, keyed on the new piece", () => {
    const parsed = parseStaffRequestArgs(req);
    expect(parsed.kind).toBe("feature");
    expect(parsed.pieceKey).toBe("new-trigger-contract-signed");
    expect(parsed.missingPiece).toContain("Contract signed");
    expect(parsed.missingPiece).toContain("deal moved to stage Signed (in HubSpot)");
    expect(parsed.missingPiece).toContain("Acme signed on 2026-10-14");
    expect(parsed.missingPiece).toContain("No row was created");
  });

  it("refuses a missing field, an unknown kind, and a bug", () => {
    expect(() => parseStaffRequestArgs({ ...req, newStepOrTrigger: { ...gap, event: "" } })).toThrow(/newStepOrTrigger.event is required/);
    expect(() => parseStaffRequestArgs({ ...req, newStepOrTrigger: { ...gap, kind: "outcome" } })).toThrow(/kind must be one of step, trigger/);
    expect(() => parseStaffRequestArgs({ ...req, kind: "bug" })).toThrow(/feature/);
  });

  it("no tool the model can be given creates a step or a trigger", () => {
    for (const name of ["create_step", "declare_trigger_type"]) {
      expect(TOOL_REGISTRY[name], name).toBeUndefined();
      expect(RETIRED_TOOL_NAMES).toContain(name);
    }
    expect(resolveToolSet(["create_step", "declare_trigger_type", "request_staff", "create_pipe"]).map((t) => t.name)).toEqual([
      "request_staff",
      "create_pipe",
    ]);
    const props = (TOOL_REGISTRY.request_staff.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props.newStepOrTrigger).toBeDefined();
  });
});
