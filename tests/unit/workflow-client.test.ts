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

  it("always sends x-run-id header (regression: workflow-service 400)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "wf-123" }),
    });

    const { updateWorkflow } = await loadModule();
    await updateWorkflow(
      "wf-123",
      { name: "test" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    const callHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(callHeaders["x-run-id"]).toBe("run-1");
    expect(callHeaders["x-org-id"]).toBe("org-1");
    expect(callHeaders["x-user-id"]).toBe("user-1");
    expect(callHeaders["x-api-key"]).toBe("test-wf-key");
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
        runId: "run-1",
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
      updateWorkflow("wf-bad", { description: "x" }, { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 404/);
  });

  it("throws when WORKFLOW_SERVICE_API_KEY is not set", async () => {
    delete process.env.WORKFLOW_SERVICE_API_KEY;

    const { updateWorkflow } = await loadModule();
    await expect(
      updateWorkflow("wf-1", { description: "x" }, { orgId: "o", userId: "u", runId: "r" }),
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
      validateWorkflow("wf-bad", { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 500/);
  });

  it("uses default WORKFLOW_SERVICE_URL when not set", async () => {
    delete process.env.WORKFLOW_SERVICE_URL;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ valid: true }),
    });

    const { validateWorkflow } = await loadModule();
    await validateWorkflow("wf-1", { orgId: "o", userId: "u", runId: "r" });

    expect(fetch).toHaveBeenCalledWith(
      "https://workflow.mcpfactory.org/workflows/wf-1/validate",
      expect.anything(),
    );
  });
});

describe("getWorkflow", () => {
  it("sends GET with correct URL and headers", async () => {
    const mockWorkflow = { id: "wf-1", dag: { nodes: [], edges: [] } };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockWorkflow),
    });

    const { getWorkflow } = await loadModule();
    const result = await getWorkflow("wf-1", { orgId: "org-1", userId: "user-1", runId: "run-1" });

    expect(fetch).toHaveBeenCalledWith(
      "https://workflow.test.local/workflows/wf-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-api-key": "test-wf-key",
          "x-org-id": "org-1",
        }),
      }),
    );
    expect(result).toEqual(mockWorkflow);
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not found"),
    });

    const { getWorkflow } = await loadModule();
    await expect(
      getWorkflow("wf-bad", { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 404/);
  });
});

describe("updateWorkflowNodeConfig", () => {
  it("fetches workflow, merges config, and PUTs the updated DAG", async () => {
    const existingWorkflow = {
      id: "wf-1",
      dag: {
        nodes: [
          { id: "email-generate", type: "http.call", config: { body: { type: "cold-email" }, path: "/generate", method: "POST", service: "content-generation" } },
          { id: "email-send", type: "http.call", config: { path: "/send", method: "POST", service: "email-gateway" } },
        ],
        edges: [{ from: "email-generate", to: "email-send" }],
      },
    };

    const updatedWorkflow = { ...existingWorkflow, updatedAt: "2026-03-18T00:00:00Z" };

    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(existingWorkflow) }) // GET
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(updatedWorkflow) }); // PUT

    const { updateWorkflowNodeConfig } = await loadModule();
    const result = await updateWorkflowNodeConfig(
      "wf-1",
      "email-generate",
      { body: { type: "cold-email-v3" } },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    // Verify GET was called first
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("https://workflow.test.local/workflows/wf-1");
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe("GET");

    // Verify PUT was called with merged config
    const putBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(putBody.dag.nodes[0].config.body.type).toBe("cold-email-v3");
    // Preserved other config keys
    expect(putBody.dag.nodes[0].config.path).toBe("/generate");
    expect(putBody.dag.nodes[0].config.service).toBe("content-generation");
    // Other nodes unchanged
    expect(putBody.dag.nodes[1].id).toBe("email-send");

    expect(result).toEqual(updatedWorkflow);
  });

  it("throws when node is not found in DAG", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        id: "wf-1",
        dag: { nodes: [{ id: "step-1", type: "http.call" }], edges: [] },
      }),
    });

    const { updateWorkflowNodeConfig } = await loadModule();
    await expect(
      updateWorkflowNodeConfig(
        "wf-1",
        "nonexistent-node",
        { body: { type: "v2" } },
        { orgId: "o", userId: "u", runId: "r" },
      ),
    ).rejects.toThrow(/Node "nonexistent-node" not found/);
  });

  it("throws when workflow has no DAG", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "wf-1", dag: null }),
    });

    const { updateWorkflowNodeConfig } = await loadModule();
    await expect(
      updateWorkflowNodeConfig(
        "wf-1",
        "step-1",
        { body: {} },
        { orgId: "o", userId: "u", runId: "r" },
      ),
    ).rejects.toThrow(/has no DAG/);
  });
});
