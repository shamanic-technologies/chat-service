import { describe, it, expect } from "vitest";
import { SEED_SKILLS } from "../../src/lib/skill-seed.js";
import { SKILL_SLUG_RE, INDEX_SKILL_SLUG } from "../../src/lib/skills.js";
import { TOOL_REGISTRY } from "../../src/lib/anthropic.js";

const TOPICS = [
  "offers", "client-profiles", "qualification", "sources", "channels", "legs", "triggers",
  "sales-paths", "campaigns", "workflows-and-templates", "connected-accounts", "budget-and-billing",
  "costs-roi-stats", "staff-requests", "catalogue", "infra",
];

const CATALOGUE_LEVELS = [
  "catalogue-steps", "catalogue-sales-paths", "catalogue-channels", "catalogue-pipes",
  "catalogue-sales-funnels", "catalogue-workflows",
];

const COPILOT_TOOLS = [
  "get_offer_channels", "get_offer_legs", "get_leg_rates", "list_sales_paths",
  "get_trigger_events", "list_sourcing_origins", "get_offer_sourcing",
  "get_campaign_budgets", "get_campaign", "list_connected_accounts", "create_offer", "set_offer_channels",
  "set_campaign_budget", "propose_switch_on", "confirm_switch_on",
  "request_staff", "list_staff_requests", "request_skill_upgrade", "contact_human",
  "find_steps", "find_sales_paths", "find_channels", "find_pipes", "find_sales_funnels", "find_workflows",
  "create_step", "create_pipe", "create_sales_path", "create_sales_funnel",
  "discover_services", "discover_service_endpoints", "discover_endpoint", "test_endpoint",
  "list_funnel_campaigns", "get_funnel_caps", "set_funnel_caps", "create_funnel_campaign", "stop_funnel_campaign",
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
      "switch_on_reactive_legs", "needs_code", "declared_on_hold", "on_hold", "trigger_not_fired",
      "customer_time", "created_on_hold", "paid_client", "website_visit", "meeting_booked", "step_not_found", "linkedin_post", "one_off", "start_funnel_campaign",
    ]);
    const named = new Set(all.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
    const unknown = [...named].filter((n) => !notTools.has(n) && !TOOL_REGISTRY[n] && !n.startsWith("lead_found_to") && !n.startsWith("start_to"));
    expect(unknown).toEqual([]);
  });
});

