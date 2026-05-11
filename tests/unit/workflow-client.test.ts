import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.ADMIN_DISTRIBUTE_API_KEY = "test-api-svc-key";
  process.env.API_SERVICE_URL = "https://api.test.local";
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

describe("createWorkflow", () => {
  it("sends POST /v1/workflows/create with body and identity headers", async () => {
    const mockResponse = {
      workflow: { id: "wf-new", name: "cold-email-outreach-nova", action: "created" },
      dag: { nodes: [{ id: "step-1", type: "http.call" }], edges: [] },
      generatedDescription: "Cold email workflow",
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(mockResponse),
    });

    const { createWorkflow } = await loadModule();
    const result = await createWorkflow(
      {
        description: "Fetch a lead, generate a cold email, and send it",
        featureSlug: "cold-email-outreach",
        hints: { services: ["lead", "content-generation"] },
      },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/workflows/create",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-API-Key": "test-api-svc-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
        }),
      }),
    );
    const sentBody = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(sentBody.description).toContain("cold email");
    expect(sentBody.featureSlug).toBe("cold-email-outreach");
    expect(sentBody.hints.services).toEqual(["lead", "content-generation"]);
    expect(result).toEqual(mockResponse);
  });

  it("passes optional style configuration through", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ workflow: { id: "wf-1" } }),
    });

    const { createWorkflow } = await loadModule();
    await createWorkflow(
      {
        description: "Workflow inspired by an expert",
        featureSlug: "cold-email",
        style: { type: "human", humanId: "hum-1", name: "Hormozi" },
      },
      { orgId: "o", userId: "u", runId: "r" },
    );

    const sentBody = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(sentBody.style).toEqual({
      type: "human",
      humanId: "hum-1",
      name: "Hormozi",
    });
  });

  it("throws on non-OK response with status and body in message", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve("Could not generate a valid DAG"),
    });

    const { createWorkflow } = await loadModule();
    await expect(
      createWorkflow(
        { description: "vague workflow request", featureSlug: "test" },
        { orgId: "o", userId: "u", runId: "r" },
      ),
    ).rejects.toThrow(/returned 422.*Could not generate a valid DAG/);
  });
});

describe("upgradeWorkflow", () => {
  it("sends POST /v1/workflows/upgrade with workflowSlug + description", async () => {
    const mockResponse = {
      workflow: {
        id: "wf-v2",
        name: "cold-email-outreach-nova",
        action: "updated",
      },
      dag: { nodes: [], edges: [] },
      generatedDescription: "Upgraded workflow",
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockResponse),
    });

    const { upgradeWorkflow } = await loadModule();
    const result = await upgradeWorkflow(
      {
        workflowSlug: "cold-email-outreach-nova",
        description: "Bug fix: the email-send step was missing the to address mapping",
      },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/workflows/upgrade",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-API-Key": "test-api-svc-key",
          "x-org-id": "org-1",
        }),
      }),
    );
    const sentBody = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(sentBody.workflowSlug).toBe("cold-email-outreach-nova");
    expect(sentBody.description).toContain("Bug fix");
    expect(result).toEqual(mockResponse);
  });

  it("throws on non-OK response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Workflow slug not found"),
    });

    const { upgradeWorkflow } = await loadModule();
    await expect(
      upgradeWorkflow(
        { workflowSlug: "missing", description: "fix something" },
        { orgId: "o", userId: "u", runId: "r" },
      ),
    ).rejects.toThrow(/returned 404.*Workflow slug not found/);
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ workflow: { id: "wf-1" } }),
    });

    const { upgradeWorkflow } = await loadModule();
    await upgradeWorkflow(
      { workflowSlug: "s", description: "description text" },
      {
        orgId: "o",
        userId: "u",
        runId: "r",
        trackingHeaders: { "x-campaign-id": "camp-1" },
      },
    );

    const callHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .headers;
    expect(callHeaders["x-campaign-id"]).toBe("camp-1");
  });
});

