import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Store original env
const originalEnv = { ...process.env };

describe("updateWorkflow", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.WORKFLOW_SERVICE_URL = "https://test-workflow.example.com";
    process.env.WORKFLOW_SERVICE_API_KEY = "test-api-key";
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadModule() {
    return import("../../src/lib/workflow-client.js");
  }

  it("sends PUT request with correct headers and body", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ id: "wf-123", name: "Updated" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { updateWorkflow } = await loadModule();
    const result = await updateWorkflow(
      "wf-123",
      { name: "New Name", description: "New desc" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: "wf-123", name: "Updated" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://test-workflow.example.com/workflows/wf-123",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ name: "New Name", description: "New desc" }),
      }),
    );

    const callHeaders = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(callHeaders["x-api-key"]).toBe("test-api-key");
    expect(callHeaders["x-org-id"]).toBe("org-1");
    expect(callHeaders["x-user-id"]).toBe("user-1");
    expect(callHeaders["x-run-id"]).toBe("run-1");
  });

  it("forwards tracking headers", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const { updateWorkflow } = await loadModule();
    await updateWorkflow(
      "wf-123",
      { tags: ["email", "outreach"] },
      {
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        trackingHeaders: { "x-campaign-id": "camp-1", "x-brand-id": "brand-1" },
      },
    );

    const callHeaders = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(callHeaders["x-campaign-id"]).toBe("camp-1");
    expect(callHeaders["x-brand-id"]).toBe("brand-1");
  });

  it("returns error when API key is not configured", async () => {
    delete process.env.WORKFLOW_SERVICE_API_KEY;

    const { updateWorkflow } = await loadModule();
    const result = await updateWorkflow(
      "wf-123",
      { name: "test" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("WORKFLOW_SERVICE_API_KEY not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns error on non-ok response", async () => {
    fetchSpy.mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );

    const { updateWorkflow } = await loadModule();
    const result = await updateWorkflow(
      "wf-999",
      { name: "test" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("404");
  });

  it("always sends x-run-id header (regression: workflow-service 400)", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const { updateWorkflow } = await loadModule();
    await updateWorkflow(
      "wf-123",
      { name: "test" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    const callHeaders = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(callHeaders["x-run-id"]).toBe("run-1");
    expect(callHeaders["x-org-id"]).toBe("org-1");
    expect(callHeaders["x-user-id"]).toBe("user-1");
    expect(callHeaders["x-api-key"]).toBe("test-api-key");
  });

  it("returns error on network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("Connection refused"));

    const { updateWorkflow } = await loadModule();
    const result = await updateWorkflow(
      "wf-123",
      { name: "test" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Connection refused");
  });
});
