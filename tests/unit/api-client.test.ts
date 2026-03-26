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
  return import("../../src/lib/api-client.js");
}

describe("apiServiceFetch", () => {
  it("sends request with correct URL, Bearer auth, and identity headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    const { apiServiceFetch } = await loadModule();
    await apiServiceFetch("/v1/workflows", "GET", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/workflows",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-API-Key": "test-api-svc-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
          "x-run-id": "run-1",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("includes JSON body when provided", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    const { apiServiceFetch } = await loadModule();
    await apiServiceFetch("/v1/features", "POST", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    }, { name: "My Feature" });

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(callArgs.body).toBe(JSON.stringify({ name: "My Feature" }));
  });

  it("does not include body when not provided", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    const { apiServiceFetch } = await loadModule();
    await apiServiceFetch("/v1/keys", "GET", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(callArgs.body).toBeUndefined();
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    const { apiServiceFetch } = await loadModule();
    await apiServiceFetch("/v1/keys", "GET", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      trackingHeaders: { "x-campaign-id": "camp-1", "x-brand-id": "brand-1" },
    });

    const callHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(callHeaders["x-campaign-id"]).toBe("camp-1");
    expect(callHeaders["x-brand-id"]).toBe("brand-1");
  });

  it("throws when ADMIN_DISTRIBUTE_API_KEY is not set", async () => {
    delete process.env.ADMIN_DISTRIBUTE_API_KEY;

    const { apiServiceFetch } = await loadModule();
    expect(() =>
      apiServiceFetch("/v1/keys", "GET", { orgId: "o", userId: "u", runId: "r" }),
    ).toThrow(/ADMIN_DISTRIBUTE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses default API_SERVICE_URL when not set", async () => {
    delete process.env.API_SERVICE_URL;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    const { apiServiceFetch } = await loadModule();
    await apiServiceFetch("/v1/test", "GET", { orgId: "o", userId: "u", runId: "r" });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.distribute.you/v1/test",
      expect.anything(),
    );
  });
});
