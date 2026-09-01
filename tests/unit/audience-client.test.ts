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

describe("suggestAudiences", () => {
  it("includes offerId in the body when an offer is in scope (offer-scoped page)", async () => {
    fetchMock().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ candidates: [] }),
    });
    const { suggestAudiences } = await loadModule();

    await suggestAudiences("b-1", "founders in FR", baseParams, "offer-9");

    expect(lastCall()[0]).toBe(
      "https://api.test.local/v1/orgs/audiences/suggest",
    );
    expect(lastCall()[1].method).toBe("POST");
    expect(JSON.parse(lastCall()[1].body)).toEqual({
      brandId: "b-1",
      nlPrompt: "founders in FR",
      offerId: "offer-9",
    });
  });

  it("omits offerId entirely when no offer is in scope (brand-wide, byte-identical to before)", async () => {
    fetchMock().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ candidates: [] }),
    });
    const { suggestAudiences } = await loadModule();

    await suggestAudiences("b-1", "founders in FR", baseParams);

    const body = JSON.parse(lastCall()[1].body);
    expect(body).toEqual({ brandId: "b-1", nlPrompt: "founders in FR" });
    expect("offerId" in body).toBe(false);
  });

  it("never invents an offer from an empty-string context value", async () => {
    fetchMock().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ candidates: [] }),
    });
    const { suggestAudiences } = await loadModule();

    await suggestAudiences("b-1", "founders", baseParams, "");

    expect("offerId" in JSON.parse(lastCall()[1].body)).toBe(false);
  });

  it("throws AudienceError (fail-loud) on a non-OK response", async () => {
    fetchMock().mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve("apollo build failed"),
    });
    const { suggestAudiences, AudienceError } = await loadModule();

    const err = await suggestAudiences("b-1", "founders", baseParams, "offer-9").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(AudienceError);
    expect(err.status).toBe(502);
    expect(err.operation).toBe("suggest audiences");
  });
});