describe("forkWorkflow", () => {
  it("sends PUT /v1/workflows/:id with DAG body via api-service", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: () =>
        Promise.resolve({
          id: "wf-new",
          name: "sales-email-v2",
          creationType: "fork",
          createdFromWorkflow: "wf-123",
          signatureName: "sales-email-v2",
          _action: "forked",
          _forkedFromName: "sales-email-v1",
        }),
    });

    const { forkWorkflow } = await loadModule();
    const result = await forkWorkflow(
      "wf-123",
      { dag: { nodes: [{ id: "step-1", type: "http.call" }], edges: [] } },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/workflows/wf-123",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(result.outcome).toBe("forked");
    expect(result.workflow.id).toBe("wf-new");
    expect(result.workflow.creationType).toBe("fork");
  });

  it("returns outcome 'updated' when signature is identical (no fork)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: "wf-1", _action: "updated" }),
    });

    const { forkWorkflow } = await loadModule();
    const result = await forkWorkflow(
      "wf-1",
      { dag: { nodes: [{ id: "step-1", type: "http.call" }], edges: [] } },
      { orgId: "o", userId: "u", runId: "r" },
    );

    expect(result.outcome).toBe("updated");
  });

  it("strips null config and inputMapping from DAG nodes before sending", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "wf-1" }),
    });

    const { forkWorkflow } = await loadModule();
    await forkWorkflow(
      "wf-1",
      {
        dag: {
          nodes: [
            {
              id: "step-1",
              type: "http.call",
              config: null as unknown as Record<string, unknown>,
              inputMapping: null as unknown as Record<string, string>,
              retries: 0,
            },
            { id: "step-2", type: "condition" },
            {
              id: "step-3",
              type: "http.call",
              config: { path: "/send" },
              inputMapping: { "body.to": "$ref:step-1.output.email" },
            },
          ],
          edges: [{ from: "step-1", to: "step-2" }],
        },
      },
      { orgId: "o", userId: "u", runId: "r" },
    );

    const sentBody = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(sentBody.dag.nodes[0]).toEqual({
      id: "step-1",
      type: "http.call",
      retries: 0,
    });
    expect(sentBody.dag.nodes[0].config).toBeUndefined();
    expect(sentBody.dag.nodes[0].inputMapping).toBeUndefined();
    expect(sentBody.dag.nodes[2].config).toEqual({ path: "/send" });
  });

  it("preserves condition field on DAG edges", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "wf-1", _action: "updated" }),
    });

    const { forkWorkflow } = await loadModule();
    await forkWorkflow(
      "wf-1",
      {
        dag: {
          nodes: [
            { id: "check", type: "condition" },
            { id: "yes", type: "http.call", config: { path: "/yes" } },
          ],
          edges: [
            { from: "check", to: "yes", condition: "results.check.found == true" },
          ],
        },
      },
      { orgId: "o", userId: "u", runId: "r" },
    );

    const sentBody = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(sentBody.dag.edges[0]).toEqual({
      from: "check",
      to: "yes",
      condition: "results.check.found == true",
    });
  });

  it("throws with existing workflow info on HTTP 409", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({
          existingWorkflowId: "wf-existing",
          existingWorkflowSlug: "sales-email-v2",
        }),
    });

    const { forkWorkflow } = await loadModule();
    await expect(
      forkWorkflow(
        "wf-123",
        { dag: { nodes: [{ id: "step-1", type: "http.call" }], edges: [] } },
        { orgId: "org-1", userId: "user-1", runId: "run-1" },
      ),
    ).rejects.toThrow(/sales-email-v2.*wf-existing/);
  });

  it("throws on other HTTP errors", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal error"),
    });

    const { forkWorkflow } = await loadModule();
    await expect(
      forkWorkflow(
        "wf-bad",
        { dag: { nodes: [], edges: [] } },
        { orgId: "o", userId: "u", runId: "r" },
      ),
    ).rejects.toThrow(/returned 500/);
  });

  it("throws when ADMIN_DISTRIBUTE_API_KEY is not set", async () => {
    delete process.env.ADMIN_DISTRIBUTE_API_KEY;

    const { forkWorkflow } = await loadModule();
    await expect(
      forkWorkflow(
        "wf-1",
        { dag: { nodes: [], edges: [] } },
        { orgId: "o", userId: "u", runId: "r" },
      ),
    ).rejects.toThrow(/ADMIN_DISTRIBUTE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("validateWorkflow", () => {
  it("sends POST with correct URL and headers via api-service", async () => {
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
      "https://api.test.local/v1/workflows/wf-456/validate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-API-Key": "test-api-svc-key",
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

  it("uses default API_SERVICE_URL when not set", async () => {
    delete process.env.API_SERVICE_URL;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ valid: true }),
    });

    const { validateWorkflow } = await loadModule();
    await validateWorkflow("wf-1", { orgId: "o", userId: "u", runId: "r" });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.distribute.you/v1/workflows/wf-1/validate",
      expect.anything(),
    );
  });
});

describe("getWorkflow", () => {
  it("sends GET with correct URL and headers via api-service", async () => {
    const mockWorkflow = { id: "wf-1", dag: { nodes: [], edges: [] } };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockWorkflow),
    });

    const { getWorkflow } = await loadModule();
    const result = await getWorkflow("wf-1", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/workflows/wf-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-API-Key": "test-api-svc-key",
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

describe("getWorkflowRequiredProviders", () => {
  it("sends GET to /v1/workflows/{id}/key-status via api-service", async () => {
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
      "https://api.test.local/v1/workflows/wf-1/key-status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-API-Key": "test-api-svc-key",
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
      getWorkflowRequiredProviders("wf-bad", {
        orgId: "o",
        userId: "u",
        runId: "r",
      }),
    ).rejects.toThrow(/returned 404/);
  });
});

describe("listWorkflows", () => {
  it("sends GET /v1/workflows with query params via api-service", async () => {
    const mockWorkflows = [{ id: "wf-1", name: "sales-email" }];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockWorkflows),
    });

    const { listWorkflows } = await loadModule();
    const result = await listWorkflows(
      {
        category: "sales",
        channel: "email",
        tag: "cold",
        featureSlug: "cold-email-outreach",
        status: "active",
      },
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v1/workflows?");
    expect(calledUrl).toContain("category=sales");
    expect(calledUrl).toContain("channel=email");
    expect(calledUrl).toContain("tag=cold");
    expect(calledUrl).toContain("featureSlug=cold-email-outreach");
    expect(calledUrl).toContain("status=active");
    expect(result).toEqual(mockWorkflows);
  });

  it("sends GET /v1/workflows without query params when no filters", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const { listWorkflows } = await loadModule();
    await listWorkflows({}, { orgId: "o", userId: "u", runId: "r" });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://api.test.local/v1/workflows");
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
