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
  "catalogue-steps", "catalogue-sales-paths", "catalogue-channels", "catalogue-pipes", "catalogue-plays",
  "catalogue-sales-funnels", "catalogue-workflows",
];

const COPILOT_TOOLS = [
  "get_leg_rates", "set_leg_rates", "get_offer_steps", "add_offer_step", "remove_offer_step", "list_sales_paths",
  "get_trigger_events", "list_sourcing_origins", "get_offer_sourcing",
  "list_connected_accounts", "create_offer",
  "propose_switch_on", "confirm_switch_on",
  "request_staff", "list_staff_requests", "request_skill_upgrade", "contact_human",
  "find_steps", "find_sales_paths", "find_channels", "find_pipes", "find_sales_funnels", "find_workflows",
  "find_plays", "find_strategies", "find_tactics", "create_tactic", "create_strategy", "create_play",
  "create_pipe", "create_sales_path", "create_sales_funnel",
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
      // MCP tool names (the skill is served to API agents too), not Copilot tools.
      "distribute_list_triggers", "distribute_call_api",
      "list_personas", "create_persona", "get_brand_profile", "lead_requested", "positive_reply_received",
      "website_visited", "meeting_booked", "meeting_attended", "signed_up", "form_submitted",
      "start_to_lead_found", "lead_found_to_positive_reply", "start_campaign", "activate_campaign",
      "switch_on_reactive_legs", "needs_code", "declared_on_hold", "on_hold", "trigger_not_fired",
      "customer_time", "created_on_hold", "paid_client", "website_visit", "meeting_booked", "step_not_found", "linkedin_post", "one_off", "start_funnel_campaign",
      "email_pushed_via_api", "push_email", "campaign_off",
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

  it("an email the user wrote is pushed through their live campaign, never a feature request (COPILOT-PUSH-EMAIL-1014)", () => {
    const e = bySlug.get("emails-you-wrote")!;
    expect(e.parentSlug).toBe("index");
    for (const w of ["email_pushed_via_api", "POST /v1/trigger-events", "push_email", "confirm_switch_on", "Never request_staff", "The client brings them"]) expect(e.content).toContain(w);
    expect(bySlug.get("index")!.content).toContain("emails-you-wrote");
    const r = bySlug.get("staff-requests")!.content;
    expect(r).toContain("## Before filing");
    expect(r.indexOf("list_campaigns")).toBeLessThan(r.indexOf("Only then request_staff"));
    expect(r).toContain("discover_service_endpoints");
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
    expect(c.indexOf("WRITE")).toBeLessThan(c.indexOf("card"));
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
    expect(c).toMatch(/"Up to \$X" and\/or "Up to N prospects handled"/);
    expect(c).toMatch(/served `mixed` is refused/);
    expect(c).toMatch(/no email goes out/);
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

describe("the offer's ticked list, legs and accepted channels are retired (owner 2026-10-10)", () => {
  const RETIRED = ["set_selected_sales_paths", "get_selected_sales_paths", "switch_on_reactive_legs", "get_offer_legs", "get_offer_channels", "set_offer_channels"];

  it("no skill names a retired tool or action", () => {
    for (const sk of SEED_SKILLS) {
      for (const t of RETIRED) expect(sk.content, `${sk.slug}: ${t}`).not.toContain(t);
    }
  });

  it("no retired tool is in the registry", () => {
    for (const t of RETIRED) expect(TOOL_REGISTRY[t], t).toBeUndefined();
  });
});

describe("a campaign IS a funnel campaign in every skill (owner rule)", () => {
  it("campaigns and budgets are answered from list_campaigns; steps are never campaigns", () => {
    const c = SEED_SKILLS.find((s) => s.slug === "campaigns")!.content;
    expect(c).toMatch(/Count and name only campaigns: a step .* is part of a campaign, never a campaign/);
    const b = SEED_SKILLS.find((s) => s.slug === "budget-and-billing")!.content;
    expect(b).toMatch(/Each campaign's budget: list_campaigns/);
    expect(b).not.toMatch(/get_campaign_budgets/);
  });
});

describe("no per-step writes in the Copilot's skills (owner 2026-10-10)", () => {
  it("budgets are set_funnel_caps and on/off is the funnel campaign; a source has no budget of its own", () => {
    for (const sk of SEED_SKILLS) expect(sk.content, sk.slug).not.toMatch(/set_campaign_budget|stop_campaign\b|start_campaign\b|activate_campaign/);
    const src = SEED_SKILLS.find((s) => s.slug === "sources")!.content;
    expect(src).toMatch(/A source has no on\/off or budget of its own/);
  });
});

describe("caps and cards (owner 2026-10-11, Doc Dinners: 'no volume cap' answered with 20,000 / 50,000 cards)", () => {
  it("a campaign needs at least one cap, either alone, never invented or asked again", () => {
    const c = SEED_SKILLS.find((s) => s.slug === "campaigns")!.content;
    expect(c).toMatch(/a max budget, a max volume, or both\. Either alone is valid; only NEITHER is refused/);
    expect(c).toMatch(/never ask again for a declined one/);
    expect(c).not.toMatch(/Ask the user both with present_choices/);
  });

  it("one skill says why cards exist and when not to use them; no other skill prescribes them", () => {
    const c = SEED_SKILLS.find((s) => s.slug === "choices")!;
    expect(c.parentSlug).toBe("index");
    expect(c.content).toMatch(/Save the user time/);
    expect(c.content).toMatch(/blank page/);
    expect(c.content).toMatch(/already answered/);
    expect(c.content).toMatch(/free value/);
    for (const s of SEED_SKILLS) {
      if (s.slug === "choices" || s.slug === "index") continue;
      expect(s.content, s.slug).not.toMatch(/with present_choices/);
    }
  });
});

describe("ask before proposing a funnel on a step the business may lack (owner 2026-10-12)", () => {
  const bySlug = new Map(SEED_SKILLS.map((s) => [s.slug, s.content]));

  it("the retired ticked-list line that licensed the incident is gone", () => {
    for (const sk of SEED_SKILLS) {
      expect(sk.content, sk.slug).not.toMatch(/ticked list/i);
      expect(sk.content, sk.slug).not.toMatch(/no tool to read or write/);
      expect(sk.title, sk.slug).not.toMatch(/ticked list/i);
    }
  });

  it("the funnel skill reads the offer's steps, asks about an unknown one, records yes and no, and never moves a funnel", () => {
    const f = bySlug.get("catalogue-sales-funnels")!;
    for (const w of ["get_offer_steps", "ASK the client", "add_offer_step", "remove_offer_step", "Lead found and Paid client are in every business", "never \"move\""]) {
      expect(f).toContain(w);
    }
    expect(f.indexOf("get_offer_steps")).toBeLessThan(f.indexOf("## Propose"));
    expect(f).toContain("find_sales_funnels(offerId, brandId)");
    expect(f).toContain("setAside");
    expect(bySlug.get("index")!).toContain("find_sales_funnels(offerId, brandId)");
  });

  it("the legs skill writes a stated rate as a percent", () => {
    expect(bySlug.get("legs")!).toMatch(/set_leg_rates\(brandId, legRates\).*"0\.5%" is 0\.5/);
  });
});

describe("making a campaign behave a certain way (MCP role-play 2026-10-14: documents uploaded, campaign never changed)", () => {
  const bySlug = new Map(SEED_SKILLS.map((s) => [s.slug, s]));

  it("the index points a behaviour change to the plays skill", () => {
    expect(bySlug.get("index")!.content).toMatch(/behave differently .* Load `catalogue-plays`/);
  });

  it("the plays skill explains the three words, find before create, the funnel id, and one responder per reply", () => {
    const c = bySlug.get("catalogue-plays")!.content;
    for (const w of ["**Tactic**", "**Strategy**", "**Play**", "find_plays", "find_tactics", "create_tactic", "create_strategy", "create_play", "~<strategy id>", "STOPPED", "stop_funnel_campaign", "allowedActiveWorkflowCount"]) {
      expect(c, w).toContain(w);
    }
    expect(c).toMatch(/BOTH answer a positive reply/);
    expect(c).toContain("POST /v1/sales-funnel-campaigns");
  });

  it("offers says uploading documents is half the setup", () => {
    const c = bySlug.get("offers")!.content;
    expect(c).toMatch(/Uploading is half the setup/);
    expect(c).toMatch(/what the file is and when it helps a prospect/);
    expect(c).toContain("catalogue-plays");
  });

  it("campaigns explains part ids", () => {
    const c = bySlug.get("campaigns")!.content;
    expect(c).toMatch(/one part per step/);
    expect(c).toMatch(/salesFunnelCampaignId/);
  });
});

describe("MCP role-play gaps 2026-10-14 (attach the right PDF): API agents must reach every step", () => {
  const bySlug = new Map(SEED_SKILLS.map((s) => [s.slug, s]));

  it("funnels by id through the API are a q search, never an id filter; a play lists its funnels", () => {
    const c = bySlug.get("catalogue-plays")!.content;
    expect(c).toMatch(/sales-funnels\?brandId=&q=/);
    expect(c).toMatch(/no id filter/);
    expect(c).toContain("GET /v1/plays/{id} (salesFunnels)");
  });

  it("switching a campaign carries the cap over, asks the amount, stops the old then starts the new", () => {
    const c = bySlug.get("catalogue-plays")!.content;
    expect(c).toMatch(/Caps belong to the funnel: the new one has none/);
    expect(c).toMatch(/the client says the amount/);
    expect(c.indexOf("stop_funnel_campaign(old)")).toBeLessThan(c.indexOf("confirm_switch_on(new)"));
    expect(c).toMatch(/No single call swaps them/);
    expect(c).toMatch(/DELETE \.\.\.\/\{id\} \(409 if running or with history\)/);
  });

  it("documents: description wording matches the API field, near-duplicates go to the client", () => {
    const c = bySlug.get("offers")!.content;
    expect(c).not.toMatch(/when NOT/);
    expect(c).toMatch(/Near-duplicates/);
    expect(c).toMatch(/Never delete or rewrite a client's file unasked/);
  });

  it("workflows: how to see which workflows a play runs, by name and description", () => {
    const c = bySlug.get("catalogue-workflows")!.content;
    expect(c).toContain("excludedWorkflowDynastySlugs");
    expect(c).toContain("GET /v1/workflows/summaries?featureSlug=<channel slug>&status=active");
  });
});

describe("triggers skill (OUTCOME-TRIGGERS-CALLABLE-1015)", () => {
  it("says which triggers an outside call may fire, and where to read it", () => {
    const t = SEED_SKILLS.find((x) => x.slug === "triggers")!.content;
    for (const w of ["callable:false", "POST /v1/trigger-events", "distribute_list_triggers", "GET /v1/public/channels"]) expect(t).toContain(w);
  });
});
