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
    ["find_sales_paths", { containsSteps: ["conversation", "meeting_booked"] }, "/internal/catalogue/sales-paths?containsSteps=conversation%2Cmeeting_booked"],
    ["find_sales_paths", { id: "a+b" }, "/internal/catalogue/sales-paths/a%2Bb"],
    ["find_channels", { forPaths: ["a+b"], q: "linkedin" }, "/internal/catalogue/channels?forPaths=a%2Bb&q=linkedin"],
    ["find_pipes", { paths: ["a+b"], channels: ["organic-linkedin-publishing"] }, "/internal/catalogue/pipes?paths=a%2Bb&channels=organic-linkedin-publishing"],
    ["find_pipes", { id: "cold-email|lead_found_to_conversation" }, "/internal/catalogue/pipes/cold-email%7Clead_found_to_conversation"],
    ["find_sales_funnels", { paths: "a+b", containsChannels: ["x"] }, "/internal/catalogue/sales-funnels?paths=a%2Bb&containsChannels=x"],
    ["find_workflows", { pipe: "c|l", limit: 3 }, "/internal/catalogue/workflows?pipe=c%7Cl&limit=3"],
    ["find_workflows", { pipe: "c|l", id: "wf-raven" }, "/internal/catalogue/workflows/wf-raven?pipe=c%7Cl"],
  ])("%s(%j) → GET %s", async (tool, args, path) => {
    fetchMock().mockResolvedValue(res(200, { rows: [] }));
    const { CATALOGUE_READ_TOOLS } = await load();
    expect(await CATALOGUE_READ_TOOLS[tool](args)).toEqual({ rows: [] });
    expect(call(0)).toMatchObject({ url: `http://features.test${path}`, method: "GET", key: "features-key" });
  });

  it("keeps pages small: a limit over 25 is refused before any call", async () => {
    const { CATALOGUE_READ_TOOLS } = await load();
    await expect(CATALOGUE_READ_TOOLS.find_channels({ limit: 100 })).rejects.toThrow(/1 to 25/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("find_workflows needs a pipe (the owner ranks workflows per pipe)", async () => {
    const { CATALOGUE_READ_TOOLS } = await load();
    await expect(CATALOGUE_READ_TOOLS.find_workflows({})).rejects.toThrow(/pipe is required/);
  });

  it("a refusal carries the owner's reason to the model", async () => {
    fetchMock().mockResolvedValue(res(400, { error: "no step linkedin_post", reason: "step_not_found" }));
    const { CATALOGUE_READ_TOOLS } = await load();
    await expect(CATALOGUE_READ_TOOLS.find_sales_paths({ containsSteps: ["linkedin_post"] })).rejects.toThrow(/step_not_found/);
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
    const out = (await CATALOGUE_WRITE_TOOLS.create_pipe({ channelSlug: "c", toStep: "x", mode: "proactive", userRequest: "u" }, ctx, file)) as { status: string };
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
    )) as { status: string; reason: string };
    expect(out).toMatchObject({ status: "on_hold", reason: "trigger_not_fired" });
    expect(call(1).url).toBe("http://features.test/internal/declarations/trigger-types/no_reply_3d");
    expect(filed[0]).toMatchObject({ repo: "campaign-service", pieceKey: "delay-trigger-detector" });
  });

  it("create_sales_path posts the leg keys in order", async () => {
    fetchMock().mockResolvedValue(res(200, { created: false, id: "a+b" }));
    const { CATALOGUE_WRITE_TOOLS } = await load();
    const out = await CATALOGUE_WRITE_TOOLS.create_sales_path({ legKeys: ["a", "b"] }, ctx, fileMock().file);
    expect(out).toEqual({ created: false, id: "a+b" });
    expect(call(0).body).toEqual({ legKeys: ["a", "b"], createdBy: "user-1", requestedByOrgId: "org-1" });
  });

  it("create_sales_funnel on a draft: files a publish request per DRAFT pipe only", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        res(201, {
          id: "f",
          draft: true,
          legs: [
            { legKey: "l1", pipe: { id: "c1|l1" } },
            { legKey: "l2", pipe: { id: "c2|l2" } },
            { legKey: "l3", pipe: null },
          ],
        }),
      )
      .mockResolvedValueOnce(res(200, { id: "c1|l1", channelSlug: "c1", legKey: "l1", draft: false }))
      .mockResolvedValueOnce(res(200, { id: "c2|l2", channelSlug: "c2", legKey: "l2", draft: true }));
    const { CATALOGUE_WRITE_TOOLS } = await load();
    const { file, filed } = fileMock();
    const out = (await CATALOGUE_WRITE_TOOLS.create_sales_funnel({ pipeIds: ["c1|l1", "c2|l2", "l3"], userRequest: "u" }, ctx, file)) as { status: string };
    expect(call(0).body).toEqual({ pipeIds: ["c1|l1", "c2|l2", "l3"], createdBy: "user-1", requestedByOrgId: "org-1" });
    expect(call(2).url).toBe("http://features.test/internal/catalogue/pipes/c2%7Cl2");
    expect(out.status).toBe("created_on_hold");
    expect(filed).toHaveLength(1);
    expect(filed[0].pieceKey).toMatch(/^publish-leg-c2-l2/);
  });

  it("refuses an empty pipe list before any call", async () => {
    const { CATALOGUE_WRITE_TOOLS } = await load();
    await expect(CATALOGUE_WRITE_TOOLS.create_sales_funnel({ pipeIds: [], userRequest: "u" }, ctx, fileMock().file)).rejects.toThrow(/non-empty list/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});
