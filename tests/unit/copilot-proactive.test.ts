import { describe, it, expect, vi } from "vitest";
import {
  buildProactiveTriggerMessage,
  isProactiveReadTool,
  pickProactiveRecipient,
  processProactiveTurn,
  proactiveToolNames,
  type ProactiveDeps,
  type ProactiveRecipient,
} from "../../src/lib/copilot-proactive.js";
import type { ChannelMessageRequest, ProactiveTurnRequest } from "../../src/schemas.js";

// Every tool name the chat service declares (src/lib/*.ts, 2026-10-19).
const ALL_TOOLS = (
  "add_offer_step archive_qualification_check browse_url cancel_followup check_provider_requirements confirm_switch_on contact_human correct_person " +
  "create_brand_from_url create_feature create_followup create_funnel_campaign create_offer create_persona create_pipe create_play create_qualification_check " +
  "create_sales_funnel create_sales_path create_strategy create_tactic create_workflow declare_channel declare_leg declare_sales_path discover_endpoint " +
  "discover_service_endpoints discover_services duplicate_persona extract_brand_fields find_channels find_people find_pipes find_plays find_sales_funnels " +
  "find_sales_paths find_steps find_strategies find_tactics find_workflows fire_followup fork_workflow generate_audience_avatar get_billing_account " +
  "get_brand_pause get_brand_profile get_campaign get_campaign_next_steps get_daily_budget get_feature get_feature_inputs get_feature_stats get_funnel_caps " +
  "get_key_source get_leg_rates get_offer_performance get_offer_sourcing get_offer_steps get_org_usage get_prompt_template get_spend_by_campaign " +
  "get_trigger_events get_workflow_details get_workflow_required_providers launch_campaign list_audiences list_brands list_campaigns list_connected_accounts " +
  "list_declared_channels list_declared_legs list_declared_sales_paths list_features list_followups list_funnel_campaigns list_key_sources list_offers " +
  "list_org_keys list_people_corrections list_people_organizations list_personas list_qualification_checks list_qualification_sources list_recent_runs " +
  "list_replies_to_handle list_sales_paths list_service_endpoints list_services list_sourcing_origins list_staff_requests list_trigger_types list_workflows " +
  "merge_people open_page prefill_feature present_choices propose_switch_on read_skill refresh_audience_count refresh_brand_profile_from_website remove_offer_step " +
  "rename_audience request_skill_upgrade request_staff request_user_input save_brand_profile_version set_audience_status set_brand_pause set_daily_budget " +
  "set_funnel_caps set_leg_rates set_persona_status start_sign_in complete_sign_in stop_campaign stop_funnel_campaign suggest_audiences suggest_qualification_checks " +
  "test_endpoint undo_people_correction undo_people_merge update_campaign_fields update_feature update_followup update_prompt_template " +
  "update_qualification_check upgrade_workflow validate_workflow"
).split(" ");

describe("proactive turn tools", () => {
  it("keeps reads only: nothing that creates, starts, stops, sends, spends or files a request", () => {
    const kept = proactiveToolNames(ALL_TOOLS);
    expect(kept.length).toBeGreaterThan(30);
    for (const name of kept) {
      expect(name).toMatch(/^(get_|list_|find_)|^read_skill$/);
    }
    for (const write of [
      "propose_switch_on", "confirm_switch_on", "launch_campaign", "create_funnel_campaign", "create_followup", "fire_followup",
      "set_funnel_caps", "set_daily_budget", "stop_funnel_campaign", "request_staff", "contact_human", "present_choices", "open_page",
      "request_user_input", "test_endpoint", "start_sign_in", "browse_url", "merge_people", "upgrade_workflow",
    ]) {
      expect(isProactiveReadTool(write)).toBe(false);
    }
  });
});

const REQ: ProactiveTurnRequest = {
  kind: "hot_lead",
  idempotencyKey: "fact-1",
  orgId: "11111111-1111-4111-8111-111111111111",
  brandId: "22222222-2222-4222-8222-222222222222",
  lead: { leadId: "lead-9", name: "Marie Dupont", company: "Acme", email: "marie@acme.example" },
  inbound: { channel: "email", text: "Can you   run our outbound?" },
};

