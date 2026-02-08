import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.RUNS_SERVICE_API_KEY = "test-runs-key";
  process.env.RUNS_SERVICE_URL = "https://runs.test.local";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

// Dynamic import so env vars are read fresh
async function loadModule() {
  vi.resetModules();
  return import("../../src/lib/runs-client.js");
}

describe("createRun", () => {
  it("sends POST /v1/runs with correct body and headers", async () => {
    const mockRun = { id: "run-1", status: "running" };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRun),
    });

    const { createRun } = await loadModule();
    const result = await createRun({
      clerkOrgId: "org_123",
      appId: "mcpfactory",
      serviceName: "chat-service",
      taskName: "chat",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://runs.test.local/v1/runs",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "test-runs-key",
        },
        body: JSON.stringify({
          clerkOrgId: "org_123",
          appId: "mcpfactory",
          serviceName: "chat-service",
          taskName: "chat",
        }),
      }),
    );
    expect(result).toEqual(mockRun);
  });

  it("returns null and logs on HTTP error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const { createRun } = await loadModule();
    const result = await createRun({
      clerkOrgId: "org_123",
      appId: "mcpfactory",
      serviceName: "chat-service",
      taskName: "chat",
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns null and logs on network error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    const { createRun } = await loadModule();
    const result = await createRun({
      clerkOrgId: "org_123",
      appId: "mcpfactory",
      serviceName: "chat-service",
      taskName: "chat",
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("updateRunStatus", () => {
  it("sends PATCH /v1/runs/{id} with status", async () => {
    const mockRun = { id: "run-1", status: "completed" };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRun),
    });

    const { updateRunStatus } = await loadModule();
    const result = await updateRunStatus("run-1", "completed");

    expect(fetch).toHaveBeenCalledWith(
      "https://runs.test.local/v1/runs/run-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "completed" }),
      }),
    );
    expect(result).toEqual(mockRun);
  });

  it("handles failed status", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-1", status: "failed" }),
    });

    const { updateRunStatus } = await loadModule();
    const result = await updateRunStatus("run-1", "failed");

    expect(result?.status).toBe("failed");
  });
});

describe("addRunCosts", () => {
  it("sends POST /v1/runs/{id}/costs with items", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ costs: [] }),
    });

    const { addRunCosts } = await loadModule();
    await addRunCosts("run-1", [
      { costName: "gemini-3-flash-tokens-input", quantity: 100 },
      { costName: "gemini-3-flash-tokens-output", quantity: 50 },
    ]);

    expect(fetch).toHaveBeenCalledWith(
      "https://runs.test.local/v1/runs/run-1/costs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          items: [
            { costName: "gemini-3-flash-tokens-input", quantity: 100 },
            { costName: "gemini-3-flash-tokens-output", quantity: 50 },
          ],
        }),
      }),
    );
  });

  it("skips request when items array is empty", async () => {
    const { addRunCosts } = await loadModule();
    await addRunCosts("run-1", []);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("handles 422 unknown cost name gracefully", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('{"error":"Unknown cost name"}'),
    });

    const { addRunCosts } = await loadModule();
    await addRunCosts("run-1", [
      { costName: "unknown-cost", quantity: 10 },
    ]);

    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("missing RUNS_SERVICE_API_KEY", () => {
  it("returns null without making requests", async () => {
    delete process.env.RUNS_SERVICE_API_KEY;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { createRun } = await loadModule();
    const result = await createRun({
      clerkOrgId: "org_123",
      appId: "mcpfactory",
      serviceName: "chat-service",
      taskName: "chat",
    });

    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("RUNS_SERVICE_API_KEY not set"),
    );
  });
});
