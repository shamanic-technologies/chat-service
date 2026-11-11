import { describe, it, expect } from "vitest";
import { SEED_SKILLS } from "../../src/lib/skill-seed.js";
import { SKILL_SLUG_RE, INDEX_SKILL_SLUG } from "../../src/lib/skills.js";
import { TOOL_REGISTRY } from "../../src/lib/anthropic.js";
import { MERGED_SKILL_SLUGS } from "../../src/lib/skill-seed.js";
import { COPILOT_TOOL_API_OPS, skillApiGaps } from "../../src/lib/skill-api-ops.js";

// The client's jobs, one level under the index (SOPHIE-REFONTE-1102); staff work sits under `staff`.
const TOPICS = [
  "new-account", "offers", "client-profiles", "campaigns", "emails-you-wrote", "connected-accounts", "whatsapp-line",
  "budget-and-billing", "costs-roi-stats", "staff-requests", "choices", "staff",
];
const STAFF_TOPICS = ["gtm-factory", "catalogue", "infra", "triggers"];

const CATALOGUE_LEVELS = [
  "catalogue-steps", "catalogue-sales-paths", "catalogue-sales-funnels",
];

// Sophie's own tools beside the API (SOPHIE-REFONTE-1102): every act on the account is an API operation the skills name.
const COPILOT_TOOLS = [
  "find_operation", "describe_operation", "run_operation",
  "request_staff", "list_staff_requests", "request_skill_upgrade", "contact_human",
  "find_steps", "find_sales_paths", "find_sales_funnels",
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
    for (const topic of STAFF_TOPICS) expect(SEED_SKILLS.find((x) => x.slug === topic)?.parentSlug, topic).toBe("staff");
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
      "distribute_list_triggers", "distribute_call_api", "distribute_find_api", "distribute_describe_api", "distribute_prepay", "distribute_prepaid_status",
      "list_personas", "create_persona", "get_brand_profile", "lead_requested", "positive_reply_received",
      "website_visited", "meeting_booked", "meeting_attended", "signed_up", "form_submitted",
      "start_to_lead_found", "lead_found_to_positive_reply", "start_campaign", "activate_campaign",
      "switch_on_reactive_legs", "needs_code", "declared_on_hold", "on_hold", "trigger_not_fired",
      "customer_time", "created_on_hold", "paid_client", "website_visit", "meeting_booked", "step_not_found", "linkedin_post", "one_off", "start_funnel_campaign",
      "email_pushed_via_api", "push_email", "campaign_off",
      // Data values and path segments (an API reader needs them verbatim).
      "prepaid_checkout", "prepaid_status", "payment_required", "not_built_yet", "topup_amount_cents",
      "balance_cents", "auto_topup", "amount_cents", "threshold_cents", "monthly_charge_limit", "topup_threshold_cents", "topup_minimums", "monthly_charge_limit_cents",
      "auto_topup_amount_cents", "auto_topup_threshold_cents", "positive_reply", "skill_upgrade", "reactive_pipe_from_lead_found", "pipe_in_use",
      "sales_interest", "not_built_yet", "not_prepaid",
      // WhatsApp line values (crm-service link status, account types).
      "not_linked", "pro_ai", "personal_human",
      // GET /v1/conversations query parameter.
      "campaign_id",
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
    expect(bySlug.get("infra-build-script")?.parentSlug).toBe("infra");
  });

  it("the staff skill walks the levels in the owner's order", () => {
    const index = bySlug.get("staff")!.content.split("## The walk")[1];
    const order = ["find_steps", "find_sales_paths", "find_sales_funnels", "gtm-factory", "campaigns"];
    const at = order.map((t) => index.indexOf(t));
    for (const [i, pos] of at.entries()) expect(pos, order[i]).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("one voice for every surface: client-comms, pointed to by the index (owner 2026-10-18)", () => {
    const voice = bySlug.get("client-comms")!;
    expect(voice.parentSlug).toBe("index");
    expect(voice.content).toMatch(/reassured, knowing what happens next/);
    expect(voice.content).toMatch(/goes to the team silently/);
    expect(voice.content).toMatch(/wins over any other wording rule/);
    expect(voice.content).toMatch(/Never say what you could not read/);
    // SOPHIE-CORE-1111 (owner 2026-11-11): understand first, Carnegie, truth, in the one voice every surface reads.
    for (const w of ["## Understand first", "Unibox timeline", "Dale Carnegie", "## Truth", "never tell them what they already know"]) expect(voice.content).toContain(w);
    expect(voice.content).not.toMatch(/[\u2014\u2013]/);
    expect(bySlug.get("index")!.content).toContain("`client-comms`");
  });

  it("a fact that changed is told as today's fact, never as a self-correction (COPILOT-NO-SELF-CORRECTION-1022)", () => {
    // Prod 2026-10-21: "That corrects what I said earlier, when I told you it
    // wasn't saved." The client reads the story of the account, not of our answers.
    const voice = bySlug.get("client-comms")!.content;
    expect(voice).toMatch(/give today's fact plainly, as news, and never point back at the earlier message/);
    expect(voice).toMatch(/never the story of your answers/);
    // Staff replay 2026-10-22: with only that rule the Copilot still wrote
    // "The cal.com address I quoted earlier isn't stored, so please don't rely
    // on it": a fact they may act on needs no pointer to the old answer.
    expect(voice).toMatch(/today's fact and the next step replace it by themselves/);
    expect(voice).toMatch(/never name, quote or warn about what was said before/);
    expect(voice).toMatch(/the history of your own answers \(what you said before, that it was wrong, that this corrects it\)/);
    expect(voice).toMatch(/an earlier answer of yours they may have acted on\. It goes to the team silently/);
    // No skill may license announcing a correction to the client.
    for (const s of SEED_SKILLS) {
      expect(s.content, s.slug).not.toMatch(/\b(correct|admit|acknowledge) (your|the) (earlier|previous|mistake)/i);
      expect(s.content, s.slug).not.toMatch(/public self-correction/);
    }
  });

  it("a next step closes the message, offered once, never a stalling open question (COPILOT-WA-REPEAT-1027, SOPHIE-CORE-1111)", () => {
    // Prod 2026-10-27 (Joshua, stopped at the card step): "Take your time... ask me here", "Any question about the site?".
    // Prod 2026-11-11 (Instirio): the same "raise the cap" push every turn; owner « suggest, never push ».
    const voice = bySlug.get("client-comms")!.content;
    expect(voice).toMatch(/A next step that serves what they want closes the message, concrete, with its link/);
    expect(voice).toMatch(/An ask or a line they have not answered is not sent again/);
    expect(voice).toMatch(/You suggest, you never push: an idea is offered once/);
    for (const sk of SEED_SKILLS) expect(sk.content, sk.slug).not.toMatch(/Any other question\?/);
  });

  it("a figure doubt goes to the team, never to the client (owner 2026-10-18, the 8-vs-3 reply)", () => {
    const stats = bySlug.get("costs-roi-stats")!.content;
    expect(stats).not.toMatch(/say so plainly/);
    expect(stats).toMatch(/silently; tell the client only what is certain/);
  });

  it("the index keeps inner words away from the user and names every request kind", () => {
    const index = bySlug.get("index")!.content;
    expect(index).toMatch(/Never say Engine, script, tactic, leg/);
    for (const t of ["request_staff", "request_skill_upgrade", "contact_human"]) expect(index).toContain(t);
  });

  // One text serves the Copilot AND an API agent (owner 2026-10-16): the API
  // operation beside each tool costs ~150 tokens on the busiest skills.
  // CLIENT-FRICTION-SKILLS-1103: an outside agent asked "make my WhatsApp line answer my customers and hand over
  // to me when stuck" found no setup in the skills, and connected-accounts said linking had no API route.
  it("a client learns to make their WhatsApp line answer and hand over, from the skills alone (CLIENT-FRICTION-SKILLS-1103)", () => {
    const ca = bySlug.get("connected-accounts")!.content;
    expect(ca).toContain("POST /v1/orgs/matrix/links");
    expect(ca).toContain("GET /v1/orgs/matrix/links");
    expect(ca).not.toContain("GET /v1/orgs/matrix/connections");
    expect(ca).toContain("`whatsapp-line`");
    const wa = bySlug.get("whatsapp-line")!.content;
    for (const w of [
      "PATCH /v1/orgs/matrix/links/{linkId}", "pro_ai", "persona", "PUT /v1/brands/{id}/sales-rep-phone",
      "Lead event", "AI Follow-up Email", "as the business", "Active Follow-up Replies", "no hand-back",
    ]) expect(wa, w).toContain(w);
    expect(bySlug.get("index")!.content).toContain("`whatsapp-line`");
  });

  it("every skill stays small (under ~950 tokens), the index under ~1100", () => {
    for (const s of SEED_SKILLS) {
      const cap = s.slug === "index" ? 4400 : 3900;
      expect(s.content.length, s.slug).toBeLessThan(cap);
    }
  });

  it("an email the user wrote is pushed through their live campaign, never a feature request (COPILOT-PUSH-EMAIL-1014)", () => {
    const e = bySlug.get("emails-you-wrote")!;
    expect(e.parentSlug).toBe("index");
    for (const w of ["email_pushed_via_api", "POST /v1/trigger-events", "needs their yes", "Never request_staff", "The client brings them"]) expect(e.content).toContain(w);
    expect(bySlug.get("index")!.content).toContain("emails-you-wrote");
    // WF-SILENT-FOLLOWUP-1101: outcome "ran" is a run that started, never a sent email; only delivered says sent.
    expect(e.content).not.toContain("ran = sending");
    expect(e.content).toContain("never call that sent");
    expect(e.content).toContain("delivered = sent");
    const r = bySlug.get("staff-requests")!.content;
    expect(r).toContain("## Before filing");
    expect(r.indexOf("GET /v1/sales-funnel-campaigns")).toBeLessThan(r.indexOf("Only then request_staff"));
    expect(r).toContain("find_operation");
  });

  it("the request skill states where each kind lands", () => {
    const c = bySlug.get("staff-requests")!.content;
    for (const w of ["GitHub issue", "team notified", "chat-service", "No issue"]) expect(c).toContain(w);
    // CHAT-TRUTH-1101: the Copilot repeated "it goes to the founder on Telegram" to a client.
    expect(c).not.toContain("Telegram");
    expect(c).not.toContain("founder");
  });
});

describe("funnel campaigns (owner 2026-10-10)", () => {
  const c = SEED_SKILLS.find((s) => s.slug === "campaigns")!.content;
  it("asks max budget AND max volume, creates stopped, starts only after the client's yes", () => {
    for (const w of ["Max budget", "Max volume", "POST /v1/sales-funnel-campaigns", "STOPPED", "/caps", "activate", "their yes"]) {
      expect(c).toContain(w);
    }
    const order = ["POST /v1/sales-funnel-campaigns {", "/caps with both keys", "ask yes or no", "Only after their yes"].map((w) => c.indexOf(w));
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
  it("the index asks for text before the cards and hides path names", () => {
    const index = SEED_SKILLS.find((s) => s.slug === "index")!.content;
    expect(index).toMatch(/TEXT first/);
    expect(index).toMatch(/never show a path's name/);
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
  it("the catalogue skill says only paths and funnels are per paying client", () => {
    const cat = SEED_SKILLS.find((s) => s.slug === "catalogue")!.content;
    expect(cat).toMatch(/Only sales paths and funnels are per paying client/);
    expect(SEED_SKILLS.find((s) => s.slug === "index")!.content).toMatch(/with the unit and basis the API gives/);
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
  it("campaigns and budgets are answered from the campaign list; steps are never campaigns", () => {
    const c = SEED_SKILLS.find((s) => s.slug === "campaigns")!.content;
    expect(c).toMatch(/Count and name only campaigns: a step .* is part of a campaign, never a campaign/);
    const b = SEED_SKILLS.find((s) => s.slug === "budget-and-billing")!.content;
    expect(b).toMatch(/Each campaign's budget: GET \/v1\/sales-funnel-campaigns/);
    expect(b).not.toMatch(/get_campaign_budgets/);
  });
});

describe("the money skill lets the served state speak (SOPHIE-BRIEF-EQUALS-DASHBOARD-1103)", () => {
  it("no 'never mention' rule, and a payment notice is said in the dashboard's words", () => {
    const b = SEED_SKILLS.find((s) => s.slug === "budget-and-billing")!.content;
    // « Postpaid: billing is a non-topic, never mention billing holding a campaign » licensed
    // "nothing is blocking your account" while the dashboard said "Campaigns paused: payment declined".
    expect(b).not.toMatch(/never mention|non-topic/i);
    expect(b).toMatch(/as their dashboard shows it/);
    expect(b).toMatch(/Campaigns paused: payment declined/);
  });
});

describe("no per-step writes in the Copilot's skills (owner 2026-10-10)", () => {
  it("budgets are set_funnel_caps and on/off is the funnel campaign; a source has no budget of its own", () => {
    for (const sk of SEED_SKILLS) expect(sk.content, sk.slug).not.toMatch(/set_campaign_budget|stop_campaign\b|start_campaign\b|activate_campaign/);
    const src = SEED_SKILLS.find((s) => s.slug === "client-profiles")!.content;
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
    expect(bySlug.get("staff")!).toContain("find_sales_funnels(offerId, brandId)");
  });

});

describe("framework v10 only: no removed plays or pipes (SOPHIE-TURN-LOST-1103, prod 2026-11-03)", () => {
  const bySlug = new Map(SEED_SKILLS.map((s) => [s.slug, s]));
  // Sophie read `catalogue-plays`, called GET /v1/plays and hunted 50 s for a route,
  // while the client left: no skill she can read names a removed object.
  const REMOVED = /\bplays?\b|\bpipes?\b|find_plays|find_pipes|create_pipe|create_play|\/v1\/plays|\/v1\/catalogue\/pipes|catalogue-plays|catalogue-pipes/i;

  it("no seed skill names a play or a pipe", () => {
    for (const s of SEED_SKILLS) {
      expect(`${s.title}\n${s.description}\n${s.content}`, s.slug).not.toMatch(REMOVED);
    }
  });

  it("the guard catches both spellings (dry-run both ways)", () => {
    expect("Load `catalogue-plays`").toMatch(REMOVED);
    expect("find_pipes → GET /v1/catalogue/pipes").toMatch(REMOVED);
    expect("a playbook for the display").not.toMatch(REMOVED);
  });

  it("the old slugs answer the v10 skill, which names the framework objects", () => {
    expect(MERGED_SKILL_SLUGS["catalogue-plays"]).toBe("gtm-factory");
    expect(MERGED_SKILL_SLUGS["catalogue-pipes"]).toBe("gtm-factory");
    const c = bySlug.get("gtm-factory")!.content;
    for (const w of ["**Campaign**", "**Engine**", "**Script**", "**Tactic**", "**Strategy**", "**Provider**", "**Plan**", "GET /v1/scripts", "engine-picks"]) {
      expect(c, w).toContain(w);
    }
  });

  it("'my emails never say X' is read, answered and handed to the team, never a long search", () => {
    expect(bySlug.get("index")!.content).toMatch(/emails never mention our flat rate.*`offers`/);
    const c = bySlug.get("offers")!.content;
    expect(c).toContain("## What the emails say");
    expect(c).toContain("GET /v1/emails?brandId=&limit=5");
    expect(c).toContain("GET /v1/brands/{id}/offers/{offerId}");
    expect(c).toMatch(/never search for one/);
  });

  it("offers says uploading documents is half the setup", () => {
    const c = bySlug.get("offers")!.content;
    expect(c).toMatch(/Uploading is half the setup/);
    expect(c).toMatch(/what the file is and when it helps a prospect/);
  });

  it("campaigns explains part ids", () => {
    const c = bySlug.get("campaigns")!.content;
    expect(c).toMatch(/one part per step/);
    expect(c).toMatch(/salesFunnelCampaignId/);
  });

  it("documents: description wording matches the API field, near-duplicates go to the client", () => {
    const c = bySlug.get("offers")!.content;
    expect(c).not.toMatch(/when NOT/);
    expect(c).toMatch(/Near-duplicates/);
    expect(c).toMatch(/Never delete or rewrite a client's file unasked/);
  });

});

describe("triggers skill (OUTCOME-TRIGGERS-CALLABLE-1015)", () => {
  it("says which triggers an outside call may fire, and where to read it", () => {
    const t = SEED_SKILLS.find((x) => x.slug === "triggers")!.content;
    for (const w of ["callable:false", "POST /v1/trigger-events", "distribute_list_triggers", "GET /v1/public/channels"]) expect(t).toContain(w);
  });
});

describe("one skill text, two readers (standard vocabulary, owner 2026-10-16)", () => {
  const tools = Object.keys(TOOL_REGISTRY);

  it("every Copilot tool a skill names comes with its API operation, or says there is no API route yet", () => {
    for (const s of SEED_SKILLS) {
      const gaps = skillApiGaps(s.content, tools);
      expect(gaps, s.slug).toEqual({ missing: [], unmapped: [] });
    }
  });

  it("the guard catches a bare tool and an unmapped one (dry-run both ways)", () => {
    expect(skillApiGaps("- find_steps: all steps.", tools).missing).toEqual(["find_steps"]);
    expect(skillApiGaps("- find_steps → GET /v1/catalogue/steps", tools).missing).toEqual([]);
    expect(skillApiGaps("- declare_channel (no API route yet)", tools).missing).toEqual([]);
    expect(skillApiGaps("- fork_workflow it", tools).unmapped).toEqual(["fork_workflow"]);
  });

  it("every mapped tool exists in the registry", () => {
    for (const tool of Object.keys(COPILOT_TOOL_API_OPS)) expect(TOOL_REGISTRY[tool], tool).toBeDefined();
  });

  it("the index tells an API reader how to read the tools", () => {
    expect(SEED_SKILLS[0].content).toMatch(/Reading this through the API or the MCP\?/);
  });

  it("an outside agent files a request the way the Copilot does, a new outcome or trigger included", () => {
    const r = SEED_SKILLS.find((s) => s.slug === "staff-requests")!.content;
    for (const w of ["POST /v1/staff-requests", "GET /v1/staff-requests", "newStepOrTrigger", "kind feature", "skill_upgrade", "contact_human"]) {
      expect(r, w).toContain(w);
    }
    for (const slug of ["triggers", "catalogue-steps"]) {
      expect(SEED_SKILLS.find((s) => s.slug === slug)!.content, slug).toContain("POST /v1/staff-requests");
    }
  });

  it("no skill tells an agent to create an outcome or trigger row", () => {
    for (const s of SEED_SKILLS) {
      expect(s.content, s.slug).not.toMatch(/create_step|declare_trigger_type|POST \/v1\/catalogue\/(steps|triggers)/);
    }
  });

  it("one skill per topic: channels and sales paths live under the catalogue; the old slugs answer the merged skill", () => {
    const slugs = new Set(SEED_SKILLS.map((s) => s.slug));
    expect(MERGED_SKILL_SLUGS).toEqual({
      channels: "gtm-factory",
      legs: "gtm-factory",
      "catalogue-channels": "gtm-factory",
      "catalogue-workflows": "gtm-factory",
      "workflows-and-templates": "gtm-factory",
      "infra-build-workflow": "infra-build-script",
      "sales-paths": "catalogue-sales-paths",
      qualification: "client-profiles",
      sources: "client-profiles",
      "catalogue-pipes": "gtm-factory",
      "catalogue-plays": "gtm-factory",
    });
    for (const [old, into] of Object.entries(MERGED_SKILL_SLUGS)) {
      expect(slugs.has(old), old).toBe(false);
      expect(slugs.has(into), into).toBe(true);
    }
    expect(SEED_SKILLS.find((s) => s.slug === "catalogue-sales-paths")!.content).toContain("list_sales_paths(brandId, offerId)");
    for (const s of SEED_SKILLS) expect(s.content, s.slug).not.toMatch(/`(channels|sales-paths)`|see (channels|sales-paths)\b/);
  });

  it("which script runs is the Rating's pick, never by hand (framework v10)", () => {
    expect(SEED_SKILLS.find((s) => s.slug === "gtm-factory")!.content).toMatch(/The Rating picks one per run: never picked by hand/);
  });
});

describe("campaign next steps: queued means every channel (NEXT-STEPS-ALL-CHANNELS-1019)", () => {
  // A follow-up campaign writing in Gmail threads and WhatsApp queues nothing in the email sender: reading
  // leadsAwaitingFirstEmail alone told a client "nothing queued" beside 47 people scheduled for Monday.
  it("the stats skill and the tool read nextSends, never the sender's first-email count alone", () => {
    const skill = SEED_SKILLS.find((s) => s.slug === "costs-roi-stats")!;
    expect(skill.content).toContain("nextSends.leadsQueued");
    expect(skill.content).toContain("nextSends.nextSendAt");
    expect(skill.content).not.toContain("leadsAwaitingFirstEmail");
    const tool = TOOL_REGISTRY.get_campaign_next_steps;
    expect(tool.description).toContain("nextSends.leadsQueued");
    expect(tool.description).not.toContain("leadsAwaitingFirstEmail");
  });
});

describe("campaign next steps: the reply-timing line is always said (CAMPAIGN-NEXT-STEPS-1018)", () => {
  // Prod 2026-10-19: with timeToFirstPositiveReply learning: true the Copilot said nothing about replies,
  // reading "too early to tell, no number" as "skip it". Not measured = say it is too early, in plain words.
  it("the stats skill and the tool tell the agent to always say when replies come, with no invented figure", () => {
    const skill = SEED_SKILLS.find((s) => s.slug === "costs-roi-stats")!;
    expect(skill.content).toContain("ALWAYS say it, never skip this line");
    expect(skill.content).toContain("It is too early to say how long replies take on this campaign.");
    expect(skill.content).not.toMatch(/about \d+ days/);
    const tool = TOOL_REGISTRY.get_campaign_next_steps;
    expect(tool.description).toContain("never skip the reply-timing line");
    expect(tool.description).not.toMatch(/about \d+ days/);
  });

  // API-ONBOARD-SKILL-1023: an API agent on a new account (prod 2026-10-22, walletwallet.dev) read
  // index, offers, client-profiles, campaigns and found no setup path; it created the brand and
  // offer by trial and error, then its user finished on the dashboard and never paid.
  it("the index sends a new account to the setup skill before any other job", () => {
    const index = SEED_SKILLS[0].content;
    expect(index).not.toMatch(/^You are the distribute\.you Copilot/);
    expect(index.indexOf("`new-account`")).toBeGreaterThan(-1);
    expect(index.indexOf("`new-account`")).toBeLessThan(index.indexOf("`campaigns`"));
    expect(index).not.toContain("find_steps");
  });

  it("the setup skill walks brand, offer, target, audiences, preview, payment, start in order", () => {
    const c = SEED_SKILLS.find((s) => s.slug === "new-account")!.content;
    const order = [
      "POST /v1/agent-signups/start",
      "POST /v1/brands with",
      "POST /v1/brands/{id}/offers/proposals",
      "POST /v1/brands/{id}/offers/confirm",
      "POST /v1/content/preview-email/prepare",
      "POST /v1/brands/{id}/icp/suggest",
      "POST /v1/orgs/audiences/split ",
      "POST /v1/orgs/audiences/split/confirm",
      "GET /v1/orgs/audiences/{id}/preview",
      "POST /v1/content/preview-email {",
      "GET /v1/offers/{offerId}/sales-funnels",
      "POST /v1/billing/accounts/prepaid_checkout",
      "POST /v1/orgs/audiences/portfolio",
      "`campaigns`",
    ];
    const at = order.map((w) => c.indexOf(w));
    for (const [i, pos] of at.entries()) expect(pos, order[i]).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("the setup skill states the refusals the first agent hit, and keeps the ids it needs", () => {
    const c = SEED_SKILLS.find((s) => s.slug === "new-account")!.content;
    expect(c).toMatch(/\{url, name\}.*or \{name\} alone/);
    expect(c).toContain("chosenIndex");
    expect(c).toContain("chosenOfferId");
    expect(c).toContain("never a placeholder in a path");
    expect(c).toContain("402 payment_required");
  });

  // Gaps found by the MCP role-play on the staff org (2026-10-23): the offer's price never
  // reached the estimates, and the preview promised a free trial the client never offered.
  it("the setup skill records what a client is worth and checks the preview for invented claims", () => {
    const c = SEED_SKILLS.find((s) => s.slug === "new-account")!.content;
    expect(c).toContain("PUT /v1/brands/{id}/offers/{offerId}/economics");
    expect(c).toContain("lifetimeRevenueUsd");
    expect(c).toMatch(/claim your user never made/);
    expect(c.indexOf("economics")).toBeLessThan(c.indexOf("POST /v1/content/preview-email {"));
  });

  it("the setup skill never pays or starts without the user's yes", () => {
    const c = SEED_SKILLS.find((s) => s.slug === "new-account")!.content;
    expect(c).toMatch(/Prepay, after their yes/);
    expect(c).toMatch(/Start, after their yes/);
    expect(c).toContain("Never pay or start on your own");
    expect(c.indexOf("Before 7, stop")).toBeGreaterThan(c.indexOf("POST /v1/billing/accounts/prepaid_checkout"));
    expect(c).not.toMatch(/agency/i);
  });

  it("campaigns and client-profiles point a new account to the setup skill", () => {
    for (const slug of ["campaigns", "client-profiles"]) {
      expect(SEED_SKILLS.find((s) => s.slug === slug)!.content, slug).toContain("`new-account`");
    }
    const cp = SEED_SKILLS.find((s) => s.slug === "client-profiles")!.content;
    expect(cp).toContain("POST /v1/orgs/audiences/split/confirm");
  });
});

describe("framework v10 only: no legs, channels or workflows as live objects (SOPHIE-TRUTH-1105)", () => {
  // Owner 2026-11-03: pipes, legs, channels, plays and workflows are removed from our vocabulary; the
  // objects are Engine, Script, tactic, strategy, Provider, Plan, Campaign. API paths, body fields and
  // service names keep their spelling (an API reader needs them verbatim), and the index / client-comms
  // "never say" lists name the words to keep away from a client.
  const REMOVED = /\blegs?\b|\bchannels?\b|\bworkflows?\b|\bpipes?\b|\bplays?\b|find_channels|find_workflows|declare_leg|declare_channel|set_leg_rates|get_leg_rates|list_workflows/i;
  const prose = (text: string) =>
    text
      .split("\n")
      .filter((l) => !/Never say Engine|Internal names and words/.test(l))
      .join("\n")
      .replace(/\S*\/\S*/g, " ") // API paths (/v1/public/channels, {channel}/...)
      .replace(/\{[^}]*\}/g, " ") // request bodies
      .replace(/\b[a-z]+(?:-[a-z]+)*-service\b/g, " "); // service names

  it("no served skill names a leg, a channel, a workflow, a pipe or a play", () => {
    for (const s of SEED_SKILLS) expect(prose(`${s.title}\n${s.description}\n${s.content}`), s.slug).not.toMatch(REMOVED);
  });

  it("the guard catches the old words and spares paths and service names (dry-run both ways)", () => {
    expect(prose("find_channels(forPaths) → GET /v1/catalogue/channels")).toMatch(REMOVED);
    expect(prose("A leg is the move of a lead")).toMatch(REMOVED);
    expect(prose("A workflow is the program")).toMatch(REMOVED);
    expect(prose("GET /v1/public/channels, repo workflow-service, {channel: \"whatsapp\"}")).not.toMatch(REMOVED);
  });

  it("the removed skills answer the v10 skill", () => {
    const slugs = new Set(SEED_SKILLS.map((s) => s.slug));
    for (const old of ["legs", "catalogue-channels", "catalogue-workflows", "workflows-and-templates"]) {
      expect(slugs.has(old), old).toBe(false);
      expect(MERGED_SKILL_SLUGS[old], old).toBe("gtm-factory");
    }
    for (const target of Object.values(MERGED_SKILL_SLUGS)) expect(slugs.has(target), target).toBe(true);
  });
});

describe("Sophie tells only what a served fact says (SOPHIE-TRUTH-1105, prod 2026-11-04 Beyond Logic)", () => {
  const bySlug = new Map(SEED_SKILLS.map((s) => [s.slug, s.content]));

  it("a fact about a person comes from that person's own record, never from a list (Neil never replied)", () => {
    const index = bySlug.get("index")!;
    expect(index).toMatch(/A fact about a person .* comes only from that person's own record read this turn/);
    expect(index).toContain("GET /v1/leads/{id}/timeline");
    expect(index).toContain("filtersNotDocumented");
  });

  it("a reply waits only when the latest message of their conversation is theirs (Edmund was answered three times)", () => {
    const stats = bySlug.get("costs-roi-stats")!;
    expect(stats).not.toMatch(/Replies waiting for the client: GET/);
    expect(stats).toMatch(/Answered or not: this list never says who still waits/);
    expect(stats).toMatch(/only when the latest message of that person's conversation is theirs/);
    expect(stats).toContain("GET /v1/conversations?campaign_id=&email=");
  });

  it("a money figure is said with its scope, never two scopes side by side", () => {
    expect(bySlug.get("index")!).toMatch(/quote one figure with its scope, never two of different scopes side by side/);
    expect(bySlug.get("costs-roi-stats")!).toMatch(/A since-start figure below a this-month one is two bases/);
    expect(bySlug.get("budget-and-billing")!).toMatch(/"How much did I spend\?" = the dashboard's Spent/);
  });

  it("off-target people: sharpen the audience's target text, never just pause it", () => {
    const c = bySlug.get("client-profiles")!;
    expect(c).toMatch(/sharpen that text, never just pause it/);
    expect(c).toContain("PATCH /v1/orgs/audiences/{id} {nlPrompt: the new text}");
  });

  it("a campaign rule goes into its brief, never the retired instruction field (ONE-BRIEF-1105)", () => {
    const c = bySlug.get("campaigns")!;
    expect(c).toContain("PATCH /v1/sales-funnel-campaigns/{id} {brief: the whole new text}");
    expect(c).toMatch(/Never the instruction field/);
    for (const [slug, text] of bySlug) expect(text, slug).not.toMatch(/\{[^}]*\binstruction\b[^}]*\}/);
  });
});

describe("a campaign rule reaches the brief from every door (SOPHIE-TRUTH-1105 eval: '$25k only' went to targeting and never wrote it)", () => {
  it("the index and the targeting skill both send a rule in the client's words to the brief", () => {
    const by = new Map(SEED_SKILLS.map((s) => [s.slug, s.content]));
    expect(by.get("index")!).toMatch(/A rule for a campaign in their words .* write it into that campaign's brief now/);
    expect(by.get("client-profiles")!).toMatch(/write it into the campaign's brief first/);
  });
});

// SOPHIE-NO-FALSE-READY-1111 (prod 2026-11-11): every email preview failed, a bug was filed, and the
// reply still called the campaign "fully set up" and offered to start it. The skills state the system
// fact the agent lacked: the preview runs the campaign's own writer, so a refused preview means the
// campaign cannot send, and the start waits for it.
describe("a step that cannot run holds the start (SOPHIE-NO-FALSE-READY-1111)", () => {
  it("new-account and campaigns say a refused preview means no email can go out and the start waits", () => {
    const by = new Map(SEED_SKILLS.map((s) => [s.slug, s.content]));
    expect(by.get("new-account")!).toMatch(/The preview runs the same writer as the campaign: a refused preview .* no email can go out yet.* step 8 waits until a preview works/s);
    expect(by.get("campaigns")!).toMatch(/A step that cannot run today .* the start waits for it/s);
  });
});