describe("buildProactiveTriggerMessage", () => {
  it("states the facts and the game: one short message, one proposal, ends asking for go, nothing done now", () => {
    const m = buildProactiveTriggerMessage(REQ);
    expect(m).toContain("Marie Dupont");
    expect(m).toContain("Acme");
    expect(m).toContain("lead id: lead-9");
    expect(m).toContain('"Can you run our outbound?"');
    expect(m).toContain("ONE concrete proposal");
    expect(m).toContain("asking the team for their go");
    expect(m).toContain("nothing happens for them until a person of the team says go");
    expect(m).not.toMatch(/[—–]/);
  });
});

/** A db fake answering selects from a queue, recording updates. */
function fakeDb(selects: unknown[][]) {
  const updates: Array<Record<string, unknown>> = [];
  const queue = [...selects];
  const next = () => queue.shift() ?? [];
  const chain = () => {
    const rows = next();
    const p = Promise.resolve(rows) as Promise<unknown[]> & { orderBy: () => unknown };
    p.orderBy = () => ({ limit: () => Promise.resolve(rows) });
    return p;
  };
  const db = {
    select: () => ({ from: () => ({ where: chain }) }),
    update: () => ({ set: (s: Record<string, unknown>) => ({ where: () => { updates.push(s); return Promise.resolve(); } }) }),
  };
  return { db: db as unknown as ProactiveDeps["db"], updates };
}

const INBOUND: ChannelMessageRequest = {
  channel: "whatsapp",
  messageId: "$e",
  orgId: "99999999-9999-4999-8999-999999999999",
  brandId: "88888888-8888-4888-8888-888888888888",
  accountUserId: "77777777-7777-4777-8777-777777777777",
  fromAccount: "+77776879632",
  assistant: { name: "Ava", role: null, instructions: null },
  sender: { phone: "+33600000000", name: "Owner" },
  text: "hi",
  at: "2026-10-19T09:00:00Z",
  thread: [],
};

describe("pickProactiveRecipient", () => {
  it("picks the latest customer member over a more recent staff member, with the WhatsApp hop of their thread", async () => {
    const { db } = fakeDb([
      [
        { id: "s-staff", userId: "u-staff", channelPhone: null },
        { id: "s-owner", userId: "u-owner", channelPhone: "+33600000000" },
        { id: "s-owner-old", userId: "u-owner", channelPhone: null },
      ],
      [{ payload: INBOUND }],
    ]);
    const r = await pickProactiveRecipient(
      { db, fetchEmail: async (u) => (u === "u-staff" ? "kevin@distribute.you" : "owner@acme.example"), isStaffEmail: (e) => e === "kevin@distribute.you" },
      REQ.orgId,
    );
    expect(r).toEqual({ userId: "u-owner", sessionId: "s-owner", whatsapp: { phone: "+33600000000", inbound: INBOUND } });
  });

  it("a user with no known email never outranks a known team member (prod population, distribute.you org 2026-10-19)", async () => {
    const { db } = fakeDb([
      [
        { id: "s-gmail", userId: "cfe148ed", channelPhone: "+33680478702" },
        { id: "s-dy", userId: "7b417d70", channelPhone: null },
        { id: "s-null", userId: "d2317462", channelPhone: null },
      ],
      [{ payload: INBOUND }],
    ]);
    const emails: Record<string, string | null> = { cfe148ed: "kevin.lourd@gmail.com", "7b417d70": "kevin@distribute.you", d2317462: null };
    const r = await pickProactiveRecipient(
      { db, fetchEmail: async (u) => emails[u], isStaffEmail: (e) => e === "kevin.lourd@gmail.com" || e === "kevin@distribute.you" },
      REQ.orgId,
    );
    expect(r).toEqual({ userId: "cfe148ed", sessionId: "s-gmail", whatsapp: { phone: "+33680478702", inbound: INBOUND } });
  });

  it("on an org where everyone is staff, the latest staff member; nobody ever used the Copilot → null", async () => {
    const staffOnly = fakeDb([[{ id: "s-1", userId: "u-1", channelPhone: null }]]);
    expect(await pickProactiveRecipient({ db: staffOnly.db, fetchEmail: async () => "kevin@distribute.you", isStaffEmail: () => true }, REQ.orgId))
      .toEqual({ userId: "u-1", sessionId: "s-1", whatsapp: null });
    const empty = fakeDb([[]]);
    expect(await pickProactiveRecipient({ db: empty.db, fetchEmail: async () => null, isStaffEmail: () => false }, REQ.orgId)).toBeNull();
  });
});

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
const ROW = { id: "turn-1", kind: "hot_lead", orgId: REQ.orgId, brandId: REQ.brandId, parentRunId: "run-1", status: "processing", payload: REQ };

