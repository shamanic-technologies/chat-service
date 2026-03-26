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
    expect(result).toEqual({
      workflow: { id: "wf-123", description: "Updated" },
      outcome: "updated",
    });
  });

  it("returns outcome 'forked' on HTTP 201", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ id: "wf-new", name: "sales-email-v2", forkedFrom: "wf-123", signatureName: "sales-email-v2" }),
    });

    const { updateWorkflow } = await loadModule();
    const result = await updateWorkflow(
      "wf-123",
      { dag: { nodes: [{ id: "step-1", type: "http.call" }], edges: [] } },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(result.outcome).toBe("forked");
    expect(result.workflow.id).toBe("wf-new");
    expect(result.workflow.forkedFrom).toBe("wf-123");
    expect(result.workflow.signatureName).toBe("sales-email-v2");
  });

  it("throws with existing workflow info on HTTP 409", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ existingWorkflowId: "wf-existing", existingWorkflowName: "sales-email-v2" }),
    });

    const { updateWorkflow } = await loadModule();
    await expect(
      updateWorkflow(
        "wf-123",
        { dag: { nodes: [{ id: "step-1", type: "http.call" }], edges: [] } },
        { orgId: "org-1", userId: "user-1", runId: "run-1" },
      ),
    ).rejects.toThrow(/sales-email-v2.*wf-existing/);
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

  it("strips null config and inputMapping from DAG nodes before sending", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "wf-1" }),
    });

    const { updateWorkflow } = await loadModule();
    await updateWorkflow(
      "wf-1",
      {
        dag: {
          nodes: [
            { id: "step-1", type: "http.call", config: null as unknown as Record<string, unknown>, inputMapping: null as unknown as Record<string, string>, retries: 0 },
            { id: "step-2", type: "condition" },
            { id: "step-3", type: "http.call", config: { path: "/send" }, inputMapping: { "body.to": "$ref:step-1.output.email" } },
          ],
          edges: [{ from: "step-1", to: "step-2" }],
        },
      },
      { orgId: "o", userId: "u", runId: "r" },
    );

    const sentBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    // Null fields stripped
    expect(sentBody.dag.nodes[0]).toEqual({ id: "step-1", type: "http.call", retries: 0 });
    expect(sentBody.dag.nodes[0].config).toBeUndefined();
    expect(sentBody.dag.nodes[0].inputMapping).toBeUndefined();
    // Nodes without config/inputMapping stay clean
    expect(sentBody.dag.nodes[1]).toEqual({ id: "step-2", type: "condition" });
    // Non-null fields preserved
    expect(sentBody.dag.nodes[2].config).toEqual({ path: "/send" });
    expect(sentBody.dag.nodes[2].inputMapping).toEqual({ "body.to": "$ref:step-1.output.email" });
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

    expect(result).toEqual({ workflow: updatedWorkflow, outcome: "updated" });
  });

  it("returns forked outcome when node config change triggers a fork", async () => {
    const existingWorkflow = {
      id: "wf-1",
      dag: {
        nodes: [{ id: "step-1", type: "http.call", config: { path: "/old" } }],
        edges: [],
      },
    };

    const forkedWorkflow = { id: "wf-forked", name: "wf-1-custom", forkedFrom: "wf-1", dag: existingWorkflow.dag };

    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(existingWorkflow) }) // GET
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve(forkedWorkflow) }); // PUT (fork)

    const { updateWorkflowNodeConfig } = await loadModule();
    const result = await updateWorkflowNodeConfig(
      "wf-1",
      "step-1",
      { path: "/new" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(result.outcome).toBe("forked");
    expect(result.workflow.id).toBe("wf-forked");
    expect(result.workflow.forkedFrom).toBe("wf-1");
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

describe("generateWorkflow", () => {
  it("sends POST /workflows/generate with description and hints", async () => {
    const mockResponse = {
      workflow: { id: "wf-new", name: "sales-email-cold-outreach-nova" },
      dag: { nodes: [{ id: "step-1", type: "http.call" }], edges: [] },
      category: "sales",
      channel: "email",
      audienceType: "cold-outreach",
      generatedDescription: "A cold email workflow",
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { generateWorkflow } = await loadModule();
    const result = await generateWorkflow(
      {
        description: "Create a cold email workflow that fetches a lead, generates an email, and sends it",
        hints: { services: ["lead", "content-generation", "email-gateway"] },
      },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://workflow.test.local/workflows/generate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "test-wf-key",
          "x-org-id": "org-1",
        }),
      }),
    );

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.description).toContain("cold email workflow");
    expect(body.hints.services).toContain("lead");

    expect(result).toEqual(mockResponse);
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve("Invalid DAG"),
    });

    const { generateWorkflow } = await loadModule();
    await expect(
      generateWorkflow(
        { description: "bad workflow" },
        { orgId: "o", userId: "u", runId: "r" },
      ),
    ).rejects.toThrow(/returned 422/);
  });

  it("works without hints", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ workflow: { id: "wf-1" } }),
    });

    const { generateWorkflow } = await loadModule();
    await generateWorkflow(
      { description: "Simple workflow that sends an email" },
      { orgId: "o", userId: "u", runId: "r" },
    );

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.description).toBe("Simple workflow that sends an email");
    expect(body.hints).toBeUndefined();
  });
});

describe("getWorkflowRequiredProviders", () => {
  it("sends GET to /workflows/{id}/required-providers", async () => {
    const mockProviders = { providers: ["stripe", "anthropic"] };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockProviders),
    });

    const { getWorkflowRequiredProviders } = await loadModule();
    const result = await getWorkflowRequiredProviders("wf-1", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://workflow.test.local/workflows/wf-1/required-providers",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-api-key": "test-wf-key",
          "x-org-id": "org-1",
        }),
      }),
    );
    expect(result).toEqual(mockProviders);
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not found"),
    });

    const { getWorkflowRequiredProviders } = await loadModule();
    await expect(
      getWorkflowRequiredProviders("wf-bad", { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 404/);
  });
});

describe("listWorkflows", () => {
  it("sends GET /workflows with query params", async () => {
    const mockWorkflows = [{ id: "wf-1", name: "sales-email" }];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockWorkflows),
    });

    const { listWorkflows } = await loadModule();
    const result = await listWorkflows(
      { category: "sales", channel: "email", tag: "cold", featureSlug: "cold-email-outreach", status: "active" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/workflows?");
    expect(calledUrl).toContain("category=sales");
    expect(calledUrl).toContain("channel=email");
    expect(calledUrl).toContain("tag=cold");
    expect(calledUrl).toContain("featureSlug=cold-email-outreach");
    expect(calledUrl).toContain("status=active");
    expect(result).toEqual(mockWorkflows);
  });

  it("sends GET /workflows without query params when no filters", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const { listWorkflows } = await loadModule();
    await listWorkflows({}, { orgId: "o", userId: "u", runId: "r" });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://workflow.test.local/workflows");
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Server error"),
    });

    const { listWorkflows } = await loadModule();
    await expect(
      listWorkflows({ category: "sales" }, { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 500/);
  });
});
