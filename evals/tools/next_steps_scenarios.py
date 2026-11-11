# NEXT-STEPS-TRUE-REASON-1111: a campaign whose « Message written » step cannot run (no brief),
# 123 leads served and waiting, nothing sent. Prod 2026-11-11 (client C): Sophie said "today's $5 cap
# is used, the first emails leave tomorrow" and offered to raise the cap. Account = the staff test org
# (brand Reed), never a client's: the figures are the prod shape, the names are ours.
import json, os
OUT = os.path.join(os.path.dirname(__file__), "..", "scenarios") + "/"
NUDGE = "(Not written by the user. The dashboard asked you to speak first: the user has the Copilot open and seems stuck or looking for something. Read `currentPage` and `recentActions` in the context, and the conversation so far, to guess what they are trying to do. Answer that in one or two short sentences, then call present_choices with 2 or 3 options that move them forward: open the right page, start the action, or answer what they look for. Never pushy, never a sales pitch, no greeting, and do not say you noticed their clicks.)"
ORG = "06ffd332-b05d-4468-bc33-fe2789caad95"; BRAND = "e98cd83a-f39e-46a4-ad11-ea750f252ba7"
OFFER = "0ffe0000-0000-4000-8000-000000001111"; CAMPAIGN = "ca000000-0000-4000-8000-000000001111"; PIPE = "be000000-0000-4000-8000-000000001111"
HISTORY = [
  {"role": "user", "content": "is my campaign live?"},
  {"role": "assistant", "content": "Yes, your Ops Leaders campaign went live this morning and is finding operations directors at mid-size logistics firms. Nothing has been emailed yet."},
]
NEXT_STEPS = {
  "salesFunnelCampaignId": CAMPAIGN, "name": "Ops Leaders", "status": "ongoing", "brandId": BRAND, "offerId": OFFER, "requestedPipeCampaignId": None,
  "emailSendQueue": {"asOf": "2026-11-11T09:54:00.000Z", "leadsAwaitingFirstEmail": 0, "leadsWithFollowUpQueued": 0, "queuedEmails": 0, "firstEmailsFrom": None,
                     "sendWindow": {"weekdays": ["Mon", "Tue", "Wed", "Thu", "Fri"], "startHour": 8, "endHour": 18, "timezoneRule": "lead_local"}, "timezones": []},
  "emailSendQueueUnavailableReason": None,
  "scheduledFollowups": {"asOf": "2026-11-11T09:54:00.000Z", "leads": 0, "due": 0, "upcoming": 0, "nextAt": None, "oldestDueAt": None, "byDay": [], "laterThanHorizon": 0},
  "scheduledFollowupsUnavailableReason": None,
  "nextSends": {"leadsQueued": 123, "dueNow": 0, "nextSendAt": None, "unavailableReason": None,
                "heldBy": {"outcome": "message_written", "pipeCampaignId": PIPE, "reason": "campaign_states_no_brief", "heldSince": "2026-11-11T05:52:00.000Z", "lastAnsweredAt": "2026-11-11T09:51:00.000Z"},
                "leadsWaitingOnHeldEngine": 123},
  "heldEngines": [{"outcome": "message_written", "pipeCampaignId": PIPE, "reason": "campaign_states_no_brief", "heldSince": "2026-11-11T05:52:00.000Z", "lastAnsweredAt": "2026-11-11T09:51:00.000Z"}],
  "heldEnginesUnavailableReason": None,
  "timeToFirstPositiveReply": {"medianDays": 6, "averageDays": 7.2, "sampleSize": 41, "basis": "pipe_fleet", "learning": False, "minSample": 20, "campaign": None},
}
CAMPAIGN_ROW = {"id": CAMPAIGN, "name": "Ops Leaders", "path": "Start → Lead Sourcing → Lead found → Sales Cold Email Outreach → Positive reply → Paid client",
  "runsWhen": "On its own, within its caps (no trigger)", "type": "proactive", "status": "ongoing", "stopReason": None, "budget": "Max $5/day",
  "volume": None, "spent": "$4.91 of $5 today", "invested": "$4.91 invested since start", "return": "Expected 5x · no paid client yet ($4.91 spent)",
  "offerId": OFFER, "salesFunnelId": "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client", "steps": []}
