import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../src/lib/api-client.js", () => ({ apiServiceFetch: (...a: unknown[]) => fetchMock(...a) }));

const { loadCatalogFromDocument, resetCatalog } = await import("../../src/agent/catalogue.js");
const { callApi, describeApi, findApi, resolveCallApiProposal, toolsForOperation, YES_MARKER } = await import("../../src/agent/catalogue-tools.js");

const PARAMS = { orgId: "org-1", userId: "user-1", runId: "run-1" };

const DOC = {
  paths: {
    "/v1/billing/accounts": { get: { operationId: "getV1BillingAccounts", summary: "The org's billing account", responses: { "200": { description: "ok" } } } },
    "/v1/sales-funnel-campaigns/{id}": {
      patch: { operationId: "patchV1SalesFunnelCampaignsById", summary: "Start or stop a campaign", [YES_MARKER]: true, parameters: [{ name: "id", in: "path", required: true }], requestBody: { content: { "application/json": { schema: { type: "object" } } } } },
    },
    "/v1/orgs": { post: { operationId: "postV1Orgs", summary: "Create an organization", "x-staff-only": true } },
    "/v1/prompts": { get: { operationId: "getV1Prompts", summary: "Prompt templates" } },
  },
};

beforeEach(() => {
  loadCatalogFromDocument(DOC);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ balance_cents: 500 }), { status: 200 }));
});
afterEach(() => resetCatalog());

describe("find_operation / describe_operation", () => {
  it("finds an operation by intent in plain words", async () => {
    const r = (await findApi({ query: "billing account balance" })) as { operations: Array<{ operationId: string }> };
    expect(r.operations[0].operationId).toBe("getV1BillingAccounts");
  });

  it("never offers an internal path", async () => {
    const r = (await findApi({ query: "prompt templates" })) as { operations: Array<{ operationId: string }> };
    expect(r.operations.map((o) => o.operationId)).not.toContain("getV1Prompts");
  });

  it("says when an operation needs the person's yes", async () => {
    expect(await describeApi({ operationId: "patchV1SalesFunnelCampaignsById" })).toMatchObject({ needsTheirYes: true });
    expect(await describeApi({ operationId: "getV1BillingAccounts" })).toMatchObject({ needsTheirYes: false });
  });
});

describe("run_operation", () => {
  it("calls a read as the person and returns the gateway's answer", async () => {
    const r = await callApi({ operationId: "getV1BillingAccounts" }, PARAMS, []);
    expect(r).toEqual({ ok: true, status: 200, data: { balance_cents: 500 } });
    expect(fetchMock).toHaveBeenCalledWith("/v1/billing/accounts", "GET", PARAMS, undefined);
  });

  it("accepts a method and a concrete path instead of an operation id", async () => {
    await callApi({ method: "GET", path: "/v1/billing/accounts" }, PARAMS, []);
    expect(fetchMock).toHaveBeenCalledWith("/v1/billing/accounts", "GET", PARAMS, undefined);
  });

  it("refuses a staff-only operation before any request", async () => {
    await expect(callApi({ operationId: "postV1Orgs" }, PARAMS, [])).rejects.toThrow(/not a client operation/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("points an earlier chat tool name to its operation", async () => {
    await expect(callApi({ operationId: "get_billing_account" }, PARAMS, [])).rejects.toThrow(/getV1BillingAccounts \(GET \/v1\/billing\/accounts\)/);
  });

  it("answers an operation needing a yes with a proposal, and calls nothing", async () => {
    const r = (await callApi({ operationId: "patchV1SalesFunnelCampaignsById", pathParams: { id: "c1" }, body: { status: "ongoing" } }, PARAMS, [])) as {
      yesRequired: boolean;
      confirmationToken: string;
    };
    expect(r.yesRequired).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs exactly the proposed request from a later turn, once", async () => {
    const proposal = (await callApi({ operationId: "patchV1SalesFunnelCampaignsById", pathParams: { id: "c1" }, body: { status: "ongoing" } }, PARAMS, [])) as {
      confirmationToken: string;
    };
    const history = [{ toolCalls: [{ name: "run_operation", args: {}, result: proposal }] }];
    // The model's new arguments are ignored: the token runs what the person said yes to.
    await callApi({ confirmationToken: proposal.confirmationToken, body: { status: "something-else" } }, PARAMS, history);
    expect(fetchMock).toHaveBeenCalledWith("/v1/sales-funnel-campaigns/c1", "PATCH", PARAMS, { status: "ongoing" });
    const used = [...history, { toolCalls: [{ name: "run_operation", args: { confirmationToken: proposal.confirmationToken }, result: { ok: true } }] }];
    expect(() => resolveCallApiProposal(proposal.confirmationToken, used)).toThrow(/already used/);
  });

  it("refuses a token the conversation never proposed (or proposed in this same turn)", () => {
    expect(() => resolveCallApiProposal("unknown", [])).toThrow(/Unknown confirmationToken/);
  });
});

describe("toolsForOperation", () => {
  it("maps a gateway operation to the chat tool that did the same act", () => {
    expect(toolsForOperation("GET", "/v1/billing/accounts")).toContain("get_billing_account");
    expect(toolsForOperation("GET", "/v1/brands/{brandId}/offers")).toContain("list_offers");
  });
});
