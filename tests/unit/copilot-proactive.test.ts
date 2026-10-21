import { describe, it, expect, vi } from "vitest";
import { WhatsappSendError } from "../../src/lib/channel-copilot.js";
import {
  DELIVERY_RETRY_DELAYS_MS,
  buildProactiveTriggerMessage,
  isRetryableDelivery,
  readPersonThread,
  isProactiveReadTool,
  pickProactiveRecipient,
  processProactiveTurn,
  proactiveToolNames,
  withoutAskingCampaign,
  type ProactiveDeps,
  type ProactiveRecipient,
} from "../../src/lib/copilot-proactive.js";
import type { ChannelMessageRequest, ProactiveTurnRequest } from "../../src/schemas.js";
import type { AskingCampaign } from "../../src/lib/funnel-campaign-client.js";

// The prod case (2026-10-19, org f0420eb5): the header named the STEP e81d3018,
// list_campaigns showed its funnel campaign ba08bcca by the name "Lead Proposal Deals".
const ASKING: AskingCampaign = {
  ids: ["e81d3018-0cae-456b-90a3-0290071c6cb8", "ba08bcca-084d-4a85-bebc-465330ed77de"],
  name: "Lead Proposal Deals",
  salesFunnelId: "start_to_paid_client@ai-lead-proposal",
  channel: "ai-lead-proposal",
};
const resolveAskingCampaign = async () => ASKING;

// Every tool name the chat service declares (src/lib/*.ts, 2026-10-19).
const ALL_TOOLS = (
  "add_offer_step archive_qualification_check browse_url cancel_followup check_provider_requirements confirm_switch_on contact_human correct_person " +
  "create_brand_from_url create_feature create_followup create_funnel_campaign create_offer create_persona create_pipe create_play create_qualification_check " +
  "create_sales_funnel create_sales_path create_strategy create_tactic create_workflow declare_channel declare_leg declare_sales_path discover_endpoint " +
  "discover_service_endpoints discover_services duplicate_persona extract_brand_fields find_channels find_people find_pipes find_plays find_sales_funnels " +
  "find_sales_paths find_steps find_strategies find_tactics find_workflows fire_followup fork_workflow generate_audience_avatar get_billing_account " +
  "get_brand_pause get_brand_profile get_campaign get_campaign_next_steps get_daily_budget get_feature get_feature_inputs get_feature_stats get_funnel_caps " +
  "get_key_source get_leg_rates get_offer_performance get_offer_settings get_offer_sourcing get_offer_steps get_org_usage get_prompt_template get_spend_by_campaign " +
  "get_trigger_events get_workflow_details get_workflow_required_providers launch_campaign list_audiences list_brands list_campaigns list_connected_accounts " +
  "list_declared_channels list_declared_legs list_declared_sales_paths list_features list_followups list_funnel_campaigns list_key_sources list_offers " +
  "list_org_keys list_people_corrections list_people_organizations list_personas list_qualification_checks list_qualification_sources list_recent_runs " +
  "list_replies_to_handle list_sales_paths list_service_endpoints list_services list_sourcing_origins list_staff_requests list_trigger_types list_workflows " +
  "merge_people open_page prefill_feature present_choices propose_switch_on read_skill refresh_audience_count refresh_brand_profile_from_website remove_offer_step " +
  "rename_audience request_skill_upgrade request_staff request_user_input save_brand_profile_version set_audience_status set_brand_pause set_daily_budget " +
  "set_funnel_caps set_leg_rates set_persona_status start_sign_in complete_sign_in stop_campaign stop_funnel_campaign suggest_audiences suggest_qualification_checks " +
  "test_endpoint undo_people_correction undo_people_merge update_campaign_fields update_feature update_followup update_prompt_template " +
  "update_offer_settings update_qualification_check upgrade_workflow validate_workflow"
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

  it("names the asking campaign by the name, funnel and channel the team sees, as the notification itself", () => {
    const m = buildProactiveTriggerMessage(REQ, { thread: [], asking: ASKING });
    expect(m).toContain('The campaign that asked you is "Lead Proposal Deals" (funnel start_to_paid_client@ai-lead-proposal, channel ai-lead-proposal): it IS this notification');
    expect(m).toContain("never writes to the person");
    expect(m).toContain("hidden from your reads in this turn");
    expect(m).toContain("what to set up FOR THEM");
    expect(m).toContain("never answer that nothing new is needed");
    expect(m).not.toContain("e81d3018");
  });

  it("quotes the person's own message from their thread when the caller sent no text", () => {
    const m = buildProactiveTriggerMessage(
      { ...REQ, inbound: undefined },
      {
        asking: null,
        thread: [
          { at: "2026-10-18T10:00:00Z", direction: "outbound", channel: "email", text: "Hi Jose, saw you signed up." },
          { at: "2026-10-19T06:30:00Z", direction: "inbound", channel: "email", text: "We need   200 law firms\nas clients, can you help?" },
        ],
      },
    );
    expect(m).toContain('THEY wrote on email (2026-10-19T06:30:00Z): "We need 200 law firms as clients, can you help?"');
    expect(m).toContain("a short quote of their own words");
    expect(m).not.toContain("could not read a message");
  });

  it("with no words from the person, says so instead of inventing a quote", () => {
    const m = buildProactiveTriggerMessage({ ...REQ, inbound: undefined });
    expect(m).toContain("you could not read a message from them and move on");
    expect(m).toContain("never describe what else their thread holds");
  });

  it("never lets the model gender a person whose pronouns are unknown", () => {
    const m = buildProactiveTriggerMessage(REQ);
    expect(m).toContain("never he or she");
    expect(m).toContain("they/them");
  });
});

