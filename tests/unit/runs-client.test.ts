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

async function loadModule() {
  vi.resetModules();
  return import("../../src/lib/runs-client.js");
}

const identity = { orgId: "org-uuid-123", userId: "user-uuid-456", runId: "caller-run-1" };

describe("createRun", () => {
  it("sends POST /v1/runs with identity headers and body", async () => {
    const mockRun = { id: "run-1", status: "running" };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRun),
    });

    const { createRun } = await loadModule();
    const result = await createRun(
      { serviceName: "chat-service", taskName: "chat" },
      identity,
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://runs.test.local/v1/runs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "test-runs-key",
          "x-org-id": "org-uuid-123",
          "x-user-id": "user-uuid-456",
          "x-run-id": "caller-run-1",
        }),
        body: JSON.stringify({
          serviceName: "chat-service",
          taskName: "chat",
        }),
      }),
    );
    expect(result).toEqual(mockRun);
  });

  it("does not send orgId/userId in body (only in headers)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-1" }),
    });

    const { createRun } = await loadModule();
    await createRun(
      { serviceName: "chat-service", taskName: "chat" },
      identity,
    );

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).not.toHaveProperty("orgId");
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("runId");
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-1" }),
    });

    const { createRun } = await loadModule();
    await createRun(
      { serviceName: "chat-service", taskName: "chat" },
      identity,
      { "x-campaign-id": "camp-1", "x-brand-id": "brand-1" },
    );

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers["x-campaign-id"]).toBe("camp-1");
    expect(headers["x-brand-id"]).toBe("brand-1");
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const { createRun } = await loadModule();
    await expect(
      createRun({ serviceName: "chat-service", taskName: "chat" }, identity),
    ).rejects.toThrow(/returned 500/);
  });

  it("throws on network error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    const { createRun } = await loadModule();
    await expect(
      createRun({ serviceName: "chat-service", taskName: "chat" }, identity),
    ).rejects.toThrow("ECONNREFUSED");
  });
});

describe("updateRunStatus", () => {
  it("sends PATCH with identity headers", async () => {
    const mockRun = { id: "run-1", status: "completed" };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRun),
    });

    const { updateRunStatus } = await loadModule();
    const result = await updateRunStatus("run-1", "completed", identity);

    expect(fetch).toHaveBeenCalledWith(
      "https://runs.test.local/v1/runs/run-1",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          "x-org-id": "org-uuid-123",
          "x-user-id": "user-uuid-456",
          "x-run-id": "caller-run-1",
        }),
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
    const result = await updateRunStatus("run-1", "failed", identity);

    expect(result.status).toBe("failed");
  });
});

describe("addRunCosts", () => {
  it("sends POST with identity headers and cost items", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ costs: [] }),
    });

    const { addRunCosts } = await loadModule();
    await addRunCosts("run-1", [
      { costName: "gemini-3-flash-tokens-input", quantity: 100, costSource: "platform" },
      { costName: "gemini-3-flash-tokens-output", quantity: 50, costSource: "platform" },
    ], identity);

    expect(fetch).toHaveBeenCalledWith(
      "https://runs.test.local/v1/runs/run-1/costs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-org-id": "org-uuid-123",
          "x-user-id": "user-uuid-456",
        }),
      }),
    );
  });

  it("skips request when items array is empty", async () => {
    const { addRunCosts } = await loadModule();
    await addRunCosts("run-1", [], identity);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on HTTP error (e.g. unknown cost name)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('{"error":"Unknown cost name"}'),
    });

    const { addRunCosts } = await loadModule();
    await expect(
      addRunCosts("run-1", [
        { costName: "unknown-cost", quantity: 10, costSource: "platform" as const },
      ], identity),
    ).rejects.toThrow(/returned 422/);
  });
});

describe("missing RUNS_SERVICE_API_KEY", () => {
  it("throws without making requests", async () => {
    delete process.env.RUNS_SERVICE_API_KEY;

    const { createRun } = await loadModule();
    await expect(
      createRun({ serviceName: "chat-service", taskName: "chat" }, identity),
    ).rejects.toThrow(/RUNS_SERVICE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });
});
