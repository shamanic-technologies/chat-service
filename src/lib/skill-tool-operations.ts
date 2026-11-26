// ---------------------------------------------------------------------------
// A tool a skill mentions, as the public API call that does the same act
// (AGENT-SIGNUP-UX-1125, prod 2026-11-25: an outside AI agent read
// `new-account` through GET /v1/skills, saw `@tool:confirm_offers`,
// `@tool:suggest_icp`, ... and guessed the HTTP calls: confirm with no body
// (400), then `offerId: ""` twice (400) before it recovered).
//
// So every `tool` mention a skill read serves carries `api`: the gateway
// operation(s) (method + path, the gateway's own operationId and the link that
// serves that one operation's request and answer schemas), or `noRoute` saying
// plainly why there is none. Data, one row per tool, checked against the
// gateway's served document (`tests/fixtures/gateway-operations.txt`, prod
// 2026-11-25); the operationId is READ from the gateway's live document at
// serve time, never derived here. A tool absent from this map is served with
// `noRoute` naming that, never a guess.
// ---------------------------------------------------------------------------

import { findOperation, getCatalog, type CatalogOperation } from "../agent/catalogue.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface ToolOperationRef {
  method: HttpMethod;
  path: string;
}

/** What a tool with no public operation says instead (`noRoute`). */
const CHAT_ONLY = "no API route: a chat screen of ours; an outside agent talks to its own user in its own words";
const API_ITSELF =
  "no single route: explores the API itself; read GET /openapi.json (one operation: GET /openapi.json?operation=<operationId>) and call the operation it names";
const NOT_PUBLIC = "no public API route for this act yet";
const STAFF_KEY = "not in the public API document: a staff-key route";

const op = (s: string): ToolOperationRef => {
  const [method, path] = s.split(" ") as [HttpMethod, string];
  return { method, path };
};

