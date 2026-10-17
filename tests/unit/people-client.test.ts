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
  return import("../../src/lib/people-client.js");
}

const params = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const BRAND = "b-1";
const P1 = "p-1";
const P2 = "p-2";

const fetchMock = () => fetch as ReturnType<typeof vi.fn>;
function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) };
}
function sent(i = 0): { url: string; method: string; body: unknown; headers: Record<string, string> } {
  const [url, init] = fetchMock().mock.calls[i];
  return { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers };
}

describe("people-client: find, correct, undo, merge (PEOPLE-CORRECTIONS-1017)", () => {
  it("find_people searches the brand's people and projects each row to its tags and companies", async () => {
    fetchMock().mockResolvedValue(
      reply(200, {
        total: 1,
        nextOffset: null,
        scope: { status: "ready" },
        people: [
          {
            personId: P1,
            displayName: "Mom",
            company: null,
            emails: ["mom@gmail.com"],
            phones: ["+33612345678"],
            sources: ["matrix", "gmail"],
            connectionTags: [{ tag: "personal_to_user", userIds: ["u"], brandId: null, basis: [{ kind: "conversation", ref: "x", probability: 0.9 }] }],
            organizations: [{ companyId: "c-1", domain: "acme.com", evidence: [], tags: [{ tag: "professional_to_brand" }] }],
            presences: [{ big: "x".repeat(5000) }],
            mergeEvidence: [{ big: true }],
            lastActivityAt: "2026-10-16T00:00:00Z",
          },
        ],
      }),
    );
    const { findPeople } = await loadModule();
    const out = await findPeople({ brandId: BRAND, query: "Mom" }, params);
    expect(sent().url).toBe("https://api.test.local/v1/orgs/people?brandId=b-1&limit=5&offset=0&q=Mom");
    expect(sent().method).toBe("GET");
    expect(sent().headers).toEqual(expect.objectContaining({ "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-1" }));
    expect(out).toEqual({
      total: 1,
      nextOffset: null,
      building: undefined,
      people: [
        {
          personId: P1,
          name: "Mom",
          company: null,
          emails: ["mom@gmail.com"],
          phones: ["+33612345678"],
          channels: ["matrix", "gmail"],
          tags: ["personal_to_user"],
          organizations: [{ companyId: "c-1", domain: "acme.com", tags: ["professional_to_brand"] }],
          lastActivityAt: "2026-10-16T00:00:00Z",
        },
      ],
    });
    expect(JSON.stringify(out)).not.toContain("xxxxx");
  });

  it("find_people refuses a page above 10 before any call", async () => {
    const { findPeople } = await loadModule();
    await expect(findPeople({ brandId: BRAND, limit: 50 }, params)).rejects.toThrow(/limit/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("correct_person states a tag change with only that kind's fields and the user's words", async () => {
    fetchMock().mockResolvedValue(
      reply(201, { correction: { correctionId: "k-1", kind: "tag_add", personId: P1, target: { tag: "professional_to_brand" }, reason: "a client", statedByUserId: "user-1", createdAt: "t", undoneAt: null, undoneByUserId: null }, duplicate: false, rebuild: "started" }),
    );
    const { correctPerson } = await loadModule();
    const out = await correctPerson(
      { brandId: BRAND, kind: "tag_add", personId: P1, tag: "professional_to_brand", domain: "ignored.com", reason: "Mom is a client of mine, not family" },
      params,
    );
    expect(sent().url).toBe("https://api.test.local/v1/orgs/people/corrections");
    expect(sent().method).toBe("POST");
    expect(sent().body).toEqual({ brandId: BRAND, kind: "tag_add", personId: P1, tag: "professional_to_brand", reason: "Mom is a client of mine, not family" });
    expect(out).toEqual({
      correction: { correctionId: "k-1", kind: "tag_add", personId: P1, target: { tag: "professional_to_brand" }, reason: "a client", createdAt: "t", undone: false },
      duplicate: false,
      rebuild: "started",
    });
  });

  it("correct_person sends each kind's own fields", async () => {
    fetchMock().mockResolvedValue(reply(201, { correction: {}, duplicate: false, rebuild: "started" }));
    const { correctPerson } = await loadModule();
    await correctPerson({ brandId: BRAND, kind: "organization_add", personId: P1, domain: "acme.com", tags: ["professional_to_brand"] }, params);
    await correctPerson({ brandId: BRAND, kind: "organization_remove", personId: P1, companyId: "c-1" }, params);
    await correctPerson({ brandId: BRAND, kind: "domain_kind", domain: "mybiz.co", domainKind: "organization" }, params);
    expect(sent(0).body).toEqual({ brandId: BRAND, kind: "organization_add", personId: P1, domain: "acme.com", tags: ["professional_to_brand"] });
    expect(sent(1).body).toEqual({ brandId: BRAND, kind: "organization_remove", personId: P1, companyId: "c-1" });
    expect(sent(2).body).toEqual({ brandId: BRAND, kind: "domain_kind", domain: "mybiz.co", domainKind: "organization" });
  });

  it("correct_person refuses a missing or unknown field before any call", async () => {
    const { correctPerson } = await loadModule();
    await expect(correctPerson({ brandId: BRAND, kind: "tag_add", personId: P1 }, params)).rejects.toThrow(/tag must be one of/);
    await expect(correctPerson({ brandId: BRAND, kind: "rename" }, params)).rejects.toThrow(/kind must be one of/);
    await expect(correctPerson({ brandId: BRAND, kind: "organization_remove", personId: P1 }, params)).rejects.toThrow(/companyId/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  for (const [status, reason] of [[404, "person_not_found"], [422, "company_unresolved"], [409, "already_one_person"]] as const) {
    it(`a crm-service ${status} ${reason} refusal comes back readable, never thrown`, async () => {
      fetchMock().mockResolvedValue(reply(status, { type: "refused", reason, error: `refused because ${reason}` }));
      const { correctPerson } = await loadModule();
      const out = await correctPerson({ brandId: BRAND, kind: "organization_add", personId: P1, domain: "acme.com" }, params);
      expect(out).toEqual({ refused: true, status, reason, error: `refused because ${reason}` });
    });
  }

  it("any other failure still throws", async () => {
    fetchMock().mockResolvedValue(reply(502, { error: "crm down" }));
    const { correctPerson } = await loadModule();
    await expect(correctPerson({ brandId: BRAND, kind: "tag_remove", personId: P1, tag: "personal_to_user" }, params)).rejects.toThrow(/502/);
  });

  it("list_people_corrections reads corrections and merges, active ones by default", async () => {
    fetchMock().mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("/corrections")
          ? reply(200, { corrections: [{ correctionId: "k-1", kind: "tag_add", undoneAt: null }, { correctionId: "k-0", kind: "tag_add", undoneAt: "t" }] })
          : reply(200, { merges: [{ mergeId: "m-1", personIds: [P1, P2], active: true, undoneAt: null, applied: true, personId: P1, statedAt: "t" }] }),
      ),
    );
    const { listPeopleCorrections } = await loadModule();
    const out = await listPeopleCorrections({ brandId: BRAND }, params);
    const urls = fetchMock().mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual(["https://api.test.local/v1/orgs/people/corrections?brandId=b-1", "https://api.test.local/v1/orgs/people/merges?brandId=b-1"]);
    expect(out.corrections.map((c: { correctionId: unknown }) => c.correctionId)).toEqual(["k-1"]);
    expect(out.merges).toEqual([{ mergeId: "m-1", personIds: [P1, P2], reason: null, statedAt: "t", undone: false, applied: true, personId: P1 }]);
  });

  it("undo_people_correction posts the brand to the correction's undo", async () => {
    fetchMock().mockResolvedValue(reply(200, { correction: { correctionId: "k-1", undoneAt: "t" }, duplicate: false, rebuild: "started" }));
    const { undoPeopleCorrection } = await loadModule();
    const out = await undoPeopleCorrection({ brandId: BRAND, correctionId: "k-1" }, params);
    expect(sent().url).toBe("https://api.test.local/v1/orgs/people/corrections/k-1/undo");
    expect(sent().body).toEqual({ brandId: BRAND });
    expect(out).toEqual(expect.objectContaining({ duplicate: false, rebuild: "started" }));
    expect((out as { correction: { undone: boolean } }).correction.undone).toBe(true);
  });

  it("merge_people states exactly two people; undo_people_merge splits them", async () => {
    fetchMock().mockResolvedValue(reply(201, { merge: { mergeId: "m-1", personIds: [P1, P2], active: true, undoneAt: null }, duplicate: false, applied: false, personId: null, rebuild: "started" }));
    const { mergePeople, undoPeopleMerge } = await loadModule();
    await expect(mergePeople({ brandId: BRAND, personIds: [P1] }, params)).rejects.toThrow(/exactly two/);
    await mergePeople({ brandId: BRAND, personIds: [P1, P2], reason: "same person" }, params);
    expect(sent(0).url).toBe("https://api.test.local/v1/orgs/people/merges");
    expect(sent(0).body).toEqual({ brandId: BRAND, personIds: [P1, P2], reason: "same person" });
    await undoPeopleMerge({ brandId: BRAND, mergeId: "m-1" }, params);
    expect(sent(1).url).toBe("https://api.test.local/v1/orgs/people/merges/m-1/undo");
    expect(sent(1).body).toEqual({ brandId: BRAND });
  });

  it("every people tool is registered for the model, dispatched, and mapped to its gateway operation", async () => {
    const { PEOPLE_TOOL_HANDLERS } = await loadModule();
    const { TOOL_REGISTRY } = await import("../../src/lib/anthropic.js");
    const { COPILOT_TOOL_API_OPS } = await import("../../src/lib/skill-api-ops.js");
    const names = Object.keys(PEOPLE_TOOL_HANDLERS);
    expect(names.sort()).toEqual(
      ["correct_person", "find_people", "list_people_corrections", "list_people_organizations", "merge_people", "undo_people_correction", "undo_people_merge"],
    );
    for (const n of names) {
      expect(TOOL_REGISTRY[n]?.name).toBe(n);
      expect(COPILOT_TOOL_API_OPS[n]?.length).toBeGreaterThan(0);
    }
    // Writes say they act only on the user's word.
    expect(TOOL_REGISTRY.correct_person.description).toMatch(/only correct what the user explicitly told you/);
  });
});