describe("chat-first walk (owner 2026-10-10)", () => {
  const bySlug = new Map(SEED_SKILLS.map((s) => [s.slug, s]));

  it("one sub-skill per catalogue level, under the catalogue skill", () => {
    for (const slug of CATALOGUE_LEVELS) expect(bySlug.get(slug)?.parentSlug, slug).toBe("catalogue");
    expect(bySlug.get("infra-build-workflow")?.parentSlug).toBe("infra");
  });

  it("the index walks the levels in the owner's order", () => {
    const index = bySlug.get("index")!.content;
    const order = ["find_steps", "find_sales_paths", "find_channels", "find_pipes", "find_sales_funnels", "find_workflows", "campaigns"];
    const at = order.map((t) => index.indexOf(t));
    for (const [i, pos] of at.entries()) expect(pos, order[i]).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("the index keeps inner words away from the user and names every request kind", () => {
    const index = bySlug.get("index")!.content;
    expect(index).toMatch(/Never say pipe/);
    for (const t of ["request_staff", "request_skill_upgrade", "contact_human"]) expect(index).toContain(t);
  });

  it("every skill stays small (under ~800 tokens), the index under ~900", () => {
    for (const s of SEED_SKILLS) {
      const cap = s.slug === "index" ? 3600 : 3200;
      expect(s.content.length, s.slug).toBeLessThan(cap);
    }
  });

  it("the request skill states where each kind lands", () => {
    const c = bySlug.get("staff-requests")!.content;
    for (const w of ["GitHub issue", "Telegram", "chat-service", "No issue"]) expect(c).toContain(w);
  });
});

describe("funnel campaigns (owner 2026-10-10)", () => {
  const c = SEED_SKILLS.find((s) => s.slug === "campaigns")!.content;
  it("asks max budget AND max volume, creates stopped, launches only through the gate", () => {
    for (const w of ["Max budget", "Max volume", "create_funnel_campaign", "STOPPED", "set_funnel_caps", "start_funnel_campaign", "confirm_switch_on"]) {
      expect(c).toContain(w);
    }
    const order = ["create_funnel_campaign", "set_funnel_caps", "propose_switch_on", "confirm_switch_on only"].map((w) => c.indexOf(w));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("retired huge reads (owner 2026-10-10)", () => {
  it("get_channel_catalogue is gone from the registry and from every skill", () => {
    expect(TOOL_REGISTRY.get_channel_catalogue).toBeUndefined();
    for (const s of SEED_SKILLS) expect(s.content, s.slug).not.toContain("get_channel_catalogue");
  });
});

describe("a funnel proposal shows its figures in text (prod 2026-10-10: cards only, no cost)", () => {
  it("the sales-funnels skill makes the text mandatory before the cards", () => {
    const c = SEED_SKILLS.find((s) => s.slug === "catalogue-sales-funnels")!.content;
    expect(c).toMatch(/First WRITE the 1 to 3 funnels/);
    expect(c.indexOf("WRITE")).toBeLessThan(c.indexOf("present_choices"));
  });
});

describe("voice (prod 2026-10-10: cards with no text, a card naming a pipe)", () => {
  it("the index asks for text before the cards and hides pipe and path names", () => {
    const index = SEED_SKILLS.find((s) => s.slug === "index")!.content;
    expect(index).toMatch(/TEXT first/);
    expect(index).toMatch(/never show a pipe's or a path's name/);
  });
});

describe("only what we run today (owner 2026-10-10: the Copilot offered LinkedIn posting)", () => {
  it("the index and the catalogue teach saying we do not run it, offering what we run, and a feature request", () => {
    const index = SEED_SKILLS.find((s) => s.slug === "index")!.content;
    expect(index).toMatch(/We only offer what we run today/);
    const cat = SEED_SKILLS.find((s) => s.slug === "catalogue")!.content;
    expect(cat).toMatch(/We do not run LinkedIn posting today/);
    expect(cat).not.toMatch(/create_pipe \(proactive/);
  });
});

describe("costs keep their unit", () => {
  it("the catalogue skill says a channel or pipe cost is never per paying client", () => {
    const cat = SEED_SKILLS.find((s) => s.slug === "catalogue")!.content;
    expect(cat).toMatch(/never per paying client/);
    expect(SEED_SKILLS.find((s) => s.slug === "index")!.content).toMatch(/with the unit and basis the tool gives/);
  });
});

describe("one kind per funnel (owner 2026-10-10)", () => {
  it("the funnel and campaign skills split Proactive and Reactive and ask Up to $X / Up to N", () => {
    const f = SEED_SKILLS.find((s) => s.slug === "catalogue-sales-funnels")!.content;
    expect(f).toMatch(/ALSO a Reactive funnel from the list \(its line starts at the trigger step/);
    const c = SEED_SKILLS.find((s) => s.slug === "campaigns")!.content;
    expect(c).toMatch(/"Up to \$X" and "Up to N prospects handled"/);
    expect(c).toMatch(/mixed funnel .* is refused/);
  });
});

describe("estimates and reactive funnels (owner 2026-10-10)", () => {
  it("skills say estimated, never measured, and ask a reactive funnel Up to N prospects handled", () => {
    const index = SEED_SKILLS.find((s) => s.slug === "index")!.content;
    expect(index).toMatch(/An estimate is never called measured/);
    expect(SEED_SKILLS.find((s) => s.slug === "catalogue")!.content).toMatch(/estimated \(a rate it rests on is not measured/);
    expect(SEED_SKILLS.find((s) => s.slug === "campaigns")!.content).toMatch(/"Up to N prospects handled"/);
  });
});

describe("the offer's ticked list is retired (owner 2026-10-10)", () => {
  it("no skill tells the agent to write it or switch on through it", () => {
    for (const sk of SEED_SKILLS) {
      const c = sk.content.replace(/Never write the offer's old ticked list \(set_selected_sales_paths\) and never switch on through it \(switch_on_reactive_legs\)/, "");
      expect(c, sk.slug).not.toMatch(/set_selected_sales_paths|switch_on_reactive_legs/);
    }
  });
});
