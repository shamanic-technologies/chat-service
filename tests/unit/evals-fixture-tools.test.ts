// SOPHIE-NO-FALSE-READY-1111: a replayed turn sees a refused gateway call and a
// yes proposal exactly as production shows them, or a scenario about a failed
// step grades a turn the model never had (the replay used to answer every
// recorded call 200 and drop the gateway's words on what an act does).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../src/lib/api-client.js", () => ({ apiServiceFetch: (...a: unknown[]) => fetchMock(...a) }));

const { loadCatalogFromDocument, resetCatalog } = await import("../../src/agent/catalogue.js");
const { callApi, failedCallAnswer, YES_MARKER } = await import("../../src/agent/catalogue-tools.js");
const { fixtureExecutor } = await import("../../src/evals/fixture-tools.js");

const PARAMS = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const WHY = "Sets the whole sales funnel campaign running.";
const DOC = {
  paths: {
    "/v1/content/preview-email": { post: { operationId: "postV1ContentPreviewEmail", summary: "Write one cold email", requestBody: { content: { "application/json": { schema: { type: "object" } } } } } },
    "/v1/sales-funnel-campaigns/{id}": {
      get: { operationId: "getV1SalesFunnelCampaignsById", summary: "Read a campaign", parameters: [{ name: "id", in: "path", required: true }] },
      patch: { operationId: "patchV1SalesFunnelCampaignsById", summary: "Edit a campaign", [YES_MARKER]: { because: ["starts_work"], why: WHY, notNeededWhen: [{ status: "stop" }] }, parameters: [{ name: "id", in: "path", required: true }], requestBody: { content: { "application/json": { schema: { type: "object" } } } } },
    },
  },
};

const scenario = {
  id: "s", title: "t", source: "client C, web, 2026-11-11", surface: "web", person: { name: "Sam" }, history: [], message: "m", facts: ["f"], expect: "e",
  fixtures: {
    "POST /v1/content/preview-email": [{ _status: 503, error: "no email writer for this step" }],
    "PATCH /v1/sales-funnel-campaigns/{id}": [{ updated: true }],
    "GET /v1/sales-funnel-campaigns/{id}": [{ status: "ongoing" }, { status: "stopped", _after: "PATCH /v1/sales-funnel-campaigns/{id}" }],
  },
} as never;
const def = { skills: [] } as never;

beforeEach(() => {
  loadCatalogFromDocument(DOC);
  fetchMock.mockReset();
});
afterEach(() => resetCatalog());

const run = async (args: Record<string, unknown>) =>
  ((await fixtureExecutor(def, scenario).executeTool({ name: "run_operation", args } as never)) as { result: unknown }).result;

describe("eval replay of run_operation", () => {
  it("answers a recorded refusal the way production answers one", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "no email writer for this step" }), { status: 503 }));
    const prod = await callApi({ operationId: "postV1ContentPreviewEmail", body: {} }, PARAMS, []);
    expect(await run({ operationId: "postV1ContentPreviewEmail", body: {} })).toEqual(prod);
    expect(prod).toMatchObject({ ok: false, status: 503 });
  });

  it("says in words what a refusal means, by status class only (SOPHIE-SAYS-FAILED-1112)", () => {
    const meaningOf = (s: number) => (failedCallAnswer(s, { error: "x" }) as { meaning: string }).meaning;
    expect(meaningOf(503)).toMatch(/^Failed on our side/);
    expect(meaningOf(503)).toMatch(/not pending or in progress/);
    expect(meaningOf(500)).toBe(meaningOf(503));
    expect(meaningOf(429)).toMatch(/tried again/);
    expect(meaningOf(400)).toMatch(/^Refused: nothing ran/);
    expect(meaningOf(404)).toBe(meaningOf(400));
  });

  it("proposes an act needing the person's yes with the gateway's own words, like production", async () => {
    const args = { operationId: "patchV1SalesFunnelCampaignsById", pathParams: { id: "c-1" }, body: { brief: "Goal" } };
    const prod = (await callApi(args, PARAMS, [])) as Record<string, unknown>;
    const replay = (await run(args)) as Record<string, unknown>;
    expect(replay).toEqual({ ...prod, confirmationToken: "replay-patchV1SalesFunnelCampaignsById" });
    expect(replay).toMatchObject({ yesRequired: true, why: WHY, request: { path: "/v1/sales-funnel-campaigns/c-1" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the account as it stands after an act of this turn (`_after`)", async () => {
    const ex = fixtureExecutor(def, scenario);
    const call = async (args: Record<string, unknown>) => ((await ex.executeTool({ name: "run_operation", args } as never)) as { result: unknown }).result;
    expect(await call({ operationId: "getV1SalesFunnelCampaignsById", pathParams: { id: "c-1" } })).toMatchObject({ data: { status: "ongoing" } });
    await call({ operationId: "patchV1SalesFunnelCampaignsById", pathParams: { id: "c-1" }, body: { status: "stop" } });
    expect(await call({ operationId: "getV1SalesFunnelCampaignsById", pathParams: { id: "c-1" } })).toMatchObject({ data: { status: "stopped" } });
  });
});

describe("report_not_good in a replay (SCRIPT-VALUE-RATING-1113-SOPHIE)", () => {
  it("answers as stored, on the scenario's surface, and writes nothing", async () => {
    const ex = fixtureExecutor(def, scenario);
    const r = (await ex.executeTool({ name: "report_not_good", args: { outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-9", kind: "reported", unitAt: "2026-11-10T14:05:00Z" } })) as { result: Record<string, unknown> };
    expect(r.result).toMatchObject({ reported: true, report: { outcomeKey: "message_written", subjectId: "lead-9", kind: "reported", unitAt: "2026-11-10T14:05:00.000Z" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ex.missing()).toEqual([]);
  });

  it("refuses what production refuses (a kind that is no report)", async () => {
    const ex = fixtureExecutor(def, scenario);
    await expect(ex.executeTool({ name: "report_not_good", args: { outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-9", kind: "liked" } })).rejects.toThrow(/no positive vote/);
  });
});