describe("withoutAskingCampaign", () => {
  // list_campaigns as the model sees it (listAccountCampaigns rows), the asking one by its funnel name.
  const LIST = {
    campaignCount: 2,
    campaigns: [
      { id: "ba08bcca-084d-4a85-bebc-465330ed77de", name: "Lead Proposal Deals", status: "ongoing", budget: "Up to $10/week", salesFunnelId: "start_to_paid_client@ai-lead-proposal" },
      { id: "sfc-outbound", name: "Outbound Deals", status: "ongoing", budget: "Max $10/day", salesFunnelId: "lead_found_to_paid_client@cold-email" },
    ],
    note: "A campaign is a sales funnel campaign.",
  };

  it("drops the asking funnel campaign from list_campaigns, so the turn cannot propose it", () => {
    const out = withoutAskingCampaign("list_campaigns", LIST, ASKING) as typeof LIST & { hidden: string };
    expect(out.campaigns.map((c) => c.name)).toEqual(["Outbound Deals"]);
    expect(out.campaignCount).toBe(1);
    expect(out.hidden).toContain('"Lead Proposal Deals"');
    expect(out.hidden).toContain("never acts for the person");
    expect(JSON.stringify(out.campaigns)).not.toContain("Lead Proposal");
  });

  it("drops it from list_funnel_campaigns and from the staff unit rows (by unit id or its funnel campaign)", () => {
    expect((withoutAskingCampaign("list_funnel_campaigns", LIST, ASKING) as typeof LIST).campaigns).toHaveLength(1);
    const units = {
      shown: 2,
      campaigns: [
        { id: "e81d3018-0cae-456b-90a3-0290071c6cb8", name: "Lead Proposal Deals ba08bcca - ai-lead-proposal", salesFunnelCampaignId: "ba08bcca-084d-4a85-bebc-465330ed77de" },
        { id: "unit-2", name: "Outbound", salesFunnelCampaignId: "sfc-outbound" },
      ],
    };
    const out = withoutAskingCampaign("list_campaigns", units, ASKING) as typeof units;
    expect(out.campaigns.map((c) => c.id)).toEqual(["unit-2"]);
    expect(out.shown).toBe(1);
  });

  it("drops its sales funnel from the catalogue, list and detail", () => {
    const rows = { rows: [{ id: "start_to_paid_client@ai-lead-proposal" }, { id: "lead_found_to_paid_client@cold-email" }] };
    expect((withoutAskingCampaign("find_sales_funnels", rows, ASKING) as typeof rows).rows).toEqual([{ id: "lead_found_to_paid_client@cold-email" }]);
    const detail = withoutAskingCampaign("find_sales_funnels", { id: "start_to_paid_client@ai-lead-proposal", name: "AI Lead Proposal" }, ASKING);
    expect(detail).toEqual({ id: "start_to_paid_client@ai-lead-proposal", hidden: expect.stringContaining("asked you to notify the team") });
  });

  it("leaves every other result untouched", () => {
    const other = { ...LIST, campaigns: LIST.campaigns.slice(1) };
    expect(withoutAskingCampaign("list_campaigns", other, ASKING)).toBe(other);
    expect(withoutAskingCampaign("list_offers", LIST, ASKING)).toBe(LIST);
  });
});

