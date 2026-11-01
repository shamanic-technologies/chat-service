import { describe, expect, it } from "vitest";
import { TOOL_REGISTRY } from "../../src/lib/anthropic.js";
import { staffRequestResultForModel, type StaffRequestResult } from "../../src/lib/staff-requests.js";

// CHAT-TRUTH-1101 (prod 2026-11-01): the tool result said "Telegram to the team
// (the owner reads it on his phone)" and the Copilot told a client "it goes to
// the founder on Telegram". The model reads WHO has it, never HOW it got there.
describe("a filed request, as the Copilot reads it", () => {
  const filed: StaffRequestResult = {
    requestId: "r-1",
    kind: "contact_human",
    destination: "a person on the distribute.you team, notified now",
    duplicate: false,
    requestCount: 1,
    issueUrl: null,
    issueError: null,
    staffPinged: true,
    telegramSkippedReason: null,
    telegramError: "telegram 500: down",
  } as StaffRequestResult;

  it("never names the app or the person it reached", () => {
    const out = staffRequestResultForModel(filed);
    expect(out).toEqual({
      requestId: "r-1",
      kind: "contact_human",
      destination: "a person on the distribute.you team, notified now",
      duplicate: false,
      requestCount: 1,
      issueUrl: null,
      issueError: null,
      teamNotified: true,
    });
    expect(JSON.stringify(out)).not.toMatch(/telegram|founder|phone/i);
  });

  it("the request tools' descriptions do not either", () => {
    for (const t of ["contact_human", "request_staff"]) {
      expect(TOOL_REGISTRY[t].description ?? "").not.toMatch(/telegram|founder/i);
    }
  });
});
