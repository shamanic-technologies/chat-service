import { describe, expect, it } from "vitest";
import { messageVerdict } from "../../src/lib/delivery-truth.js";

// CHAT-TRUTH-1101: the Copilot said "I've just emailed you" on an event whose
// outcome was `ran` and delivery null; nothing left. `sent` only on delivered.
describe("messageVerdict: did the message leave?", () => {
  it("sent only when campaign-service says delivered", () => {
    expect(messageVerdict({ status: "done", outcome: "ran", delivery: { state: "delivered", refusals: [] } })).toMatchObject({ messageState: "sent", sent: true });
  });

  it("a run that started is on its way, not sent", () => {
    for (const delivery of [null, { state: "in_flight" }, { state: "owed" }, { state: "unconfirmed" }]) {
      expect(messageVerdict({ status: "done", outcome: "ran", delivery })).toMatchObject({ messageState: "on_its_way", sent: false });
    }
  });

  it("pending or still firing is on its way", () => {
    expect(messageVerdict({ status: "pending", outcome: null, delivery: null })).toMatchObject({ messageState: "on_its_way", why: "due later" });
    expect(messageVerdict({ status: "firing", outcome: null, delivery: null })).toMatchObject({ messageState: "on_its_way" });
  });

  it("skipped, failed or refused is not sent, with the served reason", () => {
    expect(messageVerdict({ status: "done", outcome: "skipped", skipReason: "cohort_run_in_flight", delivery: null })).toMatchObject({ messageState: "not_sent", why: "cohort_run_in_flight" });
    expect(messageVerdict({ status: "done", outcome: "refused", skipReason: null, delivery: { state: "refused", refusals: [{ code: "bounced", reason: "address bounced" }] } })).toMatchObject({ messageState: "not_sent", why: "address bounced" });
    expect(messageVerdict({ status: "done", outcome: "failed", lastError: "timeout", delivery: { state: "failed" } })).toMatchObject({ messageState: "not_sent", why: "timeout" });
  });

  it("an unknown or missing event never reads as sent", () => {
    expect(messageVerdict(undefined).sent).toBe(false);
    expect(messageVerdict({ status: "done", outcome: "something_new", delivery: null }).sent).toBe(false);
  });
});