describe("processProactiveTurn", () => {
  const whatsappRecipient: ProactiveRecipient = { userId: "u-owner", sessionId: "s-owner", whatsapp: { phone: "+33600000000", inbound: INBOUND } };

  it("sends the answer once on WhatsApp from the linked account, keyed on the turn", async () => {
    const { db, updates } = fakeDb([[ROW]]);
    const runChat = vi.fn(async () => ({ status: 200, body: sse({ type: "token", content: "Marie from Acme wants outbound. Start the Outbound offer at $10/day? Go?" }) }));
    const sendWhatsapp = vi.fn(async () => {});
    await processProactiveTurn({ db, fetchEmail: async () => null, isStaffEmail: () => false, runChat, sendWhatsapp }, "turn-1", whatsappRecipient, { "x-campaign-id": "c-1" });
    expect(runChat).toHaveBeenCalledTimes(1);
    const args = (runChat.mock.calls[0] as unknown as [Parameters<ProactiveDeps["runChat"]>[0]])[0];
    expect(args).toMatchObject({ orgId: REQ.orgId, userId: "u-owner", runId: "run-1", sessionId: "s-owner", proactiveTurnId: "turn-1", trackingHeaders: { "x-campaign-id": "c-1" } });
    expect((args.context.channel as { assistant: { name: string } }).assistant.name).toBe("Ava");
    expect(sendWhatsapp).toHaveBeenCalledWith(expect.objectContaining({
      orgId: INBOUND.orgId, brandId: INBOUND.brandId, userId: INBOUND.accountUserId, phone: "+33600000000", fromAccount: INBOUND.fromAccount,
      idempotencyKey: "copilot-proactive:turn-1",
    }));
    expect(updates.at(-1)).toMatchObject({ status: "delivered", error: null });
  });

  it("out of credits: stored in the thread, nothing sent to a phone", async () => {
    const { db, updates } = fakeDb([[ROW]]);
    const sendWhatsapp = vi.fn(async () => {});
    await processProactiveTurn(
      { db, fetchEmail: async () => null, isStaffEmail: () => false, sendWhatsapp,
        runChat: async () => ({ status: 200, body: sse({ type: "token", content: "You're out of credits." }, { type: "credits_required", message: "You're out of credits.", label: "Add credits" }) }) },
      "turn-1", whatsappRecipient, {},
    );
    expect(sendWhatsapp).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ status: "out_of_credits" });
  });

  it("a row no longer processing runs nothing (never twice)", async () => {
    const { db } = fakeDb([[{ ...ROW, status: "delivered" }]]);
    const runChat = vi.fn();
    await processProactiveTurn({ db, fetchEmail: async () => null, isStaffEmail: () => false, runChat, sendWhatsapp: vi.fn() }, "turn-1", whatsappRecipient, {});
    expect(runChat).not.toHaveBeenCalled();
  });

  it("a failed turn is recorded failed with its reason, nothing sent", async () => {
    const { db, updates } = fakeDb([[ROW]]);
    const sendWhatsapp = vi.fn();
    await processProactiveTurn({ db, fetchEmail: async () => null, isStaffEmail: () => false, sendWhatsapp, runChat: async () => ({ status: 502, body: "boom" }) }, "turn-1", whatsappRecipient, {});
    expect(sendWhatsapp).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ status: "failed", error: "POST /chat 502: boom" });
  });
});
