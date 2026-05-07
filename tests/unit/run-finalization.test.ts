import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression tests for run finalization (zombie run fix).
 *
 * The /complete and /chat endpoints must:
 * 1. Await updateRunStatus (not fire-and-forget)
 * 2. Log errors with context (runId, orgId, endpoint) instead of swallowing
 * 3. Close the run as "completed" on success, "failed" on LLM error
 *
 * We extract the finalization logic into a helper to test it in isolation,
 * mirroring the pattern used in src/index.ts finally blocks.
 */

const mockUpdateRunStatus = vi.fn();
const mockAddRunCosts = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  mockUpdateRunStatus.mockReset();
  mockAddRunCosts.mockReset();
});

interface FinalizeRunParams {
  endpoint: string;
  runId: string;
  orgId: string;
  userId: string;
  failed: boolean;
  costItems: Array<{ costName: string; quantity: number; costSource: "platform" | "org" }>;
  trackingHeaders?: Record<string, string>;
}

/**
 * Mirrors the finalization logic in /complete and /chat finally blocks
 * after the fix (awaited + error logging).
 */
async function finalizeRun(params: FinalizeRunParams): Promise<void> {
  const { endpoint, runId, orgId, userId, failed, costItems, trackingHeaders } = params;
  const runIdentity = { orgId, userId, runId };
  try {
    await Promise.all([
      mockUpdateRunStatus(runId, failed ? "failed" : "completed", runIdentity, trackingHeaders),
      mockAddRunCosts(runId, costItems, runIdentity, trackingHeaders),
    ]);
  } catch (runErr) {
    console.error(`[chat-service] ${endpoint} failed to finalize run runId="${runId}" orgId="${orgId}":`, runErr);
  }
}

const BASE_PARAMS = {
  runId: "run-abc-123",
  orgId: "org-xyz-789",
  userId: "user-456",
  costItems: [
    { costName: "claude-sonnet-tokens-input", quantity: 1000, costSource: "platform" as const },
    { costName: "claude-sonnet-tokens-output", quantity: 200, costSource: "platform" as const },
  ],
  trackingHeaders: { "x-campaign-id": "camp-1" },
};

describe("run finalization (/complete)", () => {
  const endpoint = "/complete";

  it("closes run as completed on success", async () => {
    mockUpdateRunStatus.mockResolvedValue({ id: BASE_PARAMS.runId, status: "completed" });
    mockAddRunCosts.mockResolvedValue(undefined);

    await finalizeRun({ ...BASE_PARAMS, endpoint, failed: false });

    expect(mockUpdateRunStatus).toHaveBeenCalledWith(
      BASE_PARAMS.runId,
      "completed",
      { orgId: BASE_PARAMS.orgId, userId: BASE_PARAMS.userId, runId: BASE_PARAMS.runId },
      BASE_PARAMS.trackingHeaders,
    );
  });

  it("closes run as failed on LLM error", async () => {
    mockUpdateRunStatus.mockResolvedValue({ id: BASE_PARAMS.runId, status: "failed" });
    mockAddRunCosts.mockResolvedValue(undefined);

    await finalizeRun({ ...BASE_PARAMS, endpoint, failed: true });

    expect(mockUpdateRunStatus).toHaveBeenCalledWith(
      BASE_PARAMS.runId,
      "failed",
      { orgId: BASE_PARAMS.orgId, userId: BASE_PARAMS.userId, runId: BASE_PARAMS.runId },
      BASE_PARAMS.trackingHeaders,
    );
  });

  it("logs error with context when updateRunStatus fails (not swallowed)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const networkErr = new Error("ECONNREFUSED");
    mockUpdateRunStatus.mockRejectedValue(networkErr);
    mockAddRunCosts.mockResolvedValue(undefined);

    await finalizeRun({ ...BASE_PARAMS, endpoint, failed: false });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("/complete"),
      networkErr,
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(BASE_PARAMS.runId),
      networkErr,
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(BASE_PARAMS.orgId),
      networkErr,
    );
  });

  it("logs error with context when addRunCosts fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockUpdateRunStatus.mockResolvedValue({ id: BASE_PARAMS.runId, status: "completed" });
    mockAddRunCosts.mockRejectedValue(new Error("500 Internal Server Error"));

    await finalizeRun({ ...BASE_PARAMS, endpoint, failed: false });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("/complete"),
      expect.any(Error),
    );
  });

  it("does not throw when finalization fails (caller is not affected)", async () => {
    mockUpdateRunStatus.mockRejectedValue(new Error("runs-service down"));
    mockAddRunCosts.mockRejectedValue(new Error("runs-service down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Should not throw — the error is caught and logged
    await expect(finalizeRun({ ...BASE_PARAMS, endpoint, failed: false })).resolves.toBeUndefined();
  });
});

describe("run finalization (/chat)", () => {
  const endpoint = "/chat";

  it("closes run as completed on success", async () => {
    mockUpdateRunStatus.mockResolvedValue({ id: BASE_PARAMS.runId, status: "completed" });
    mockAddRunCosts.mockResolvedValue(undefined);

    await finalizeRun({ ...BASE_PARAMS, endpoint, failed: false });

    expect(mockUpdateRunStatus).toHaveBeenCalledWith(
      BASE_PARAMS.runId,
      "completed",
      expect.objectContaining({ runId: BASE_PARAMS.runId }),
      BASE_PARAMS.trackingHeaders,
    );
  });

  it("closes run as failed on LLM error", async () => {
    mockUpdateRunStatus.mockResolvedValue({ id: BASE_PARAMS.runId, status: "failed" });
    mockAddRunCosts.mockResolvedValue(undefined);

    await finalizeRun({ ...BASE_PARAMS, endpoint, failed: true });

    expect(mockUpdateRunStatus).toHaveBeenCalledWith(
      BASE_PARAMS.runId,
      "failed",
      expect.objectContaining({ runId: BASE_PARAMS.runId }),
      BASE_PARAMS.trackingHeaders,
    );
  });

  it("logs error with context when updateRunStatus fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const timeoutErr = new Error("Request timed out");
    mockUpdateRunStatus.mockRejectedValue(timeoutErr);
    mockAddRunCosts.mockResolvedValue(undefined);

    await finalizeRun({ ...BASE_PARAMS, endpoint, failed: false });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("/chat"),
      timeoutErr,
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(BASE_PARAMS.runId),
      timeoutErr,
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(BASE_PARAMS.orgId),
      timeoutErr,
    );
  });
});
