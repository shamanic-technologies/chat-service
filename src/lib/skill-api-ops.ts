// ---------------------------------------------------------------------------
// One skill text serves two readers (owner 2026-10-16, standard vocabulary):
// the Copilot, which calls its own tools, and an outside agent reading the same
// skills through GET /v1/skills (MCP: distribute_read_skill), which can only
// call the gateway. So beside every Copilot tool a skill names, it names the
// gateway operation that does the same act, or says plainly "no API route yet".
//
// This map is the contract the seed test (and `skillApiGaps`) enforce: for each
// Copilot tool a skill mentions, at least one of its fragments must appear in
// that same skill. A fragment is the gateway path (method included where the
// path alone is ambiguous). `NO_API_ROUTE` = the act has no public operation.
// Verified against api-service's served document + its staff-key operations
// (src/openapi/document.ts STAFF_KEY_OPERATIONS) on 2026-10-16.
// ---------------------------------------------------------------------------

export const NO_API_ROUTE = "no API route";

export const COPILOT_TOOL_API_OPS: Readonly<Record<string, readonly string[]>> = {
  // catalogue walk (GET /v1/catalogue/* answer a staff key today; public reads cover customers)
  find_steps: ["GET /v1/catalogue/steps"],
  find_sales_paths: ["GET /v1/catalogue/sales-paths"],
  find_channels: ["GET /v1/catalogue/channels"],
  find_pipes: ["GET /v1/catalogue/pipes"],
  find_sales_funnels: ["GET /v1/catalogue/sales-funnels", "/v1/offers/{offerId}/sales-funnels"],
  find_workflows: ["GET /v1/catalogue/workflows"],
  find_plays: ["GET /v1/plays"],
  find_tactics: ["GET /v1/tactics"],
  find_strategies: ["GET /v1/strategies"],
  create_tactic: ["POST /v1/tactics"],
  create_strategy: ["POST /v1/strategies"],
  create_play: ["POST /v1/plays"],
  create_pipe: ["POST /v1/catalogue/pipes"],
  create_sales_funnel: ["POST /v1/catalogue/sales-funnels"],
  create_sales_path: [NO_API_ROUTE],
  list_trigger_types: ["GET /v1/catalogue/triggers"],
  list_declared_channels: [NO_API_ROUTE],
  declare_channel: [NO_API_ROUTE],
  list_declared_legs: [NO_API_ROUTE, "GET /v1/catalogue/pipes"],
  declare_leg: [NO_API_ROUTE, "POST /v1/catalogue/pipes"],
  list_declared_sales_paths: [NO_API_ROUTE],
  declare_sales_path: [NO_API_ROUTE],

  // brands, offers, steps, rates
  list_brands: ["GET /v1/brands"],
  list_offers: ["GET /v1/brands/{id}/offers"],
  create_offer: ["POST /v1/brands/{id}/offers"],
  get_offer_performance: ["/v1/offers/{offerId}/revenue"],
  get_offer_steps: ["/v1/brands/{id}/offers/{offerId}/steps"],
  add_offer_step: ["/v1/brands/{id}/offers/{offerId}/steps/{stepKey}"],
  remove_offer_step: ["/v1/brands/{id}/offers/{offerId}/steps/{stepKey}"],
  get_leg_rates: ["/v1/brands/{id}/leg-rates"],
  set_leg_rates: ["/v1/brands/{id}/leg-rates"],
  list_sales_paths: ["/v1/offers/{offerId}/sales-paths"],

  // audiences, qualification, sources
  list_audiences: ["/v1/orgs/audiences"],
  suggest_audiences: ["/v1/orgs/audiences/suggest"],
  set_audience_status: ["/v1/orgs/audiences/{id}/status"],
  rename_audience: ["PATCH /v1/orgs/audiences/{id}"],
  refresh_audience_count: ["/v1/orgs/audiences/{id}/refresh-count"],
  list_qualification_checks: ["/qualification/criteria"],
  create_qualification_check: ["/qualification/criteria"],
  update_qualification_check: ["/qualification/criteria"],
  archive_qualification_check: ["/qualification/criteria"],
  suggest_qualification_checks: ["/qualification/suggestions"],
  list_qualification_sources: ["/v1/qualification/catalog"],
  list_sourcing_origins: ["/v1/public/sourcing-origins"],
  get_offer_sourcing: ["/v1/offers/{offerId}/sourcing"],

  // campaigns, caps, triggers
  list_campaigns: ["GET /v1/sales-funnel-campaigns"],
  list_funnel_campaigns: ["GET /v1/sales-funnel-campaigns"],
  get_campaign: ["GET /v1/campaigns/{id}"],
  create_funnel_campaign: ["POST /v1/sales-funnel-campaigns"],
  stop_funnel_campaign: ["PATCH /v1/sales-funnel-campaigns/{id}"],
  propose_switch_on: ["PATCH /v1/sales-funnel-campaigns/{id}", "POST /v1/trigger-events"],
  confirm_switch_on: ["PATCH /v1/sales-funnel-campaigns/{id}", "POST /v1/trigger-events"],
  get_funnel_caps: ["/sales-funnels/{salesFunnelId}/caps"],
  set_funnel_caps: ["/sales-funnels/{salesFunnelId}/caps"],
  get_trigger_events: ["/v1/offers/{offerId}/trigger-events"],

  // money and stats
  get_billing_account: ["GET /v1/billing/accounts"],
  get_daily_budget: ["/v1/brands/{brandId}/daily-budget"],
  set_daily_budget: ["/v1/brands/{brandId}/daily-budget"],
  get_brand_pause: ["/v1/brands/{brandId}/pause"],
  set_brand_pause: ["/v1/brands/{brandId}/pause"],
  get_spend_by_campaign: ["/v1/runs/stats/costs"],
  list_recent_runs: ["GET /v1/runs"],
  get_org_usage: ["/v1/features/orgs/usage"],
  list_replies_to_handle: ["GET /v1/leads"],

  // workflows and templates
  list_workflows: ["GET /v1/workflows"],
  get_workflow_details: ["GET /v1/workflows/{id}"],
  get_prompt_template: ["/v1/prompts"],
  update_prompt_template: ["/v1/prompts"],
  create_workflow: ["POST /v1/workflows/create"],
  upgrade_workflow: ["POST /v1/workflows/upgrade"],

  // accounts
  list_connected_accounts: ["/v1/orgs/google/accounts"],

  // requests to the team: the Copilot's request_staff, for any agent
  request_staff: ["POST /v1/staff-requests"],
  request_skill_upgrade: ["POST /v1/staff-requests"],
  contact_human: ["POST /v1/staff-requests"],
  list_staff_requests: ["GET /v1/staff-requests"],

  // exploring the API itself
  discover_services: ["distribute_find_api", "/v1/me/openapi.json"],
  discover_service_endpoints: ["distribute_find_api", "/v1/me/openapi.json"],
  discover_endpoint: ["distribute_describe_api", "/v1/me/openapi.json"],
  test_endpoint: ["distribute_call_api"],
  read_skill: ["/v1/skills/{slug}"],

  // chat UI: an outside agent talks to its user in its own words
  present_choices: [NO_API_ROUTE],
  open_page: [NO_API_ROUTE],
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Copilot tools a skill names with none of their API fragments beside them.
 * `knownTools` = every name the Copilot can call (TOOL_REGISTRY keys); a known
 * tool with no entry in the map is reported as `unmapped` so a new tool cannot
 * slip into a skill without its API answer.
 */
export function skillApiGaps(
  content: string,
  knownTools: readonly string[],
): { missing: string[]; unmapped: string[] } {
  const missing: string[] = [];
  const unmapped: string[] = [];
  for (const tool of knownTools) {
    if (!new RegExp(`\\b${escapeRe(tool)}\\b`).test(content)) continue;
    const ops = COPILOT_TOOL_API_OPS[tool];
    if (!ops) {
      unmapped.push(tool);
      continue;
    }
    if (!ops.some((op) => content.includes(op))) missing.push(tool);
  }
  return { missing, unmapped };
}