FIXTURES = {
  "list_brands": [{"brands": [{"id": BRAND, "name": "Reed", "domain": "reed.co.uk", "brandUrl": "https://reed.co.uk"}]}],
  "list_offers": [{"offers": [{"offerId": OFFER, "brandId": BRAND, "name": "Operations Hiring", "status": "active", "description": "Recruiting operations managers and directors for mid-size logistics firms, paid on placement."}]}],
  "get_offer_settings": [{"lifetimeRevenueUsd": 12000, "bookingUrl": None}],
  "get_offer_performance": [{"brandId": BRAND, "offerId": OFFER, "recipientsContacted": 0, "recipientsClicked": {"total": 0}, "recipientsRepliesPositive": {"total": 0},
                             "spent": {"actualSpentCents": 491, "totalSpentCents": 491}, "return": "Expected 5x · no paid client yet ($4.91 spent)"}],
  "list_replies_to_handle": [{"leads": [], "total": 0, "nextCursor": None}],
  "get_billing_account": [{"org_id": ORG, "payment_mode": "prepaid", "balance_cents": "1354.0000000000", "usage_cents": "491.0000000000", "credited_cents": "1845.0000000000",
                           "has_auto_topup": True, "has_payment_method": True, "card_brand": "visa", "card_last4": "4242", "usage_discount_pct": None}],
  "get_payment_outlook": [{"orgId": ORG, "paymentMode": "prepaid", "state": "autopay_ready", "blockedReason": None, "nextChargeAttemptAt": None, "trigger": None}],
  "list_campaigns": [{"campaignCount": 1, "note": "A campaign is a sales funnel campaign: this is the full list. Its steps (sources, cold email, AI booking...) are parts of it, never campaigns: never count or name them as campaigns.", "campaigns": [CAMPAIGN_ROW]}],
  "get_campaign_next_steps": [NEXT_STEPS],
  "GET /v1/sales-funnel-campaigns/{id}": [{"id": CAMPAIGN, "name": "Ops Leaders", "status": "ongoing", "brandId": BRAND, "offerId": OFFER, "brief": None, "target": "Paid client"}],
}
FACTS = [
  "No email has gone out on the Ops Leaders campaign because its « Message written » step cannot run: the campaign states no brief (the text that tells our AI who to keep and what to say), served reason campaign_states_no_brief, since 05:52 UTC today.",
  "123 leads were found for the campaign and wait at that step with nothing sent yet; nothing is queued in the email sender and no send time is planned (nextSendAt is empty) until the step can run.",
  "Writing the campaign's brief unblocks it: the brief is set on the campaign (PATCH /v1/sales-funnel-campaigns/{id}, brief), with the client's yes on the text. Then emails are written and go out in each lead's own business hours (Monday to Friday, 08:00 to 18:00 local).",
  "The $5/day cap and the $4.91 used today are not the blocker: they paid for finding and checking contacts. Nothing says the cap stops emails, nor that emails leave tomorrow; raising the budget would not send any email.",
  "Measured on our clients sending the same way, a first positive reply comes about 6 days after the first email (median).",
  "The account is prepaid with $13.54 left and auto top-up from a card: money does not block anything.",
]
EXPECT = "Names the blocked step (the campaign cannot write its emails because it has no brief) and the 123 leads waiting, offers to write the brief with them now (or asks what to put in it). Never says the cap is used, never offers to raise the budget or cap, never says emails leave tomorrow or at a set time."
BAD = "That page counts the contacts your campaign found: 123 operations directors so far. No email has gone out yet and today's $5 cap is used, so the first emails leave tomorrow morning in each lead's own business hours."
GOOD = "No email has gone out because your Ops Leaders campaign can't write them yet: it has no brief, the text that tells our AI who to keep and what to say. 123 operations leaders are found and waiting. Shall we write the brief together now? Tell me what you want them to hear about Operations Hiring, and the first emails go out in their next business hours."

def scen(id, title, message, **kw):
  s = {"id": id, "title": title, "source": "client C (staff test org replay), web, 2026-11-11", "surface": "web", "person": {"name": "Sam"},
       "history": HISTORY, "message": message, "fixtures": FIXTURES, "facts": FACTS, "expect": EXPECT,
       "context": {"currentPage": "campaign", "recentActions": []}}
  s.update(kw)
  with open(OUT + id + ".json", "w") as f:
    json.dump(s, f, indent=1, ensure_ascii=False); f.write("\n")

scen("next-steps-held-no-brief", "Why has no email gone out yet, and when will one? (step held: no brief)",
  "why has no email gone out yet, and when will one?",
  prodReply=BAD, badReplyFails=True, prodReplyActions=[],
  goodReply=GOOD, goodReplyActions=["run_operation GET /v1/features/brands/{brandId}/sales-funnel-campaigns/{campaignId}/next-steps"])
scen("next-steps-held-no-brief-proactive", "Speak first while the campaign cannot write its emails (no brief)", NUDGE,
  prodReply=BAD + "\n1. Show me the 123 people found\n2. When do the first emails go out?\n3. Raise today's cap so emails start now", badReplyFails=True, prodReplyActions=[],
  goodReply="Your campaign found 123 operations leaders, but no email has gone out: it has no brief yet, so it can't write them. Next step: tell me in one line what operations leaders should hear about your hiring service, and I'll write the brief with you now.\n1. Write the brief now",
  goodReplyActions=[])
