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
  return import("../../src/lib/audience-client.js");
}

const baseParams = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const AUDIENCE = "aud-123";

function audience(overrides: Record<string, unknown> = {}) {
  return {
    id: AUDIENCE,
    orgId: "org-1",
    brandId: "b-1",
    name: "Founders",
    status: "active",
    avatarUrl: "https://img.test/new.png",
    ...overrides,
  };
}

const fetchMock = () => fetch as ReturnType<typeof vi.fn>;
const lastCall = () => fetchMock().mock.calls[0];

describe("generateAudienceAvatar", () => {
  it("POSTs /v1/orgs/audiences/:id/avatar with identity headers and a body when a prompt is given (org-billed)", async () => {
    fetchMock().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ audience: audience() }),
    });
    const { generateAudienceAvatar } = await loadModule();

    const result = await generateAudienceAvatar(
      AUDIENCE,
      "a confident founder in a startup office",
      baseParams,
    );

    expect(lastCall()[0]).toBe(
      "https://api.test.local/v1/orgs/audiences/aud-123/avatar",
    );
    expect(lastCall()[1].method).toBe("POST");
    // org-billed: x-user-id must be forwarded (same as refresh-count).
    expect(lastCall()[1].headers).toMatchObject({
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-run-id": "run-1",
    });
    expect(JSON.parse(lastCall()[1].body)).toEqual({
      prompt: "a confident founder in a startup office",
    });
    expect(result.audience.avatarUrl).toBe("https://img.test/new.png");
  });

  it("omits the body entirely when no prompt is provided", async () => {
    fetchMock().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ audience: audience() }),
    });
    const { generateAudienceAvatar } = await loadModule();

    await generateAudienceAvatar(AUDIENCE, undefined, baseParams);

    expect(lastCall()[0]).toBe(
      "https://api.test.local/v1/orgs/audiences/aud-123/avatar",
    );
    expect(lastCall()[1].method).toBe("POST");
    expect(lastCall()[1].body).toBeUndefined();
  });

  it("throws AudienceError (fail-loud) on a non-OK response", async () => {
    fetchMock().mockResolvedValue({
      ok: false,
      status: 402,
      text: () => Promise.resolve("insufficient credits"),
    });
    const { generateAudienceAvatar, AudienceError } = await loadModule();

    const err = await generateAudienceAvatar(
      AUDIENCE,
      undefined,
      baseParams,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AudienceError);
    expect(err.status).toBe(402);
    expect(err.operation).toBe("generate audience avatar");
  });
});