describe("readPersonThread", () => {
  const args = { orgId: REQ.orgId, userId: "u-1", runId: "run-1", brandId: REQ.brandId, lead: { email: " Jose@LegistAI.com ", leadId: "l" } };

  it("reads the merged timeline by email, keeps messages with text", async () => {
    const fetchImpl = vi.fn(async (_path: string) => new Response(JSON.stringify({ items: [
      { kind: "event", at: "2026-10-08T00:00:00Z", direction: null, channel: "web", text: null },
      { kind: "message", at: "2026-10-19T06:30:00Z", direction: "inbound", channel: "email", text: "Can you help us?" },
      { kind: "message", at: null, direction: "outbound", channel: "email", text: "  " },
    ] }), { status: 200 }));
    const out = await readPersonThread(args, fetchImpl);
    const path = fetchImpl.mock.calls[0][0];
    expect(path).toContain("/v1/orgs/people/timeline?");
    expect(new URLSearchParams(path.split("?")[1]).get("personKey")).toBe("email:jose@legistai.com");
    expect(out).toEqual([{ at: "2026-10-19T06:30:00Z", direction: "inbound", channel: "email", text: "Can you help us?" }]);
  });

  it("a person crm does not know yet is an empty thread; another error throws", async () => {
    expect(await readPersonThread(args, async () => new Response("{}", { status: 404 }))).toEqual([]);
    await expect(readPersonThread(args, async () => new Response("boom", { status: 500 }))).rejects.toThrow("people timeline 500");
  });
});

