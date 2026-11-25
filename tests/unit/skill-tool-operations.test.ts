import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadCatalogFromDocument, resetCatalog } from "../../src/agent/catalogue.js";
import { mentionableTools } from "../../src/agent/distry-config.js";
import { COPILOT_TOOL_API_OPS } from "../../src/lib/skill-api-ops.js";
import { parseMentions } from "../../src/lib/skill-mentions.js";
import {
  TOOL_OPERATIONS,
  UNMAPPED_TOOL_NOTE,
  toolApi,
  withToolApi,
  type ToolOperationRef,
} from "../../src/lib/skill-tool-operations.js";

// The gateway's served operations (method, path, operationId), read from prod api-service /openapi.json on 2026-11-25.
const FIXTURE = readFileSync(new URL("../fixtures/gateway-operations.txt", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => {
    const [method, path, operationId] = line.split(" ");
    return { method: method!, path: path!, operationId: operationId! };
  });

function gatewayDocument() {
  const paths: Record<string, Record<string, { operationId: string }>> = {};
  for (const o of FIXTURE) (paths[o.path] ??= {})[o.method.toLowerCase()] = { operationId: o.operationId };
  return { openapi: "3.0.0", paths };
}

// The prod `new-account` skill (staff-edited, v15) as an outside agent read it on 2026-11-25: tool mentions only.
const NEW_ACCOUNT_PROD_TOOLS = [
  "list_brands", "start_sign_in", "complete_sign_in", "create_brand_from_url", "run_operation", "propose_offers",
  "confirm_offers", "list_offers", "update_offer_settings", "suggest_icp", "split_audiences", "confirm_audiences",
  "list_audiences", "preview_audience", "preview_email", "request_staff", "find_sales_funnels", "get_prepaid_status",
  "present_choices", "create_prepaid_checkout", "build_audience_portfolio",
];

afterEach(() => resetCatalog());

describe("tool mentions → the public API call (AGENT-SIGNUP-UX-1125)", () => {
  it("every mapped operation is one the gateway serves", () => {
    const served = new Set(FIXTURE.map((o) => `${o.method} ${o.path}`));
    const missing: string[] = [];
    for (const [tool, entry] of Object.entries(TOOL_OPERATIONS)) {
      if (!Array.isArray(entry)) continue;
      for (const ref of entry as readonly ToolOperationRef[]) {
        if (!served.has(`${ref.method} ${ref.path}`)) missing.push(`${tool}: ${ref.method} ${ref.path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every tool the skill texts' API map names has a row (an operation, or why none)", () => {
    expect(Object.keys(COPILOT_TOOL_API_OPS).filter((t) => !TOOL_OPERATIONS[t])).toEqual([]);
  });

  it("every mentionable tool is served an answer: operations, or a stated reason", () => {
    for (const tool of mentionableTools()) {
      const api = toolApi(tool, { operations: [] });
      expect(api.operations.length > 0 || typeof api.noRoute === "string", tool).toBe(true);
    }
    expect(toolApi("not_a_tool", null).noRoute).toBe(UNMAPPED_TOOL_NOTE);
  });

  it("the new-account step tools resolve to the gateway's operation ids and describe links", async () => {
    loadCatalogFromDocument(gatewayDocument());
    const mentions = await withToolApi(NEW_ACCOUNT_PROD_TOOLS.map((ref) => ({ kind: "tool", ref, known: true })));
    const byTool = Object.fromEntries(mentions.map((m) => [m.ref, m.api!]));
    const first = (t: string) => {
      const o = byTool[t]!.operations[0]!;
      return `${o.method} ${o.path} ${o.operationId}`;
    };
    expect(first("propose_offers")).toBe("POST /v1/brands/{id}/offers/proposals postV1BrandsByIdOffersProposals");
    expect(first("confirm_offers")).toBe("POST /v1/brands/{id}/offers/confirm postV1BrandsByIdOffersConfirm");
    expect(first("suggest_icp")).toBe("POST /v1/brands/{id}/icp/suggest postV1BrandsByIdIcpSuggest");
    expect(first("split_audiences")).toBe("POST /v1/orgs/audiences/split postV1OrgsAudiencesSplit");
    expect(first("confirm_audiences")).toBe("POST /v1/orgs/audiences/split/confirm postV1OrgsAudiencesSplitConfirm");
    expect(first("preview_email")).toBe("POST /v1/content/preview-email postV1ContentPreviewEmail");
    expect(first("find_sales_funnels")).toBe("GET /v1/offers/{offerId}/sales-funnels getV1OffersByOfferIdSalesFunnels");
    expect(first("get_prepaid_status")).toBe("GET /v1/billing/accounts/prepaid_status getV1BillingAccountsPrepaidStatus");
    expect(first("create_prepaid_checkout")).toBe("POST /v1/billing/accounts/prepaid_checkout postV1BillingAccountsPrepaidCheckout");
    expect(first("start_sign_in")).toBe("POST /v1/agent-signups/start postV1AgentSignupsStart");
    expect(byTool.confirm_offers!.operations[0]!.describeUrl).toBe(
      "https://api.distribute.you/openapi.json?operation=postV1BrandsByIdOffersConfirm",
    );
    // Every tool the prod skill mentions: a resolved operation, or an explicit reason.
    for (const m of mentions) {
      const api = m.api!;
      if (api.operations.length === 0) expect(api.noRoute, m.ref).toMatch(/\S/);
      else for (const o of api.operations) expect(o.operationId, `${m.ref} ${o.method} ${o.path}`).not.toBeNull();
    }
    expect(byTool.present_choices!.noRoute).toMatch(/no API route/);
    expect(byTool.run_operation!.noRoute).toMatch(/openapi\.json/);
  });

  it("every tool the seed skills mention resolves to an operation or says why not", async () => {
    loadCatalogFromDocument(gatewayDocument());
    const { SEED_SKILLS } = await import("../../src/lib/skill-seed.js");
    const tools = new Set<string>();
    for (const s of SEED_SKILLS) for (const m of parseMentions(s.content)) if (m.kind === "tool") tools.add(m.ref);
    const served = await withToolApi([...tools].map((ref) => ({ kind: "tool", ref })));
    for (const m of served) {
      expect(m.api!.operations.length > 0 || m.api!.noRoute !== UNMAPPED_TOOL_NOTE, m.ref).toBe(true);
      for (const o of m.api!.operations) expect(o.operationId, `${m.ref} ${o.method} ${o.path}`).not.toBeNull();
    }
  });

  it("a skill mention is left as is; an unread gateway document is named, ids null", async () => {
    const skill = { kind: "skill", ref: "campaigns", known: true };
    expect(await withToolApi([skill])).toEqual([skill]);
    const api = toolApi("confirm_offers", null, "HTTP 503");
    expect(api.documentUnread).toBe("HTTP 503");
    expect(api.operations[0]).toMatchObject({ method: "POST", operationId: null, describeUrl: null });
  });
});
