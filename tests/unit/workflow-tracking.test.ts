import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, type AuthLocals } from "../../src/middleware/auth.js";

function mockReqRes(headers: Record<string, string> = {}) {
  const req = { headers } as unknown as Request;
  const res = {
    locals: {} as Record<string, unknown>,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

const BASE_HEADERS = {
  "x-api-key": "test-key",
  "x-org-id": "org-123",
  "x-user-id": "user-456",
  "x-run-id": "run-789",
};

describe("workflow tracking headers in auth middleware", () => {
  it("extracts all three tracking headers when present", () => {
    const { req, res, next } = mockReqRes({
      ...BASE_HEADERS,
      "x-campaign-id": "camp-abc",
      "x-brand-id": "brand-xyz",
      "x-workflow-name": "outreach-v2",
    });
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    const locals = res.locals as unknown as AuthLocals;
    expect(locals.workflowTracking).toEqual({
      campaignId: "camp-abc",
      brandId: "brand-xyz",
      workflowName: "outreach-v2",
    });
  });

  it("returns empty tracking object when no tracking headers present", () => {
    const { req, res, next } = mockReqRes(BASE_HEADERS);
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    const locals = res.locals as unknown as AuthLocals;
    expect(locals.workflowTracking).toEqual({});
  });

  it("extracts partial tracking headers (only campaign-id)", () => {
    const { req, res, next } = mockReqRes({
      ...BASE_HEADERS,
      "x-campaign-id": "camp-only",
    });
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    const locals = res.locals as unknown as AuthLocals;
    expect(locals.workflowTracking).toEqual({
      campaignId: "camp-only",
    });
  });

  it("does not break existing auth flow", () => {
    const { req, res, next } = mockReqRes({
      ...BASE_HEADERS,
      "x-campaign-id": "camp-123",
    });
    requireAuth(req, res, next);
    expect(res.locals.orgId).toBe("org-123");
    expect(res.locals.userId).toBe("user-456");
    expect(res.locals.runId).toBe("run-789");
  });
});

describe("runs-client forwards tracking headers", () => {
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

  it("forwards tracking headers on createRun", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-1", status: "running" }),
    });

    const { createRun } = await loadModule();
    await createRun(
      { orgId: "org-1", serviceName: "chat-service", taskName: "chat" },
      { "x-campaign-id": "camp-1", "x-brand-id": "brand-1", "x-workflow-name": "flow-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://runs.test.local/v1/runs",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-campaign-id": "camp-1",
          "x-brand-id": "brand-1",
          "x-workflow-name": "flow-1",
        }),
      }),
    );
  });

  it("does not include tracking headers when not provided", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-1", status: "running" }),
    });

    const { createRun } = await loadModule();
    await createRun({ orgId: "org-1", serviceName: "chat-service", taskName: "chat" });

    const callHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(callHeaders["x-campaign-id"]).toBeUndefined();
    expect(callHeaders["x-brand-id"]).toBeUndefined();
    expect(callHeaders["x-workflow-name"]).toBeUndefined();
  });

  it("forwards tracking headers on updateRunStatus", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-1", status: "completed" }),
    });

    const { updateRunStatus } = await loadModule();
    await updateRunStatus("run-1", "completed", { "x-campaign-id": "camp-2" });

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-campaign-id": "camp-2",
        }),
      }),
    );
  });

  it("forwards tracking headers on addRunCosts", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ costs: [] }),
    });

    const { addRunCosts } = await loadModule();
    await addRunCosts(
      "run-1",
      [{ costName: "gemini-3-flash-tokens-input", quantity: 100, costSource: "platform" as const }],
      { "x-brand-id": "brand-3" },
    );

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-brand-id": "brand-3",
        }),
      }),
    );
  });
});

describe("key-client forwards tracking headers", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.KEY_SERVICE_API_KEY = "test-key-svc-key";
    process.env.KEY_SERVICE_URL = "https://key.test.local";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  async function loadModule() {
    vi.resetModules();
    return import("../../src/lib/key-client.js");
  }

  it("forwards tracking headers on resolveKey", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "gemini", key: "k", keySource: "platform" }),
    });

    const { resolveKey } = await loadModule();
    await resolveKey({
      provider: "gemini",
      orgId: "org-1",
      userId: "user-1",
      caller: { method: "POST", path: "/chat" },
      trackingHeaders: { "x-campaign-id": "camp-1", "x-workflow-name": "flow-1" },
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-campaign-id": "camp-1",
          "x-workflow-name": "flow-1",
        }),
      }),
    );
  });

  it("forwards tracking headers on decryptOrgKey", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "mcp", key: "k" }),
    });

    const { decryptOrgKey } = await loadModule();
    await decryptOrgKey("mcp", "org-1", { method: "POST", path: "/chat" }, {
      "x-brand-id": "brand-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-brand-id": "brand-1",
        }),
      }),
    );
  });

  it("does not include tracking headers when not provided", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "gemini", key: "k", keySource: "platform" }),
    });

    const { resolveKey } = await loadModule();
    await resolveKey({
      provider: "gemini",
      orgId: "org-1",
      userId: "user-1",
      caller: { method: "POST", path: "/chat" },
    });

    const callHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(callHeaders["x-campaign-id"]).toBeUndefined();
  });
});