describe("isRetryableDelivery", () => {
  it("retries what can clear by waiting, never a permanent refusal", () => {
    expect(isRetryableDelivery(new WhatsappSendError(422, JSON.stringify({ type: "refused", code: "whatsapp_not_connected" })))).toBe(true);
    expect(isRetryableDelivery(new WhatsappSendError(503, "down"))).toBe(true);
    expect(isRetryableDelivery(new WhatsappSendError(429, "slow"))).toBe(true);
    expect(isRetryableDelivery(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableDelivery(new WhatsappSendError(422, JSON.stringify({ code: "not_linked" })))).toBe(false);
    expect(isRetryableDelivery(new WhatsappSendError(400, "bad"))).toBe(false);
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
    await processProactiveTurn({ db, fetchEmail: async () => null, isStaffEmail: () => false, readThread: async () => [], resolveAskingCampaign, runChat, sendWhatsapp }, "turn-1", whatsappRecipient, { "x-campaign-id": "c-1" });
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

  it("feeds the thread read and the asking campaign into the hidden trigger", async () => {
    const { db } = fakeDb([[{ ...ROW, payload: { ...REQ, inbound: undefined } }]]);
    const runChat = vi.fn(async () => ({ status: 200, body: sse({ type: "token", content: "ok" }) }));
    const readThread = vi.fn(async () => [{ at: null, direction: "inbound" as const, channel: "email", text: "Do you do LinkedIn?" }]);
    const resolve = vi.fn(resolveAskingCampaign);
    await processProactiveTurn({ db, fetchEmail: async () => null, isStaffEmail: () => false, runChat, sendWhatsapp: vi.fn(async () => {}), readThread, resolveAskingCampaign: resolve }, "turn-1", whatsappRecipient, { "x-campaign-id": "c-1" });
    expect(resolve).toHaveBeenCalledWith({ orgId: REQ.orgId, userId: "u-owner", runId: "run-1", campaignId: "c-1" });
    expect(readThread).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-owner", runId: "run-1", brandId: REQ.brandId }));
    const msg = (runChat.mock.calls[0] as unknown as [{ message: string }])[0].message;
    expect(msg).toContain('"Do you do LinkedIn?"');
    expect(msg).toContain('"Lead Proposal Deals"');
  });

  it("a 422 whatsapp_not_connected then success delivers once, same text and key, the turn ran once", async () => {
    const { db, updates } = fakeDb([[ROW]]);
    const runChat = vi.fn(async () => ({ status: 200, body: sse({ type: "token", content: "Hot lead. Go?" }) }));
    const refusal = new WhatsappSendError(422, JSON.stringify({ type: "refused", code: "whatsapp_not_connected" }));
    const sendWhatsapp = vi.fn().mockRejectedValueOnce(refusal).mockResolvedValueOnce(undefined);
    const sleep = vi.fn(async () => {});
    await processProactiveTurn({ db, fetchEmail: async () => null, isStaffEmail: () => false, readThread: async () => [], runChat, sendWhatsapp, sleep }, "turn-1", whatsappRecipient, {});
    expect(runChat).toHaveBeenCalledTimes(1);
    expect(sendWhatsapp).toHaveBeenCalledTimes(2);
    expect(sendWhatsapp.mock.calls[0][0]).toEqual(sendWhatsapp.mock.calls[1][0]);
    expect(sleep).toHaveBeenCalledWith(DELIVERY_RETRY_DELAYS_MS[0]);
    expect(updates.at(-1)).toMatchObject({ status: "delivered", error: null });
  });

  it("a refusal that never clears ends failed and legible, the message kept for the web thread", async () => {
    const { db, updates } = fakeDb([[ROW]]);
    const sendWhatsapp = vi.fn(async () => { throw new WhatsappSendError(422, JSON.stringify({ type: "refused", code: "whatsapp_not_connected" })); });
    await processProactiveTurn(
      { db, fetchEmail: async () => null, isStaffEmail: () => false, readThread: async () => [], sendWhatsapp, sleep: async () => {},
        runChat: async () => ({ status: 200, body: sse({ type: "token", content: "Hot lead. Go?" }) }) },
      "turn-1", whatsappRecipient, {},
    );
    expect(sendWhatsapp).toHaveBeenCalledTimes(DELIVERY_RETRY_DELAYS_MS.length + 1);
    const last = updates.at(-1)!;
    expect(last).toMatchObject({ status: "failed", replyText: "Hot lead. Go?" });
    expect(String(last.error)).toContain(`whatsapp delivery failed after ${DELIVERY_RETRY_DELAYS_MS.length + 1} attempt(s), the message waits in the web Copilot thread`);
    expect(String(last.error)).toContain("whatsapp_not_connected");
  });

  it("a permanent refusal is not retried", async () => {
    const { db, updates } = fakeDb([[ROW]]);
    const sendWhatsapp = vi.fn(async () => { throw new WhatsappSendError(400, "bad phone"); });
    const sleep = vi.fn(async () => {});
    await processProactiveTurn(
      { db, fetchEmail: async () => null, isStaffEmail: () => false, readThread: async () => [], sendWhatsapp, sleep,
        runChat: async () => ({ status: 200, body: sse({ type: "token", content: "Go?" }) }) },
      "turn-1", whatsappRecipient, {},
    );
    expect(sendWhatsapp).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
  });

  it("out of credits: stored in the thread, nothing sent to a phone", async () => {
    const { db, updates } = fakeDb([[ROW]]);
    const sendWhatsapp = vi.fn(async () => {});
    await processProactiveTurn(
      { db, fetchEmail: async () => null, isStaffEmail: () => false, readThread: async () => [], sendWhatsapp,
        runChat: async () => ({ status: 200, body: sse({ type: "token", content: "You're out of credits." }, { type: "credits_required", message: "You're out of credits.", label: "Add credits" }) }) },
      "turn-1", whatsappRecipient, {},
    );
    expect(sendWhatsapp).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ status: "out_of_credits" });
  });

  it("a row no longer processing runs nothing (never twice)", async () => {
    const { db } = fakeDb([[{ ...ROW, status: "delivered" }]]);
    const runChat = vi.fn();
    await processProactiveTurn({ db, fetchEmail: async () => null, isStaffEmail: () => false, readThread: async () => [], runChat, sendWhatsapp: vi.fn() }, "turn-1", whatsappRecipient, {});
    expect(runChat).not.toHaveBeenCalled();
  });

  it("a failed turn is recorded failed with its reason, nothing sent", async () => {
    const { db, updates } = fakeDb([[ROW]]);
    const sendWhatsapp = vi.fn();
    await processProactiveTurn({ db, fetchEmail: async () => null, isStaffEmail: () => false, readThread: async () => [], sendWhatsapp, runChat: async () => ({ status: 502, body: "boom" }) }, "turn-1", whatsappRecipient, {});
    expect(sendWhatsapp).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ status: "failed", error: "POST /chat 502: boom" });
  });
});