/** Tool name → the gateway operation(s) doing the same act, or why none. */
export const TOOL_OPERATIONS: Readonly<Record<string, readonly ToolOperationRef[] | { noRoute: string }>> = {
  // setting up a new account (the `new-account` steps)
  start_sign_in: [op("POST /v1/agent-signups/start")],
  complete_sign_in: [op("POST /v1/agent-signups/complete")],
  list_brands: [op("GET /v1/brands")],
  create_brand_from_url: [op("POST /v1/brands")],
  propose_offers: [op("POST /v1/brands/{id}/offers/proposals")],
  confirm_offers: [op("POST /v1/brands/{id}/offers/confirm")],
  list_offers: [op("GET /v1/brands/{id}/offers")],
  get_offer_settings: [op("GET /v1/brands/{id}/offers/{offerId}/economics")],
  update_offer_settings: [op("PUT /v1/brands/{id}/offers/{offerId}/economics")],
  suggest_icp: [op("POST /v1/brands/{id}/icp/suggest")],
  split_audiences: [op("POST /v1/orgs/audiences/split")],
  confirm_audiences: [op("POST /v1/orgs/audiences/split/confirm")],
  list_audiences: [op("GET /v1/orgs/audiences")],
  preview_audience: [op("GET /v1/orgs/audiences/{id}/preview")],
  preview_email: [op("POST /v1/content/preview-email")],
  find_sales_funnels: [op("GET /v1/offers/{offerId}/sales-funnels"), op("GET /v1/catalogue/sales-funnels")],
  get_prepaid_status: [op("GET /v1/billing/accounts/prepaid_status")],
  create_prepaid_checkout: [op("POST /v1/billing/accounts/prepaid_checkout")],
  build_audience_portfolio: [op("POST /v1/orgs/audiences/portfolio")],

  // catalogue walk
  find_steps: [op("GET /v1/catalogue/steps")],
  find_sales_paths: [op("GET /v1/catalogue/sales-paths")],
  find_channels: [op("GET /v1/catalogue/channels")],
  find_pipes: [op("GET /v1/catalogue/pipes")],
  find_plays: [op("GET /v1/plays")],
  find_tactics: [op("GET /v1/tactics")],
  find_strategies: [op("GET /v1/strategies")],
  create_tactic: [op("POST /v1/tactics")],
  create_strategy: [op("POST /v1/strategies")],
  create_play: [op("POST /v1/plays")],
  create_sales_funnel: [op("POST /v1/catalogue/sales-funnels")],
  create_sales_path: [op("POST /v1/catalogue/sales-paths")],
  list_trigger_types: [op("GET /v1/catalogue/triggers")],
  list_declared_legs: [op("GET /v1/catalogue/pipes")],

  // offers, steps, rates
  get_offer_performance: [op("GET /v1/offers/{offerId}/revenue")],
  get_offer_steps: [op("GET /v1/brands/{id}/offers/{offerId}/steps")],
  add_offer_step: [op("PUT /v1/brands/{id}/offers/{offerId}/steps/{stepKey}")],
  remove_offer_step: [op("DELETE /v1/brands/{id}/offers/{offerId}/steps/{stepKey}")],
  get_leg_rates: [op("GET /v1/brands/{id}/leg-rates")],
  set_leg_rates: [op("PUT /v1/brands/{id}/leg-rates")],
  list_sales_paths: [op("GET /v1/offers/{offerId}/sales-paths")],

  // audiences, qualification, sources
  suggest_audiences: [op("POST /v1/orgs/audiences/suggest")],
  set_audience_status: [op("PATCH /v1/orgs/audiences/{id}/status")],
  rename_audience: [op("PATCH /v1/orgs/audiences/{id}")],
  refresh_audience_count: [op("POST /v1/orgs/audiences/{id}/refresh-count")],
  list_qualification_checks: [op("GET /v1/brands/{id}/offers/{offerId}/qualification/criteria")],
  create_qualification_check: [op("POST /v1/brands/{id}/offers/{offerId}/qualification/criteria")],
  update_qualification_check: [op("PATCH /v1/brands/{id}/offers/{offerId}/qualification/criteria/{criterionId}")],
  archive_qualification_check: [op("DELETE /v1/brands/{id}/offers/{offerId}/qualification/criteria/{criterionId}")],
  suggest_qualification_checks: [op("POST /v1/brands/{id}/offers/{offerId}/qualification/suggestions")],
  list_qualification_sources: [op("GET /v1/qualification/catalog")],
  list_sourcing_origins: [op("GET /v1/public/sourcing-origins")],
  get_offer_sourcing: [op("GET /v1/offers/{offerId}/sourcing")],

  // campaigns, caps, triggers
  list_campaigns: [op("GET /v1/sales-funnel-campaigns")],
  list_funnel_campaigns: [op("GET /v1/sales-funnel-campaigns")],
  get_campaign: [op("GET /v1/campaigns/{id}")],
  create_funnel_campaign: [op("POST /v1/sales-funnel-campaigns")],
  stop_funnel_campaign: [op("PATCH /v1/sales-funnel-campaigns/{id}")],
  propose_switch_on: [op("PATCH /v1/sales-funnel-campaigns/{id}"), op("POST /v1/trigger-events")],
  confirm_switch_on: [op("PATCH /v1/sales-funnel-campaigns/{id}"), op("POST /v1/trigger-events")],
  get_funnel_caps: [
    op("GET /v1/brands/{brandId}/offers/{offerId}/sales-funnels/{salesFunnelId}/campaigns/{salesFunnelCampaignId}/caps"),
    op("GET /v1/brands/{brandId}/offers/{offerId}/sales-funnels/{salesFunnelId}/caps"),
  ],
  set_funnel_caps: [
    op("PUT /v1/brands/{brandId}/offers/{offerId}/sales-funnels/{salesFunnelId}/campaigns/{salesFunnelCampaignId}/caps"),
    op("PUT /v1/brands/{brandId}/offers/{offerId}/sales-funnels/{salesFunnelId}/caps"),
  ],
  get_trigger_events: [op("GET /v1/offers/{offerId}/trigger-events")],
  get_campaign_next_steps: [
    op("GET /v1/features/brands/{brandId}/sales-funnel-campaigns/{salesFunnelCampaignId}/next-steps"),
  ],

  // money and stats
  get_billing_account: [op("GET /v1/billing/accounts")],
  get_daily_budget: [op("GET /v1/brands/{brandId}/daily-budget")],
  set_daily_budget: [op("PATCH /v1/brands/{brandId}/daily-budget")],
  get_brand_pause: [op("GET /v1/brands/{brandId}/pause")],
  set_brand_pause: [op("PATCH /v1/brands/{brandId}/pause")],
  get_spend_by_campaign: [op("GET /v1/runs/stats/costs")],
  list_recent_runs: [op("GET /v1/runs")],
  get_org_usage: [op("GET /v1/features/orgs/usage")],
  list_replies_to_handle: [op("GET /v1/leads")],

  // workflows
  list_workflows: [op("GET /v1/workflows")],
  get_workflow_details: [op("GET /v1/workflows/{id}")],
  create_workflow: [op("POST /v1/workflows/create")],
  upgrade_workflow: [op("POST /v1/workflows/upgrade")],

  // people
  find_people: [op("GET /v1/orgs/people")],
  find_stakeholders: [op("GET /v1/orgs/people")],
  read_person_unibox: [op("GET /v1/orgs/people/timeline")],
  read_organization_unibox: [op("GET /v1/orgs/people/timeline")],
  list_people_organizations: [op("GET /v1/orgs/people/organizations")],
  correct_person: [op("POST /v1/orgs/people/corrections")],
  list_people_corrections: [op("GET /v1/orgs/people/corrections")],
  undo_people_correction: [op("POST /v1/orgs/people/corrections/{correctionId}/undo")],
  merge_people: [op("POST /v1/orgs/people/merges")],
  undo_people_merge: [op("POST /v1/orgs/people/merges/{mergeId}/undo")],
  add_contact: [op("POST /v1/orgs/contacts")],

  // accounts, requests to the team, skills
  list_connected_accounts: [op("GET /v1/orgs/google/accounts")],
  request_staff: [op("POST /v1/staff-requests")],
  request_skill_upgrade: [op("POST /v1/staff-requests")],
  contact_human: [op("POST /v1/staff-requests")],
  list_staff_requests: [op("GET /v1/staff-requests")],
  report_not_good: [op("POST /v1/features/unit-reports")],
  read_skill: [op("GET /v1/skills/{slug}")],

  // the API itself
  find_operation: { noRoute: API_ITSELF },
  describe_operation: { noRoute: API_ITSELF },
  run_operation: { noRoute: API_ITSELF },
  discover_services: { noRoute: API_ITSELF },
  discover_service_endpoints: { noRoute: API_ITSELF },
  discover_endpoint: { noRoute: API_ITSELF },
  test_endpoint: { noRoute: API_ITSELF },
  read_our_website: { noRoute: "no API route: read https://distribute.you/llms.txt and the pages it lists" },

  // chat screens
  present_choices: { noRoute: CHAT_ONLY },
  open_page: { noRoute: CHAT_ONLY },
  request_user_input: { noRoute: CHAT_ONLY },

  // acts with no public route
  read_company_financials: { noRoute: NOT_PUBLIC },
  list_declared_channels: { noRoute: NOT_PUBLIC },
  declare_channel: { noRoute: NOT_PUBLIC },
  list_declared_sales_paths: { noRoute: NOT_PUBLIC },
  declare_sales_path: { noRoute: NOT_PUBLIC },
  declare_leg: { noRoute: NOT_PUBLIC },
  // Outcomes like a Script (ENGINE-GET-ASK-1123): service routes reached by the chat, not the gateway
  find_outcome: { noRoute: NOT_PUBLIC },
  get_units: { noRoute: NOT_PUBLIC },
  ask_engine: { noRoute: NOT_PUBLIC },
  find_workflows: { noRoute: STAFF_KEY },
  create_pipe: { noRoute: STAFF_KEY },
  create_offer: { noRoute: STAFF_KEY },
  get_prompt_template: { noRoute: STAFF_KEY },
  update_prompt_template: { noRoute: STAFF_KEY },
};

