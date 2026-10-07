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
  return import("../../src/lib/qualification-client.js");
}

const params = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const BASE = "https://api.test.local/v1/brands/b-1/offers/o-1/qualification";

function criterion(overrides: Record<string, unknown> = {}) {
  return {
    id: "c-1",
    offerId: "o-1",
    question: "Is their site slow on mobile?",
    why: "Slow sites lose buyers",
    mode: "must_pass",
    enabled: true,
    origin: "suggested",
    availability: "custom_check",
    source: "Homepage screenshot",
    probe: { kind: "treg" },
    estimate: { perRowUsd: 0.02, probeUsd: 0.01, aiUsd: 0.01, storageUsd: 0 },
    passRate: { checked: 10, yes: 4, no: 5, unavailable: 1, passRate: 0.4 },
    createdAt: "2026-10-07T00:00:00Z",
    updatedAt: null,
    ...overrides,
  };
}

const fetchMock = () => fetch as ReturnType<typeof vi.fn>;
const call = (i = 0) => fetchMock().mock.calls[i];
const ok = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) });

describe("qualification-client", () => {
  it("lists checks in customer words (Hard filter / Bonus), never the internal mode", async () => {
    fetchMock().mockResolvedValue(
      ok({ criteria: [criterion(), criterion({ id: "c-2", mode: "mention", enabled: false, origin: "custom" })] }),
    );
    const { listChecks } = await loadModule();
    const { checks } = await listChecks("b-1", "o-1", params);

    expect(call()[0]).toBe(`${BASE}/criteria`);
    expect(call()[1].method).toBe("GET");
    expect(call()[1].headers).toMatchObject({ "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" });
    expect(checks[0]).toEqual({
      checkId: "c-1",
      question: "Is their site slow on mobile?",
      why: "Slow sites lose buyers",
      role: "Hard filter",
      on: true,
      suggestedByAi: true,
      source: "Homepage screenshot",
      costPerLeadUsd: 0.02,
      passRate: 0.4,
      companiesChecked: 10,
    });
    expect(checks[1]).toMatchObject({ role: "Bonus", on: false, suggestedByAi: false });
    expect(JSON.stringify(checks)).not.toMatch(/must_pass|mention/);
  });

  it("creates a check with a builtin probe and the role mapped to its mode", async () => {
    fetchMock().mockResolvedValue(ok({ criterion: criterion({ mode: "mention", enabled: false }) }));
    const { createCheck } = await loadModule();
    const { check } = await createCheck(
      "b-1",
      "o-1",
      { question: "Do they have no newsletter?", source: "homepage_text", role: "bonus", on: false },
      params,
    );
    expect(call()[0]).toBe(`${BASE}/criteria`);
    expect(call()[1].method).toBe("POST");
    expect(JSON.parse(call()[1].body)).toEqual({
      question: "Do they have no newsletter?",
      probe: { builtin: "homepage_text" },
      mode: "mention",
      enabled: false,
    });
    expect(check.role).toBe("Bonus");
  });

  it("rejects an unknown source before calling the gateway", async () => {
    const { createCheck } = await loadModule();
    await expect(
      createCheck("b-1", "o-1", { question: "q", source: "nope" as never, role: "bonus", on: false }, params),
    ).rejects.toThrow(/unknown source/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("updates on/off and role only — never the question", async () => {
    fetchMock().mockResolvedValue(ok({ criterion: criterion() }));
    const { updateCheck } = await loadModule();
    await updateCheck("b-1", "o-1", "c-1", { on: true, role: "hard_filter" }, params);
    expect(call()[0]).toBe(`${BASE}/criteria/c-1`);
    expect(call()[1].method).toBe("PATCH");
    expect(JSON.parse(call()[1].body)).toEqual({ enabled: true, mode: "must_pass" });
  });

  it("refuses an empty update", async () => {
    const { updateCheck } = await loadModule();
    await expect(updateCheck("b-1", "o-1", "c-1", {}, params)).rejects.toThrow(/needs `on` or `role`/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("exposes no question-edit function", async () => {
    const mod = await loadModule();
    expect(Object.keys(mod).filter((k) => /reword|rename|editQuestion|setQuestion/i.test(k))).toEqual([]);
  });

  it("archives via DELETE", async () => {
    fetchMock().mockResolvedValue(ok({}));
    const { archiveCheck } = await loadModule();
    expect(await archiveCheck("b-1", "o-1", "c-1", params)).toEqual({ archived: true, checkId: "c-1" });
    expect(call()[0]).toBe(`${BASE}/criteria/c-1`);
    expect(call()[1].method).toBe("DELETE");
  });

  it("suggests via POST and returns the skipped list", async () => {
    fetchMock().mockResolvedValue(
      ok({ criteria: [criterion({ enabled: false })], dropped: [{ question: "x", reason: "already_asked" }], runId: "r" }),
    );
    const { suggestChecks } = await loadModule();
    const out = await suggestChecks("b-1", "o-1", params);
    expect(call()[0]).toBe(`${BASE}/suggestions`);
    expect(call()[1].method).toBe("POST");
    expect(out.checks[0].on).toBe(false);
    expect(out.skipped).toEqual([{ question: "x", reason: "already_asked" }]);
  });

  it("maps the catalogue to sources with cost per lead", async () => {
    fetchMock().mockResolvedValue(
      ok({
        probes: [
          {
            key: "job_postings",
            source: "Job postings",
            description: "Open roles",
            availability: "custom_check",
            estimate: { perRowUsd: 0.03, probeUsd: 0.02, aiUsd: 0.01, storageUsd: 0 },
          },
        ],
      }),
    );
    const { listCheckSources } = await loadModule();
    const out = await listCheckSources(params);
    expect(call()[0]).toBe("https://api.test.local/v1/qualification/catalog");
    expect(out.sources).toEqual([
      { source: "job_postings", label: "Job postings", description: "Open roles", costPerLeadUsd: 0.03 },
    ]);
  });

  it("fails loud with the upstream status and body", async () => {
    fetchMock().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve("offer not found") });
    const { listChecks, QualificationError } = await loadModule();
    const err = await listChecks("b-1", "o-1", params).catch((e) => e);
    expect(err).toBeInstanceOf(QualificationError);
    expect(err.message).toMatch(/404.*offer not found/);
  });
});
