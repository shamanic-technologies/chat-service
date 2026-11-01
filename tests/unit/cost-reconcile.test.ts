import { describe, it, expect, vi } from "vitest";
import { isUnwrittenCostRefusal, reconcileProvisionedCosts } from "../../src/lib/cost-reconcile.js";

/**
 * Prod 2026-11-01 (CHAT-COST-1101): costs-service answered 500 for a few
 * seconds, the actual post failed once, and six Copilot turns stayed billed at
 * their hold ($2.46) instead of their real cost.
 */
const UNWRITTEN = new Error(
  '[runs-client] POST /v1/runs/r1/costs returned 502: {"error":"costs-service unavailable: costs-service returned 500: {\\"error\\":\\"Internal server error\\"}"}',
);
const noSleep = async () => {};

describe("reconcileProvisionedCosts", () => {
  it("retries the actual post when runs-service says nothing was written, then releases the holds", async () => {
    const postActual = vi.fn().mockRejectedValueOnce(UNWRITTEN).mockRejectedValueOnce(UNWRITTEN).mockResolvedValue([]);
    const releaseHolds = vi.fn().mockResolvedValue(undefined);
    await reconcileProvisionedCosts({ postActual, releaseHolds, sleep: noSleep });
    expect(postActual).toHaveBeenCalledTimes(3);
    expect(releaseHolds).toHaveBeenCalledTimes(1);
  });

  it("never re-posts on another failure (the lines may be stored: a second post bills twice)", async () => {
    const other = new Error("[runs-client] POST /v1/runs/r1/costs returned 500: boom");
    const postActual = vi.fn().mockRejectedValue(other);
    const releaseHolds = vi.fn();
    await expect(reconcileProvisionedCosts({ postActual, releaseHolds, sleep: noSleep })).rejects.toBe(other);
    expect(postActual).toHaveBeenCalledTimes(1);
    expect(releaseHolds).not.toHaveBeenCalled();
  });

  it("keeps the hold (throws) once the retry budget is spent", async () => {
    const postActual = vi.fn().mockRejectedValue(UNWRITTEN);
    const releaseHolds = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(reconcileProvisionedCosts({ postActual, releaseHolds, sleep, delaysMs: [1, 2] })).rejects.toBe(UNWRITTEN);
    expect(postActual).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(releaseHolds).not.toHaveBeenCalled();
  });

  it("recognises only the unwritten refusal", () => {
    expect(isUnwrittenCostRefusal(UNWRITTEN)).toBe(true);
    expect(isUnwrittenCostRefusal(new Error("returned 422: unknown cost name"))).toBe(false);
  });
});
