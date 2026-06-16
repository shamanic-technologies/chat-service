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
  return import("../../src/lib/brand-content-client.js");
}

const baseParams = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const BRAND = "b-123";

function persona(overrides: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    brandId: BRAND,
    name: "Founders",
    filters: { jobTitle: ["Founder"] },
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const fetchMock = () => fetch as ReturnType<typeof vi.fn>;
const lastCall = () => fetchMock().mock.calls[0];

describe("listPersonas", () => {
  it("GETs /v1/brands/:id/personas with identity headers, no status query when omitted", async () => {
    fetchMock().mockResolvedValue({ ok: true, json: () => Promise.resolve({ personas: [persona()] }) });
    const { listPersonas } = await loadModule();

    const result = await listPersonas(BRAND, undefined, baseParams);

    expect(lastCall()[0]).toBe("https://api.test.local/v1/brands/b-123/personas");
    expect(lastCall()[1].method).toBe("GET");
    expect(lastCall()[1].headers).toMatchObject({
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-run-id": "run-1",
    });
    expect(result.personas).toHaveLength(1);
  });

  it("forwards the status filter as a query string", async () => {
    fetchMock().mockResolvedValue({ ok: true, json: () => Promise.resolve({ personas: [] }) });
    const { listPersonas } = await loadModule();

    await listPersonas(BRAND, "archived", baseParams);

    expect(lastCall()[0]).toBe("https://api.test.local/v1/brands/b-123/personas?status=archived");
  });

  it("throws BrandContentError on non-OK", async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve("forbidden") });
    const { listPersonas, BrandContentError } = await loadModule();

    const err = await listPersonas(BRAND, undefined, baseParams).catch((e) => e);
    expect(err).toBeInstanceOf(BrandContentError);
    expect(err.status).toBe(403);
  });
});

describe("createPersona", () => {
  it("POSTs name + filters and returns created persona on 201", async () => {
    fetchMock().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ persona: persona() }) });
    const { createPersona } = await loadModule();

    const result = await createPersona(BRAND, "Founders", { jobTitle: ["Founder"] }, baseParams);

    expect(lastCall()[0]).toBe("https://api.test.local/v1/brands/b-123/personas");
    expect(lastCall()[1].method).toBe("POST");
    expect(JSON.parse(lastCall()[1].body)).toEqual({ name: "Founders", filters: { jobTitle: ["Founder"] } });
    expect(result).toEqual({ created: true, persona: persona() });
  });

  it("returns name_taken (NOT a throw) on 409", async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 409, text: () => Promise.resolve("dup") });
    const { createPersona } = await loadModule();

    const result = await createPersona(BRAND, "Founders", {}, baseParams);
    expect(result).toEqual({ created: false, reason: "name_taken", name: "Founders" });
  });

  it("throws BrandContentError on a non-409 failure", async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("boom") });
    const { createPersona, BrandContentError } = await loadModule();

    const err = await createPersona(BRAND, "X", {}, baseParams).catch((e) => e);
    expect(err).toBeInstanceOf(BrandContentError);
    expect(err.status).toBe(500);
  });
});

describe("duplicatePersona", () => {
  it("POSTs to /duplicate with name when supplied", async () => {
    fetchMock().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ persona: persona({ name: "Founders (copy)" }) }) });
    const { duplicatePersona } = await loadModule();

    await duplicatePersona(BRAND, "p-1", "Founders (copy)", baseParams);

    expect(lastCall()[0]).toBe("https://api.test.local/v1/brands/b-123/personas/p-1/duplicate");
    expect(JSON.parse(lastCall()[1].body)).toEqual({ name: "Founders (copy)" });
  });

  it("sends an empty body when name is omitted", async () => {
    fetchMock().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ persona: persona() }) });
    const { duplicatePersona } = await loadModule();

    await duplicatePersona(BRAND, "p-1", undefined, baseParams);
    expect(JSON.parse(lastCall()[1].body)).toEqual({});
  });
});

describe("setPersonaStatus", () => {
  it("PATCHes /status with the new status", async () => {
    fetchMock().mockResolvedValue({ ok: true, json: () => Promise.resolve({ persona: persona({ status: "archived" }) }) });
    const { setPersonaStatus } = await loadModule();

    const result = await setPersonaStatus(BRAND, "p-1", "archived", baseParams);

    expect(lastCall()[0]).toBe("https://api.test.local/v1/brands/b-123/personas/p-1/status");
    expect(lastCall()[1].method).toBe("PATCH");
    expect(JSON.parse(lastCall()[1].body)).toEqual({ status: "archived" });
    expect(result.persona.status).toBe("archived");
  });

  it("throws BrandContentError on 404", async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve("nope") });
    const { setPersonaStatus, BrandContentError } = await loadModule();
    const err = await setPersonaStatus(BRAND, "p-x", "paused", baseParams).catch((e) => e);
    expect(err).toBeInstanceOf(BrandContentError);
    expect(err.status).toBe(404);
  });
});

