import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  // resolveKey still uses key-service directly
  process.env.KEY_SERVICE_API_KEY = "test-key-svc-key";
  process.env.KEY_SERVICE_URL = "https://key.test.local";
  // Read-only tools now route through api-service
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
  return import("../../src/lib/key-client.js");
}

// ---------------------------------------------------------------------------
// resolveKey — still direct to key-service
// ---------------------------------------------------------------------------

describe("resolveKey", () => {
  it("sends GET with orgId and userId as headers (not query params)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          provider: "anthropic",
          key: "resolved-key",
          keySource: "platform",
        }),
    });

    const { resolveKey } = await loadModule();
    const result = await resolveKey({
      provider: "anthropic",
      orgId: "org-uuid-123",
      userId: "user-uuid-456",
      runId: "run-uuid-789",
      caller: { method: "POST", path: "/chat" },
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://key.test.local/keys/anthropic/decrypt",
      expect.objectContaining({
        method: "GET",
        headers: {
          "x-api-key": "test-key-svc-key",
          "x-org-id": "org-uuid-123",
          "x-user-id": "user-uuid-456",
          "x-run-id": "run-uuid-789",
          "X-Caller-Service": "chat",
          "X-Caller-Method": "POST",
          "X-Caller-Path": "/chat",
        },
      }),
    );
    expect(result).toEqual({
      provider: "anthropic",
      key: "resolved-key",
      keySource: "platform",
    });
  });

  it("returns keySource 'org' for BYOK keys", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          provider: "anthropic",
          key: "user-own-key",
          keySource: "org",
        }),
    });

    const { resolveKey } = await loadModule();
    const result = await resolveKey({
      provider: "anthropic",
      orgId: "org-byok",
      userId: "user-byok",
      runId: "run-1",
      caller: { method: "POST", path: "/chat" },
    });

    expect(result.keySource).toBe("org");
  });

  it("throws on HTTP 404 (key not configured)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Key not configured"),
    });

    const { resolveKey } = await loadModule();
    await expect(
      resolveKey({
        provider: "anthropic",
        orgId: "org-123",
        userId: "user-123",
        runId: "run-1",
      caller: { method: "POST", path: "/chat" },
      }),
    ).rejects.toThrow(/returned 404/);
  });

  it("throws on HTTP 400 (missing caller headers)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Missing required caller headers"),
    });

    const { resolveKey } = await loadModule();
    await expect(
      resolveKey({
        provider: "anthropic",
        orgId: "org-123",
        userId: "user-123",
        runId: "run-1",
      caller: { method: "POST", path: "/chat" },
      }),
    ).rejects.toThrow(/returned 400/);
  });

  it("throws on HTTP 500 (server error)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const { resolveKey } = await loadModule();
    await expect(
      resolveKey({
        provider: "anthropic",
        orgId: "org-123",
        userId: "user-123",
        runId: "run-1",
      caller: { method: "POST", path: "/chat" },
      }),
    ).rejects.toThrow(/returned 500/);
  });

  it("throws on network error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    const { resolveKey } = await loadModule();
    await expect(
      resolveKey({
        provider: "anthropic",
        orgId: "org-123",
        userId: "user-123",
        runId: "run-1",
      caller: { method: "POST", path: "/chat" },
      }),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("throws when KEY_SERVICE_API_KEY is not set", async () => {
    delete process.env.KEY_SERVICE_API_KEY;

    const { resolveKey } = await loadModule();
    await expect(
      resolveKey({
        provider: "anthropic",
        orgId: "org-123",
        userId: "user-123",
        runId: "run-1",
      caller: { method: "POST", path: "/chat" },
      }),
    ).rejects.toThrow(/KEY_SERVICE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses default KEY_SERVICE_URL when not set", async () => {
    delete process.env.KEY_SERVICE_URL;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          provider: "anthropic",
          key: "key-123",
          keySource: "platform",
        }),
    });

    const { resolveKey } = await loadModule();
    await resolveKey({
      provider: "anthropic",
      orgId: "org-123",
      userId: "user-123",
      runId: "run-1",
      caller: { method: "POST", path: "/chat" },
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://key.mcpfactory.org/keys/anthropic/decrypt",
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Read-only key tools — now routed via api-service
// ---------------------------------------------------------------------------

describe("listOrgKeys", () => {
  it("calls GET /v1/keys via api-service", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          keys: [
            { provider: "anthropic", maskedKey: "sk-...abc", createdAt: null, updatedAt: null },
          ],
        }),
    });

    const { listOrgKeys } = await loadModule();
    const result = await listOrgKeys({
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/keys",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-API-Key": "test-api-svc-key",
          "x-org-id": "org-1",
        }),
      }),
    );
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].provider).toBe("anthropic");
  });

  it("throws on HTTP error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const { listOrgKeys } = await loadModule();
    await expect(
      listOrgKeys({ orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 500/);
  });

  it("forwards tracking headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ keys: [] }),
    });

    const { listOrgKeys } = await loadModule();
    await listOrgKeys({
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      trackingHeaders: { "x-campaign-id": "camp-123" },
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/keys",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-campaign-id": "camp-123",
        }),
      }),
    );
  });
});

describe("getKeySource", () => {
  it("calls GET /v1/keys/{provider}/source via api-service", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          provider: "anthropic",
          orgId: "org-1",
          keySource: "org",
          isDefault: false,
        }),
    });

    const { getKeySource } = await loadModule();
    const result = await getKeySource("anthropic", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/keys/anthropic/source",
      expect.anything(),
    );
    expect(result.keySource).toBe("org");
    expect(result.isDefault).toBe(false);
  });

  it("URL-encodes the provider name", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          provider: "my/provider",
          orgId: "org-1",
          keySource: "platform",
          isDefault: true,
        }),
    });

    const { getKeySource } = await loadModule();
    await getKeySource("my/provider", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/keys/my%2Fprovider/source",
      expect.anything(),
    );
  });
});

describe("listKeySources", () => {
  it("calls GET /v1/keys/sources via api-service", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          sources: [
            { provider: "anthropic", keySource: "org" },
            { provider: "stripe", keySource: "platform" },
          ],
        }),
    });

    const { listKeySources } = await loadModule();
    const result = await listKeySources({
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/keys/sources",
      expect.anything(),
    );
    expect(result.sources).toHaveLength(2);
  });
});

describe("checkProviderRequirements", () => {
  it("calls POST /v1/keys/provider-requirements via api-service", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          requirements: [
            { service: "chat", method: "POST", path: "/complete", provider: "anthropic" },
          ],
          providers: ["anthropic"],
        }),
    });

    const { checkProviderRequirements } = await loadModule();
    const result = await checkProviderRequirements(
      [{ service: "chat", method: "POST", path: "/complete" }],
      { orgId: "org-1", userId: "user-1", runId: "run-1" },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.test.local/v1/keys/provider-requirements",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-API-Key": "test-api-svc-key",
        }),
      }),
    );

    const callBody = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(callBody).toEqual({
      endpoints: [{ service: "chat", method: "POST", path: "/complete" }],
    });

    expect(result.providers).toEqual(["anthropic"]);
  });

  it("throws on 400 (invalid request)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Invalid request"),
    });

    const { checkProviderRequirements } = await loadModule();
    await expect(
      checkProviderRequirements([], { orgId: "o", userId: "u", runId: "r" }),
    ).rejects.toThrow(/returned 400/);
  });
});