/** Served when a mentioned tool has no row in `TOOL_OPERATIONS`. */
export const UNMAPPED_TOOL_NOTE =
  "not mapped to a public route yet: search GET /openapi.json for the act this tool names";

/** The public host an outside agent calls (the describe link must work from outside our network). */
export const PUBLIC_API_URL = "https://api.distribute.you";

export interface ServedToolOperation {
  method: HttpMethod;
  path: string;
  /** The gateway's own id for this operation; null when its public document does not list it (a staff-key route). */
  operationId: string | null;
  /** Serves this one operation's request and answer schemas; null with operationId. */
  describeUrl: string | null;
}

export interface ServedToolApi {
  /** The public call(s) doing what the tool does; empty = `noRoute` says why. */
  operations: ServedToolOperation[];
  noRoute?: string;
  /** Set when the gateway's document could not be read: operationIds are then unknown (null). */
  documentUnread?: string;
}

/** A tool's public API answer, given the gateway's compiled operations (null = unread, with why). */
export function toolApi(
  tool: string,
  catalog: { operations: CatalogOperation[] } | null,
  unreadReason?: string,
): ServedToolApi {
  const entry = TOOL_OPERATIONS[tool];
  if (!entry) return { operations: [], noRoute: UNMAPPED_TOOL_NOTE };
  if (!Array.isArray(entry)) return { operations: [], noRoute: (entry as { noRoute: string }).noRoute };
  const operations = (entry as readonly ToolOperationRef[]).map((ref): ServedToolOperation => {
    const found = catalog ? findOperation(catalog.operations, { method: ref.method, path: ref.path }) : null;
    // The catalogue names an operation the document gave no id as "METHOD path": not an id the gateway serves.
    const operationId =
      found && found.method === ref.method && found.path === ref.path && !found.operationId.includes(" ")
        ? found.operationId
        : null;
    return {
      method: ref.method,
      path: ref.path,
      operationId,
      describeUrl: operationId ? `${PUBLIC_API_URL}/openapi.json?operation=${encodeURIComponent(operationId)}` : null,
    };
  });
  return catalog ? { operations } : { operations, documentUnread: unreadReason ?? "the gateway's document was not read" };
}

/**
 * Mentions with `api` added on every tool mention. Reads the gateway's document
 * once (ETag-cached); a failed read is named on each tool (`documentUnread`),
 * never a failed skill read.
 */
export async function withToolApi<M extends { kind: string; ref: string }>(
  mentions: readonly M[],
): Promise<(M & { api?: ServedToolApi })[]> {
  if (!mentions.some((m) => m.kind === "tool")) return [...mentions];
  let catalog: { operations: CatalogOperation[] } | null = null;
  let reason: string | undefined;
  try {
    catalog = await getCatalog();
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
    console.error(`[chat-service] skill tool operations: gateway document unread: ${reason}`);
  }
  return mentions.map((m) => (m.kind === "tool" ? { ...m, api: toolApi(m.ref, catalog, reason) } : m));
}
