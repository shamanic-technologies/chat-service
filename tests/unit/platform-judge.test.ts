import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  resolvePlatformKey: vi.fn(),
  createPlatformRun: vi.fn(),
  addPlatformRunCosts: vi.fn(),
  updatePlatformRunStatus: vi.fn(),
  judgeWithTypeSafe: vi.fn(),
}));
vi.mock("../../src/lib/key-client.js", () => ({ resolvePlatformKey: m.resolvePlatformKey }));
vi.mock("../../src/lib/runs-client.js", () => ({
  createPlatformRun: m.createPlatformRun,
  addPlatformRunCosts: m.addPlatformRunCosts,
  updatePlatformRunStatus: m.updatePlatformRunStatus,
}));
vi.mock("../../src/lib/typesafe.js", async (orig) => ({ ...(await orig<object>()), judgeWithTypeSafe: m.judgeWithTypeSafe }));

import { judgeOnPlatform } from "../../src/lib/platform-judge.js";
import { TYPESAFE_INPUT_TOKENS_COST_NAME } from "../../src/lib/cost-names.js";
import { COPILOT_SUPPORT } from "../../src/lib/support-marks.js";

const Q = { kept: { type: "noul" as const, instructions: "?" } };

describe("judgeOnPlatform", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.resolvePlatformKey.mockResolvedValue({ provider: "typesafe", key: "k" });
    m.createPlatformRun.mockResolvedValue({ id: "run-1" });
    m.addPlatformRunCosts.mockResolvedValue([]);
    m.updatePlatformRunStatus.mockResolvedValue({});
  });

  it("declares the input tokens on a platform run and returns the answers verbatim", async () => {
    m.judgeWithTypeSafe.mockResolvedValue({ model: "jev-1.13.0", answers: { kept: { type: "noul", noul: 0.9 } }, inputTokens: 321, outputTokens: 4 });
    expect(await judgeOnPlatform("t", { a: 1 }, Q, COPILOT_SUPPORT)).toEqual({ kept: { type: "noul", noul: 0.9 } });
    expect(m.addPlatformRunCosts).toHaveBeenCalledWith("run-1", "chat-service", [
      { costName: TYPESAFE_INPUT_TOKENS_COST_NAME, quantity: 321, costSource: "platform" },
    ]);
    expect(m.updatePlatformRunStatus).toHaveBeenCalledWith("run-1", "chat-service", "completed");
  });

  it("creates its platform run with the support mark the caller states", async () => {
    m.judgeWithTypeSafe.mockResolvedValue({ model: "jev-1.13.0", answers: {}, inputTokens: 1, outputTokens: 0 });
    await judgeOnPlatform("copilot-followup-already-kept", {}, Q, COPILOT_SUPPORT);
    expect(m.createPlatformRun).toHaveBeenCalledWith({
      serviceName: "chat-service",
      taskName: "copilot-followup-already-kept",
      support: { kind: "copilot", reason: expect.any(String) },
    });
  });

  it("a failed judgment throws and closes the run failed", async () => {
    m.judgeWithTypeSafe.mockRejectedValue(new Error("vendor down"));
    await expect(judgeOnPlatform("t", {}, Q, COPILOT_SUPPORT)).rejects.toThrow("vendor down");
    expect(m.addPlatformRunCosts).not.toHaveBeenCalled();
    expect(m.updatePlatformRunStatus).toHaveBeenCalledWith("run-1", "chat-service", "failed");
  });
});
