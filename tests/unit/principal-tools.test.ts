import { describe, it, expect, vi } from "vitest";
import {
  principalToolsAllowed,
  withoutPrincipalToolsUnlessAllowed,
  isPrincipalToolName,
  findStakeholders,
  readPersonUnibox,
  readOrganizationUnibox,
  ENGINES_TOOL_FAMILY,
  ENGINE_TOOL_PREFIX,
  READ_COMPANY_FINANCIALS_TOOL_NAME,
  STAKEHOLDER_TOOL_NAMES,
} from "../../src/agent/principal-tools.js";
import { sessionToolNamesFor } from "../../src/agent/person-tools.js";
import { SOPHIE_TOOLS } from "../../src/agent/sophie.js";
import { resolveToolSet } from "../../src/lib/anthropic.js";

const PRINCIPAL = [...STAKEHOLDER_TOOL_NAMES, READ_COMPANY_FINANCIALS_TOOL_NAME, ENGINES_TOOL_FAMILY, `${ENGINE_TOOL_PREFIX}linkedin_post_published`];

describe("Distry's principal tools load only in a staff conversation (DISTRY-PRINCIPAL-1119)", () => {
  const staff = { requesterIsStaff: true, guest: false, leadTurn: false, proactive: false };

  it("staff talking for themselves hold them", () => {
    expect(principalToolsAllowed(staff)).toBe(true);
    expect(withoutPrincipalToolsUnlessAllowed([...SOPHIE_TOOLS, ...PRINCIPAL], true)).toEqual([...SOPHIE_TOOLS, ...PRINCIPAL]);
  });

  it("a client or a prospect never holds a finance, Engine or cross-client tool", () => {
    expect(principalToolsAllowed({ ...staff, requesterIsStaff: false })).toBe(false);
    const kept = withoutPrincipalToolsUnlessAllowed([...SOPHIE_TOOLS, ...PRINCIPAL], false);
    for (const t of PRINCIPAL) expect(kept).not.toContain(t);
    expect(kept).toContain("run_operation");
  });

  it("a guest turn (run under our own identity, a staff user included), a Lead event and a proactive turn never do", () => {
    expect(principalToolsAllowed({ ...staff, guest: true })).toBe(false);
    expect(principalToolsAllowed({ ...staff, leadTurn: true })).toBe(false);
    expect(principalToolsAllowed({ ...staff, proactive: true })).toBe(false);
    // The guest list never carries them anyway.
    expect(sessionToolNamesFor({ configTools: [...SOPHIE_TOOLS, ...PRINCIPAL], guest: true, canSignIn: true, website: true }).some(isPrincipalToolName)).toBe(false);
  });

  it("Distry's code definition lists the stakeholder tools, and the registry declares them", () => {
    for (const t of STAKEHOLDER_TOOL_NAMES) expect(SOPHIE_TOOLS).toContain(t);
    expect(resolveToolSet([...STAKEHOLDER_TOOL_NAMES]).map((t) => t.name)).toEqual([...STAKEHOLDER_TOOL_NAMES]);
  });
});

describe("stakeholder reads: our own Unibox, compact", () => {
  const account = { orgId: "org-us", userId: "user-us", brandId: "11111111-1111-1111-1111-111111111111" };
  const person = (id: string, name: string, company: string, email: string) => ({
    personId: id, displayName: name, company, emails: [email], phones: [], state: "client", humanTags: [], connectionTags: ["client"], sources: ["gmail"], lastActivityAt: "2026-11-18T10:00:00Z", relations: [{ big: "x".repeat(5000) }],
  });

  it("find_stakeholders searches our brand's people and keeps who they are (no 5k rows)", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (path: string, params: { orgId: string; runId: string }) => {
      calls.push(`${params.orgId} ${params.runId} ${path}`);
      return new Response(JSON.stringify({ total: 1, people: [person("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Ada", "Acme", "ada@acme.com")] }));
    });
    const out = await findStakeholders({ query: "acme" }, { account, runId: async () => "run-1", fetch });
    expect(calls[0]).toBe(`org-us run-1 /v1/orgs/people?brandId=${account.brandId}&q=acme&limit=10`);
    expect(out.people[0]).toMatchObject({ name: "Ada", company: "Acme", state: "client" });
    expect(JSON.stringify(out).length).toBeLessThan(1000);
  });

  it("read_person_unibox reads the whole thread by email, without API call logs, and cuts long texts", async () => {
    let seen = "";
    const fetch = vi.fn(async (path: string) => {
      seen = path;
      return new Response(JSON.stringify({ person: person("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Ada", "Acme", "ada@acme.com"), items: [{ at: "2026-11-18T10:00:00Z", channel: "email", kind: "message", direction: "inbound", subject: "Hi", text: "y".repeat(2000), event: null }], page: { hasOlder: true }, totalItems: 90 }));
    });
    const out = await readPersonUnibox({ email: "Ada@Acme.com" }, { account, runId: async () => "run-1", fetch });
    expect(seen).toContain("personKey=email%3Aada%40acme.com");
    expect(seen).toContain("excludeSources=api");
    expect(out).toMatchObject({ found: true, olderItemsExist: true, totalItems: 90 });
    expect(String((out as { items: Array<{ text: string }> }).items[0].text).length).toBeLessThan(760);
  });

  it("read_person_unibox says a person is unknown on a 404, and fails loud on a 5xx", async () => {
    const notFound = vi.fn(async () => new Response("{}", { status: 404 }));
    expect(await readPersonUnibox({ phone: "33612345678" }, { account, runId: async () => "r", fetch: notFound })).toMatchObject({ found: false });
    const broken = vi.fn(async () => new Response("boom", { status: 502 }));
    await expect(readPersonUnibox({ phone: "+33612345678" }, { account, runId: async () => "r", fetch: broken })).rejects.toThrow(/timeline read 502/);
    await expect(readPersonUnibox({}, { account, runId: async () => "r", fetch: broken })).rejects.toThrow(/name the person/);
  });

  it("read_organization_unibox merges the threads of the people who speak for it, by date", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path.startsWith("/v1/orgs/people?")) {
        return new Response(JSON.stringify({ people: [
          person("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Ada", "Acme", "ada@acme.com"),
          person("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "Bob", "Acme Inc", "bob@acme.com"),
          person("cccccccc-cccc-cccc-cccc-cccccccccccc", "Cy", "Other", "cy@other.io"),
        ] }));
      }
      const at = path.includes("aaaaaaaa") ? "2026-11-02T00:00:00Z" : "2026-11-01T00:00:00Z";
      return new Response(JSON.stringify({ items: [{ at, channel: "email", kind: "message", direction: "inbound", text: "hello", event: null }] }));
    });
    const out = await readOrganizationUnibox({ organization: "acme" }, { account, runId: async () => "r", fetch });
    expect(out.people.map((p) => p.name)).toEqual(["Ada", "Bob"]);
    expect(out.items.map((i) => i.person)).toEqual(["Bob", "Ada"]);
  });
});
