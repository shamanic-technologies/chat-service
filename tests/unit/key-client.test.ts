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

describe("decryptAppKey", () => {
  it("sends GET with correct URL, query params, and caller headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ provider: "gemini", key: "decrypted-key" }),
    });

    const { decryptAppKey } = await loadModule();
    const result = await decryptAppKey("gemini", "chat", {
      method: "POST",
      path: "/chat",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://key.test.local/internal/app-keys/gemini/decrypt?appId=chat",
      expect.objectContaining({
        method: "GET",
        headers: {
          "x-api-key": "test-key-svc-key",
          "X-Caller-Service": "chat",
          "X-Caller-Method": "POST",
          "X-Caller-Path": "/chat",
        },
      }),
    );
    expect(result).toEqual({ provider: "gemini", key: "decrypted-key" });
  });

  it("throws on HTTP 404 (key not configured)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Key not configured"),
    });

    const { decryptAppKey } = await loadModule();
    await expect(
      decryptAppKey("gemini", "chat", { method: "POST", path: "/chat" }),
    ).rejects.toThrow(/returned 404/);
  });

  it("throws on HTTP 400 (missing caller headers)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Missing required caller headers"),
    });

    const { decryptAppKey } = await loadModule();
    await expect(
      decryptAppKey("gemini", "chat", { method: "POST", path: "/chat" }),
    ).rejects.toThrow(/returned 400/);
  });

  it("throws on HTTP 500 (server error)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const { decryptAppKey } = await loadModule();
    await expect(
      decryptAppKey("gemini", "chat", { method: "POST", path: "/chat" }),
    ).rejects.toThrow(/returned 500/);
  });

  it("throws on network error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    const { decryptAppKey } = await loadModule();
    await expect(
      decryptAppKey("gemini", "chat", { method: "POST", path: "/chat" }),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("throws when KEY_SERVICE_API_KEY is not set", async () => {
    delete process.env.KEY_SERVICE_API_KEY;

    const { decryptAppKey } = await loadModule();
    await expect(
      decryptAppKey("gemini", "chat", { method: "POST", path: "/chat" }),
    ).rejects.toThrow(/KEY_SERVICE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses default KEY_SERVICE_URL when not set", async () => {
    delete process.env.KEY_SERVICE_URL;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "gemini", key: "key-123" }),
    });

    const { decryptAppKey } = await loadModule();
    await decryptAppKey("gemini", "chat", { method: "POST", path: "/chat" });

    expect(fetch).toHaveBeenCalledWith(
      "https://key.mcpfactory.org/internal/app-keys/gemini/decrypt?appId=chat",
      expect.anything(),
    );
  });
});

describe("decryptOrgKey", () => {
  it("sends GET with correct URL including orgId query param", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ provider: "mcpfactory", key: "org-mcp-key" }),
    });

    const { decryptOrgKey } = await loadModule();
    const result = await decryptOrgKey("mcpfactory", "org-uuid-123", {
      method: "POST",
      path: "/chat",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://key.test.local/internal/keys/mcpfactory/decrypt?orgId=org-uuid-123",
      expect.objectContaining({
        method: "GET",
        headers: {
          "x-api-key": "test-key-svc-key",
          "X-Caller-Service": "chat",
          "X-Caller-Method": "POST",
          "X-Caller-Path": "/chat",
        },
      }),
    );
    expect(result).toEqual({ provider: "mcpfactory", key: "org-mcp-key" });
  });

  it("throws on HTTP 404 (org key not configured)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Key not configured for this org"),
    });

    const { decryptOrgKey } = await loadModule();
    await expect(
      decryptOrgKey("mcpfactory", "org-123", {
        method: "POST",
        path: "/chat",
      }),
    ).rejects.toThrow(/returned 404/);
  });

  it("throws when KEY_SERVICE_API_KEY is not set", async () => {
    delete process.env.KEY_SERVICE_API_KEY;

    const { decryptOrgKey } = await loadModule();
    await expect(
      decryptOrgKey("mcpfactory", "org-123", {
        method: "POST",
        path: "/chat",
      }),
    ).rejects.toThrow(/KEY_SERVICE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });
});
