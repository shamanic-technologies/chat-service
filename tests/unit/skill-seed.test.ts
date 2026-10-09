import { describe, it, expect } from "vitest";
import { SEED_SKILLS } from "../../src/lib/skill-seed.js";
import { SKILL_SLUG_RE, INDEX_SKILL_SLUG } from "../../src/lib/skills.js";
import { TOOL_REGISTRY } from "../../src/lib/anthropic.js";

const TOPICS = [
  "offers", "client-profiles", "qualification", "sources", "channels", "legs", "triggers",
  "sales-paths", "campaigns", "workflows-and-templates", "connected-accounts", "budget-and-billing",
  "costs-roi-stats", "staff-requests",
];

const COPILOT_TOOLS = [
  "get_channel_catalogue", "get_offer_channels", "get_offer_legs", "get_leg_rates", "list_sales_paths",
  "get_selected_sales_paths", "get_trigger_events", "list_sourcing_origins", "get_offer_sourcing",
  "get_campaign_budgets", "get_campaign", "list_connected_accounts", "create_offer", "set_offer_channels",
  "set_selected_sales_paths", "set_campaign_budget", "propose_switch_on", "confirm_switch_on",
  "request_staff", "list_staff_requests",
];

describe("seeded skill tree", () => {
  const slugs = SEED_SKILLS.map((s) => s.slug);

  it("has the index and one sub-skill per topic, all under the index", () => {
    expect(slugs[0]).toBe(INDEX_SKILL_SLUG);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const topic of TOPICS) {
      const s = SEED_SKILLS.find((x) => x.slug === topic);
      expect(s, topic).toBeDefined();
      expect(s!.parentSlug).toBe(INDEX_SKILL_SLUG);
    }
    for (const s of SEED_SKILLS) expect(s.slug).toMatch(SKILL_SLUG_RE);
  });

  it("every Copilot tool is documented in at least one skill, and every tool exists", () => {
    const all = SEED_SKILLS.map((s) => s.content).join("\n");
    for (const tool of COPILOT_TOOLS) {
      expect(TOOL_REGISTRY[tool], tool).toBeDefined();
      expect(all.includes(tool), `${tool} missing from the skills`).toBe(true);
    }
  });

  it("every snake_case tool a skill names exists in the registry", () => {
    const all = SEED_SKILLS.map((s) => s.content).join("\n");
    // Names the skills mention as RETIRED or as data values (leg keys, trigger types) are not tools.
    const notTools = new Set([
      "list_personas", "create_persona", "get_brand_profile", "lead_requested", "positive_reply_received",
      "website_visited", "meeting_booked", "meeting_attended", "signed_up", "form_submitted",
      "start_to_lead_found", "lead_found_to_positive_reply", "start_campaign", "activate_campaign",
      "switch_on_reactive_legs", "needs_code",
    ]);
    const named = new Set(all.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
    const unknown = [...named].filter((n) => !notTools.has(n) && !TOOL_REGISTRY[n] && !n.startsWith("lead_found_to") && !n.startsWith("start_to"));
    expect(unknown).toEqual([]);
  });
});
