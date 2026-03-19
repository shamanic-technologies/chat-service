import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