describe("getBrandProfile / saveBrandProfileVersion", () => {
  it("GETs /brand-profile", async () => {
    const body = { current: { id: "v2", brandId: BRAND, version: 2, fields: { valueProposition: "x" }, createdAt: "t" }, versions: [] };
    fetchMock().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) });
    const { getBrandProfile } = await loadModule();

    const result = await getBrandProfile(BRAND, baseParams);
    expect(lastCall()[0]).toBe("https://api.test.local/v1/brands/b-123/brand-profile");
    expect(lastCall()[1].method).toBe("GET");
    expect(result.current?.version).toBe(2);
  });

  it("POSTs the full fields map to /brand-profile", async () => {
    fetchMock().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ version: { id: "v3", brandId: BRAND, version: 3, fields: {}, createdAt: "t" } }) });
    const { saveBrandProfileVersion } = await loadModule();

    const result = await saveBrandProfileVersion(BRAND, { valueProposition: "new", tags: ["a", "b"] }, baseParams);
    expect(lastCall()[1].method).toBe("POST");
    expect(JSON.parse(lastCall()[1].body)).toEqual({ fields: { valueProposition: "new", tags: ["a", "b"] } });
    expect(result.version.version).toBe(3);
  });
});

describe("buildPersonaFilters", () => {
  it("maps array-of-pairs to a Record<string,string[]>", async () => {
    const { buildPersonaFilters } = await loadModule();
    expect(
      buildPersonaFilters([
        { attribute: "jobTitle", values: ["RevOps", "Head of RevOps"] },
        { attribute: "industry", values: ["SaaS"] },
      ]),
    ).toEqual({ jobTitle: ["RevOps", "Head of RevOps"], industry: ["SaaS"] });
  });

  it("returns {} for undefined/non-array and skips malformed entries", async () => {
    const { buildPersonaFilters } = await loadModule();
    expect(buildPersonaFilters(undefined)).toEqual({});
    expect(
      buildPersonaFilters([{ attribute: "ok", values: ["v"] }, { values: ["x"] } as never]),
    ).toEqual({ ok: ["v"] });
  });
});

describe("applyBrandProfileChanges", () => {
  it("set replaces a free-text field and preserves unchanged fields", async () => {
    const { applyBrandProfileChanges } = await loadModule();
    const out = applyBrandProfileChanges(
      { valueProposition: "old", tone: "formal" },
      [{ field: "valueProposition", operation: "set", value: "new VP" }],
    );
    expect(out).toEqual({ valueProposition: "new VP", tone: "formal" });
  });

  it("setList replaces a list field", async () => {
    const { applyBrandProfileChanges } = await loadModule();
    const out = applyBrandProfileChanges(
      { differentiators: ["a"] },
      [{ field: "differentiators", operation: "setList", values: ["x", "y"] }],
    );
    expect(out).toEqual({ differentiators: ["x", "y"] });
  });

  it("add appends to a list, dedups, and coerces a scalar to a list", async () => {
    const { applyBrandProfileChanges } = await loadModule();
    expect(
      applyBrandProfileChanges({ tags: ["a"] }, [
        { field: "tags", operation: "add", value: "b" },
        { field: "tags", operation: "add", value: "a" },
      ]),
    ).toEqual({ tags: ["a", "b"] });
    // scalar → list coercion
    expect(
      applyBrandProfileChanges({ tags: "solo" }, [{ field: "tags", operation: "add", value: "more" }]),
    ).toEqual({ tags: ["solo", "more"] });
  });

  it("remove deletes a value from a list", async () => {
    const { applyBrandProfileChanges } = await loadModule();
    expect(
      applyBrandProfileChanges({ tags: ["a", "b", "c"] }, [{ field: "tags", operation: "remove", value: "b" }]),
    ).toEqual({ tags: ["a", "c"] });
  });

  it("does not mutate the input object", async () => {
    const { applyBrandProfileChanges } = await loadModule();
    const input = { tags: ["a"] };
    applyBrandProfileChanges(input, [{ field: "tags", operation: "add", value: "b" }]);
    expect(input).toEqual({ tags: ["a"] });
  });
});
