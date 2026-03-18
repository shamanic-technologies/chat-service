import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.WORKFLOW_SERVICE_API_KEY = "test-wf-key";
  process.env.WORKFLOW_SERVICE_URL = "https://workflow.test.local";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

async function loadModule() {
  vi.resetModules();
  return import("../../src/lib/workflow-client.js");
}

describe("updateWorkflow", () => {
  it("sends PUT with correct URL, headers, and body", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "wf-123", description: "Updated" }),
    });

    const { updateWorkflow } = await loadModule();
    const result = await updateWorkflow(
      "wf-123",
      { description: "Updated description" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://workflow.test.local/workflows/wf-123",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-api-key": "test-wf-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
        body: JSON.stringify({ description: "Updated description" }),
      }),
    );
    expect(result).toEqual({ id: "wf-123", description: "Updated" });
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "wf-123" }),
    });

    const { updateWorkflow } = await loadModule();
    await updateWorkflow(
      "wf-123",
      { name: "new-name" },
      {
        orgId: "org-1",
        userId: "user-1",
        trackingHeaders: { "x-campaign-id": "camp-1" },
      },
    );

    const callHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(callHeaders["x-campaign-id"]).toBe("camp-1");
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not found"),
    });

    const { updateWorkflow } = await loadModule();
    await expect(
      updateWorkflow("wf-bad", { description: "x" }, { orgId: "o", userId: "u" }),
    ).rejects.toThrow(/returned 404/);
  });

  it("throws when WORKFLOW_SERVICE_API_KEY is not set", async () => {
    delete process.env.WORKFLOW_SERVICE_API_KEY;

    const { updateWorkflow } = await loadModule();
    await expect(
      updateWorkflow("wf-1", { description: "x" }, { orgId: "o", userId: "u" }),
    ).rejects.toThrow(/WORKFLOW_SERVICE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("validateWorkflow", () => {
  it("sends POST with correct URL and headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ valid: true, errors: [] }),
    });

    const { validateWorkflow } = await loadModule();
    const result = await validateWorkflow("wf-456", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://workflow.test.local/workflows/wf-456/validate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "test-wf-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
      }),
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal error"),
    });

    const { validateWorkflow } = await loadModule();
    await expect(
      validateWorkflow("wf-bad", { orgId: "o", userId: "u" }),
    ).rejects.toThrow(/returned 500/);
  });

  it("uses default WORKFLOW_SERVICE_URL when not set", async () => {
    delete process.env.WORKFLOW_SERVICE_URL;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ valid: true }),
    });

    const { validateWorkflow } = await loadModule();
    await validateWorkflow("wf-1", { orgId: "o", userId: "u" });

    expect(fetch).toHaveBeenCalledWith(
      "https://workflow.mcpfactory.org/workflows/wf-1/validate",
      expect.anything(),
    );
  });
});
