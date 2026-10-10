import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StaffRequestInput, StaffRequestResult } from "../../src/lib/staff-requests.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.FEATURES_SERVICE_URL = "http://features.test";
  process.env.FEATURES_SERVICE_API_KEY = "features-key";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

async function load() {
  vi.resetModules();
  return import("../../src/lib/catalogue-client.js");
}

const ctx = { orgId: "org-1", userId: "user-1" };
const customer = { isStaff: async () => false };
const staff = { isStaff: async () => true };
const fetchMock = () => fetch as ReturnType<typeof vi.fn>;
const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
});
const call = (i: number) => {
  const [url, init] = fetchMock().mock.calls[i] as [string, RequestInit];
  return {
    url,
    method: init.method,
    key: (init.headers as Record<string, string>)["x-api-key"],
    body: init.body ? JSON.parse(init.body as string) : null,
  };
};

function fileMock() {
  const filed: StaffRequestInput[] = [];
  const file = vi.fn(async (input: StaffRequestInput) => {
    filed.push(input);
    return { requestId: `req-${filed.length}`, duplicate: false, issueUrl: "https://x/issues/1" } as unknown as StaffRequestResult;
  });
  return { file, filed };
}

describe("catalogue reads: one tool per level, features-service service key", () => {
  it.each([
    ["find_steps", {}, "/internal/catalogue/steps"],
    ["find_steps", { q: "visit", limit: 5 }, "/internal/catalogue/steps?q=visit&limit=5"],
    ["find_steps", { id: "paid_client" }, "/internal/catalogue/steps/paid_client"],
    ["find_sales_paths", { containsSteps: ["conversation", "meeting_booked"] }, "/internal/catalogue/sales-paths?containsSteps=conversation%2Cmeeting_booked&runnable=true"],
    ["find_sales_paths", { id: "a+b" }, "/internal/catalogue/sales-paths/a%2Bb"],
    ["find_channels", { forPaths: ["a+b"], q: "linkedin" }, "/internal/catalogue/channels?forPaths=a%2Bb&runnable=true&q=linkedin"],
    ["find_pipes", { paths: ["a+b"], channels: ["organic-linkedin-publishing"] }, "/internal/catalogue/pipes?paths=a%2Bb&channels=organic-linkedin-publishing&runnable=true"],
    ["find_pipes", { id: "cold-email|lead_found_to_conversation" }, "/internal/catalogue/pipes/cold-email%7Clead_found_to_conversation"],
    ["find_sales_funnels", { paths: "a+b", containsChannels: ["x"] }, "/internal/catalogue/sales-funnels?paths=a%2Bb&containsChannels=x&runnable=true"],
    ["find_workflows", { pipe: "c|l", limit: 3 }, "/internal/catalogue/workflows?pipe=c%7Cl&limit=3"],
    ["find_workflows", { pipe: "c|l", id: "wf-raven" }, "/internal/catalogue/workflows/wf-raven?pipe=c%7Cl"],
  ])("%s(%j) → GET %s", async (tool, args, path) => {
    fetchMock().mockResolvedValue(res(200, { rows: [] }));
    const { CATALOGUE_READ_TOOLS } = await load();
    expect(await CATALOGUE_READ_TOOLS[tool](args, customer)).toEqual({ rows: [] });
    expect(call(0)).toMatchObject({ url: `http://features.test${path}`, method: "GET", key: "features-key" });
  });

  it("keeps pages small: a limit over 25 is refused before any call", async () => {
    const { CATALOGUE_READ_TOOLS } = await load();
    await expect(CATALOGUE_READ_TOOLS.find_channels({ limit: 100 }, customer)).rejects.toThrow(/1 to 25/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("find_workflows needs a pipe (the owner ranks workflows per pipe)", async () => {
    const { CATALOGUE_READ_TOOLS } = await load();
    await expect(CATALOGUE_READ_TOOLS.find_workflows({}, customer)).rejects.toThrow(/pipe is required/);
  });

  it("a refusal carries the owner's reason to the model", async () => {
    fetchMock().mockResolvedValue(res(400, { error: "no step linkedin_post", reason: "step_not_found" }));
    const { CATALOGUE_READ_TOOLS } = await load();
    await expect(CATALOGUE_READ_TOOLS.find_sales_paths({ containsSteps: ["linkedin_post"] }, customer)).rejects.toThrow(/step_not_found/);
  });
});

describe("catalogue creates", () => {
  it("create_step stamps the requester and the org, forwards only the step fields", async () => {
    fetchMock().mockResolvedValue(res(201, { object: "step", id: "linkedin_follow" }));
    const { CATALOGUE_WRITE_TOOLS } = await load();
    const { file } = fileMock();
    await CATALOGUE_WRITE_TOOLS.create_step(
      { key: "linkedin_follow", label: "LinkedIn follow", description: "d", shortDescription: "s", icon: "user-plus", towardStep: "conversation", towardRatePct: 5, published: true },
      ctx,
      file,
      customer,
    );
    expect(call(0)).toMatchObject({ url: "http://features.test/internal/catalogue/steps", method: "POST" });
    expect(call(0).body).toEqual({
      key: "linkedin_follow", label: "LinkedIn follow", description: "d", shortDescription: "s", icon: "user-plus",
      towardStep: "conversation", towardRatePct: 5, createdBy: "user-1", requestedByOrgId: "org-1",
    });
  });

  it("create_pipe: a DRAFT pipe files the publish request itself and reports on hold", async () => {
    fetchMock().mockResolvedValue(
      res(201, { object: "pipe", id: "organic-linkedin-publishing|start_to_website_visit", channelSlug: "organic-linkedin-publishing", legKey: "start_to_website_visit", draft: true }),
    );
    const { CATALOGUE_WRITE_TOOLS } = await load();
    const { file, filed } = fileMock();
    const out = (await CATALOGUE_WRITE_TOOLS.create_pipe(
      { channelSlug: "organic-linkedin-publishing", toStep: "website_visit", mode: "proactive", userRequest: "post on LinkedIn every day" },
      ctx,
      file,
      staff,
    )) as { status: string; onHold: unknown[] };
    expect(call(0).body).toMatchObject({ channelSlug: "organic-linkedin-publishing", fromStep: null, toStep: "website_visit", mode: "proactive", createdBy: "user-1", requestedByOrgId: "org-1" });
    expect(call(0).body.userRequest).toBeUndefined();
    expect(out.status).toBe("created_on_hold");
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ kind: "feature", repo: "features-service" });
    expect(filed[0].pieceKey).toMatch(/^publish-leg-organic-linkedin-publishing/);
  });

  it("create_pipe: a published pipe files nothing", async () => {
    fetchMock().mockResolvedValue(res(201, { id: "c|l", channelSlug: "c", legKey: "l", draft: false }));
    const { CATALOGUE_WRITE_TOOLS } = await load();
    const { file, filed } = fileMock();
    const out = (await CATALOGUE_WRITE_TOOLS.create_pipe({ channelSlug: "c", toStep: "x", mode: "proactive", userRequest: "u" }, ctx, file, staff)) as { status: string };
    expect(out.status).toBe("created");
    expect(filed).toHaveLength(0);
  });

  it("create_pipe: a trigger nothing fires → detector request, on hold, not an error", async () => {
    fetchMock()
      .mockResolvedValueOnce(res(409, { error: "nothing fires it", reason: "trigger_not_fired" }))
      .mockResolvedValueOnce(res(200, { id: "no_reply_3d", kind: "delay", params: { days: 3 } }));
    const { CATALOGUE_WRITE_TOOLS } = await load();
    const { file, filed } = fileMock();
    const out = (await CATALOGUE_WRITE_TOOLS.create_pipe(
      { channelSlug: "whatsapp", fromStep: "lead_found", toStep: "conversation", mode: "reactive", triggerId: "no_reply_3d", userRequest: "u" },
      ctx,
      file,
      staff,
    )) as { status: string; reason: string };
    expect(out).toMatchObject({ status: "on_hold", reason: "trigger_not_fired" });
    expect(call(1).url).toBe("http://features.test/internal/declarations/trigger-types/no_reply_3d");
    expect(filed[0]).toMatchObject({ repo: "campaign-service", pieceKey: "delay-trigger-detector" });
  });

  it("create_sales_path posts the leg keys in order", async () => {
    fetchMock().mockResolvedValue(res(200, { created: false, id: "a+b" }));
    const { CATALOGUE_WRITE_TOOLS } = await load();
    const out = await CATALOGUE_WRITE_TOOLS.create_sales_path({ legKeys: ["a", "b"] }, ctx, fileMock().file, customer);
    expect(out).toEqual({ created: false, id: "a+b" });
    expect(call(0).body).toEqual({ legKeys: ["a", "b"], createdBy: "user-1", requestedByOrgId: "org-1" });
  });

  it("create_sales_funnel on a draft: files a publish request per DRAFT pipe only", async () => {
    const pipes: Record<string, unknown> = {
      "c1|l1": { id: "c1|l1", channelSlug: "c1", legKey: "l1", mode: "proactive", draft: false },
      "c2|l2": { id: "c2|l2", channelSlug: "c2", legKey: "l2", mode: "proactive", draft: true },
    };
    fetchMock().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return res(201, { id: "f", draft: true, legs: [{ legKey: "l1", pipe: { id: "c1|l1" } }, { legKey: "l2", pipe: { id: "c2|l2" } }, { legKey: "l3", pipe: null }] });
      }
      const id = decodeURIComponent(url.split("/pipes/")[1]);
      return res(200, pipes[id]);
    });
    const { CATALOGUE_WRITE_TOOLS } = await load();
    const { file, filed } = fileMock();
    const out = (await CATALOGUE_WRITE_TOOLS.create_sales_funnel({ pipeIds: ["c1|l1", "c2|l2", "l3"], userRequest: "u" }, ctx, file, staff)) as { status: string };
    const post = fetchMock().mock.calls.find((c) => (c[1] as RequestInit).method === "POST")!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ pipeIds: ["c1|l1", "c2|l2", "l3"], createdBy: "user-1", requestedByOrgId: "org-1" });
    expect(out.status).toBe("created_on_hold");
    expect(filed).toHaveLength(1);
    expect(filed[0].pieceKey).toMatch(/^publish-leg-c2-l2/);
  });

  it("never composes a MIXED funnel: proactive and reactive pipes together are refused before it is created (owner 2026-10-10)", async () => {
    const pipes: Record<string, unknown> = {
      "sales-cold-email-outreach|lead_found_to_conversation": { mode: "proactive", runnable: true },
      "ai-meeting-booking|conversation_to_meeting_booked": { mode: "reactive", runnable: true },
    };
    fetchMock().mockImplementation(async (url: string) => res(200, pipes[decodeURIComponent(url.split("/pipes/")[1])]));
    const { CATALOGUE_WRITE_TOOLS } = await load();
    await expect(
      CATALOGUE_WRITE_TOOLS.create_sales_funnel(
        { pipeIds: Object.keys(pipes).concat(["meeting_booked_to_paid_client"]), userRequest: "u" },
        ctx,
        fileMock().file,
        staff,
      ),
    ).rejects.toThrow(/mixes proactive pipes .* and reactive pipes/);
    expect(fetchMock().mock.calls.some((c) => (c[1] as RequestInit).method === "POST")).toBe(false);
  });

  it("refuses an empty pipe list before any call", async () => {
    const { CATALOGUE_WRITE_TOOLS } = await load();
    await expect(CATALOGUE_WRITE_TOOLS.create_sales_funnel({ pipeIds: [], userRequest: "u" }, ctx, fileMock().file, customer)).rejects.toThrow(/non-empty list/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});

describe("a customer is only offered what we run today (owner 2026-10-10)", () => {
  it("a detail read of something we do not run answers weRunItToday: false, never its terms", async () => {
    fetchMock().mockResolvedValue(res(200, { id: "organic-linkedin-publishing", name: "LinkedIn Posting", managed: false, runnable: false, terms: "$100/day" }));
    const { CATALOGUE_READ_TOOLS } = await load();
    const out = (await CATALOGUE_READ_TOOLS.find_channels({ id: "organic-linkedin-publishing" }, customer)) as Record<string, unknown>;
    expect(out).toMatchObject({ id: "organic-linkedin-publishing", weRunItToday: false });
    expect(JSON.stringify(out)).not.toContain("$100");
  });

  it("includeNotRunnable is refused for a customer, honoured for staff (no runnable filter)", async () => {
    const { CATALOGUE_READ_TOOLS } = await load();
    await expect(CATALOGUE_READ_TOOLS.find_channels({ includeNotRunnable: true }, customer)).rejects.toThrow(/staff only/);
    fetchMock().mockResolvedValue(res(200, { rows: [] }));
    await CATALOGUE_READ_TOOLS.find_channels({ includeNotRunnable: true, q: "linkedin" }, staff);
    expect(call(0).url).toBe("http://features.test/internal/catalogue/channels?q=linkedin");
  });

  it("steps and workflows carry no runnable filter", async () => {
    fetchMock().mockResolvedValue(res(200, { rows: [] }));
    const { CATALOGUE_READ_TOOLS } = await load();
    await CATALOGUE_READ_TOOLS.find_steps({}, customer);
    expect(call(0).url).toBe("http://features.test/internal/catalogue/steps");
  });

  it("create_pipe is refused for a customer before any call", async () => {
    const { CATALOGUE_WRITE_TOOLS } = await load();
    await expect(
      CATALOGUE_WRITE_TOOLS.create_pipe({ channelSlug: "organic-linkedin-publishing", toStep: "website_visit", mode: "proactive", userRequest: "u" }, ctx, fileMock().file, customer),
    ).rejects.toThrow(/staff only/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("a customer funnel with a pipe we do not run is refused before it is created", async () => {
    fetchMock().mockResolvedValueOnce(res(200, { id: "organic-linkedin-publishing|start_to_website_visit", runnable: false }));
    const { CATALOGUE_WRITE_TOOLS } = await load();
    await expect(
      CATALOGUE_WRITE_TOOLS.create_sales_funnel({ pipeIds: ["organic-linkedin-publishing|start_to_website_visit", "website_visit_to_paid_client"], userRequest: "u" }, ctx, fileMock().file, customer),
    ).rejects.toThrow(/not something we run today/);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("declaration tools need staffBuild AND a staff requester", async () => {
    const { assertStaffBuild } = await load();
    await expect(assertStaffBuild("list_declared_channels", {}, staff)).rejects.toThrow(/staffBuild: true/);
    await expect(assertStaffBuild("declare_channel", { staffBuild: true }, customer)).rejects.toThrow(/staff only/);
    await expect(assertStaffBuild("declare_channel", { staffBuild: true }, staff)).resolves.toBeUndefined();
  });
});

describe("every cost carries its unit (prod 2026-10-10: a per-reply cost quoted per paying client)", () => {
  it("a list row and a nested detail get cost = figure + unit from the producer's costPer", async () => {
    fetchMock().mockResolvedValueOnce(
      res(200, { rows: [{ id: "sales-cold-email-outreach", costUsd: 137.43, costPer: "per positive reply" }, { id: "x", costUsd: null, costPer: null }] }),
    );
    const { CATALOGUE_READ_TOOLS } = await load();
    const out = (await CATALOGUE_READ_TOOLS.find_channels({}, customer)) as { rows: Array<Record<string, unknown>> };
    expect(out.rows[0].cost).toBe("$137.43 per positive reply");
    expect(out.rows[1].cost).toBeUndefined();
    fetchMock().mockResolvedValueOnce(
      res(200, { id: "f", costUsd: 2748.69, costPer: "per paying client", runnable: true, legs: [{ pipe: { id: "p", costUsd: 137.43, costPer: "per positive reply" } }] }),
    );
    const detail = (await CATALOGUE_READ_TOOLS.find_sales_funnels({ id: "f" }, customer)) as Record<string, any>;
    expect(detail.cost).toBe("$2748.69 per paying client");
    expect(detail.legs[0].pipe.cost).toBe("$137.43 per positive reply");
  });

  it("a cost served without its unit fails loud (never a bare figure)", async () => {
    fetchMock().mockResolvedValueOnce(res(200, { rows: [{ id: "c", costUsd: 12 }] }));
    const { CATALOGUE_READ_TOOLS } = await load();
    await expect(CATALOGUE_READ_TOOLS.find_channels({}, customer)).rejects.toThrow(/without its unit/);
  });
});
