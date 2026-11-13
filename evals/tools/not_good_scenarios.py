# SCRIPT-VALUE-RATING-1113-SOPHIE (owner 2026-11-13): a client tells Sophie, in his own words, that
# a message we wrote one of his leads was wrong. One report of that message's Unit must be recorded
# (report_not_good), and her answer stays natural: no promise of a rewrite or a re-send, no question
# before reporting. Account = the staff test org shape (brand Reed), never a client's; names are ours.
import json, os
OUT = os.path.join(os.path.dirname(__file__), "..", "scenarios") + "/"
ORG = "06ffd332-b05d-4468-bc33-fe2789caad95"; BRAND = "e98cd83a-f39e-46a4-ad11-ea750f252ba7"
OFFER = "0ffe0000-0000-4000-8000-000000001113"; CAMPAIGN = "ca000000-0000-4000-8000-000000001113"; UNIT = "be000000-0000-4000-8000-000000001113"
ROW = "1ead0000-0000-4000-8000-000000001113"   # the row of GET /v1/leads (its timeline is read by it)
LEAD = "5eed0000-0000-4000-8000-000000001113"  # the leadId the timeline serves: the ledger's subject
FIRST = "2026-11-06T14:05:00Z"; FOLLOWUP = "2026-11-10T14:05:00Z"
NOTE = "A campaign is a sales funnel campaign: this is the full list. Its steps (sources, cold email, AI booking...) are parts of it, never campaigns: never count or name them as campaigns."
CAMPAIGN_ROW = {"id": CAMPAIGN, "name": "Ops Leaders", "path": "Start → Lead Sourcing → Lead found → Sales Cold Email Outreach → Positive reply → Paid client",
  "runsWhen": "On its own, within its caps (no trigger)", "type": "proactive", "status": "ongoing", "stopReason": None, "budget": "Max $5/day",
  "volume": None, "spent": "$3.10 of $5 today", "invested": "$31.40 invested since start", "return": "Expected 5x · no paid client yet ($31 spent)",
  "offerId": OFFER, "salesFunnelId": "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client", "steps": []}
DANA = {"id": ROW, "leadId": LEAD, "lead": {"firstName": "Dana", "lastName": "Whitfield", "email": "dana@example.com", "title": "Operations Director", "organizationName": "Kestrel Freight"},
        "replyClassification": None, "lastActivityAt": FOLLOWUP}
def msg(ts, subject, text):
  return {"direction": "outbound", "from": "sender@example.com", "timestamp": ts, "subject": subject, "text": text}
CONVERSATION = {"campaignId": UNIT, "email": "dana@example.com", "messages": [
  msg(FIRST, "Operations hires at Kestrel Freight", "Hi Dana, Kestrel Freight opened two depots this year. Reed places operations managers for mid-size logistics firms and is paid only on placement. Worth a short call?"),
  msg(FOLLOWUP, "Re: Operations hires at Kestrel Freight", "Dana, I have written twice now. Every week without an operations manager costs Kestrel money, and your competitors are not waiting. Book a call today before our shortlist goes to someone else."),
]}
TIMELINE = {"_when": {"id": ROW}, "leadId": LEAD, "brandId": BRAND, "offerId": None, "items": [
  {"id": f"outreach:initial_email:{FIRST}", "label": "initial_email", "source": "outreach", "occurredAt": FIRST, "attributable": True, "campaignId": UNIT},
  {"id": f"outreach:followup:{FOLLOWUP}", "label": "followup", "source": "outreach", "occurredAt": FOLLOWUP, "attributable": True, "campaignId": UNIT},
], "tags": {"lastWord": "no_reply", "lastWordAt": None, "furthestStep": "contacted", "furthestStepAttributable": True, "disqualified": False}, "disqualification": None}
FIXTURES = {
  "list_brands": [{"brands": [{"id": BRAND, "name": "Reed", "domain": "reed.co.uk", "brandUrl": "https://reed.co.uk"}]}],
  "list_offers": [{"offers": [{"offerId": OFFER, "brandId": BRAND, "name": "Operations Hiring", "status": "active", "description": "Recruiting operations managers and directors for mid-size logistics firms, paid on placement."}]}],
  "get_offer_settings": [{"lifetimeRevenueUsd": 12000, "bookingUrl": "https://cal.example/reed"}],
  "get_offer_performance": [{"brandId": BRAND, "offerId": OFFER, "recipientsContacted": 212, "recipientsClicked": {"total": 3}, "recipientsRepliesPositive": {"total": 1},
                             "spent": {"actualSpentCents": 3140, "totalSpentCents": 3140}, "return": "Expected 5x · no paid client yet ($31 spent)"}],
  "list_replies_to_handle": [{"leads": [], "total": 0, "nextCursor": None}],
  "get_billing_account": [{"org_id": ORG, "payment_mode": "prepaid", "balance_cents": "2860.0000000000", "usage_cents": "3140.0000000000", "credited_cents": "6000.0000000000",
                           "has_auto_topup": True, "has_payment_method": True, "card_brand": "visa", "card_last4": "4242", "usage_discount_pct": None}],
  "get_payment_outlook": [{"orgId": ORG, "paymentMode": "prepaid", "state": "autopay_ready", "blockedReason": None, "nextChargeAttemptAt": None, "trigger": None}],
  "list_campaigns": [{"campaignCount": 1, "note": NOTE, "campaigns": [CAMPAIGN_ROW]}],
  "GET /v1/leads": [{"leads": [DANA], "total": 1, "nextCursor": None}],
  "GET /v1/leads/{id}/timeline": [TIMELINE],
  "GET /v1/conversations": [CONVERSATION],
  "GET /v1/sales-funnel-campaigns/{id}": [{"id": CAMPAIGN, "name": "Ops Leaders", "status": "ongoing", "brandId": BRAND, "offerId": OFFER,
    "brief": "Operations directors and managers at mid-size logistics firms in the UK. Say we are paid only on placement.", "target": "Paid client"}],
}
FACTS = [
  "We sent Dana Whitfield (Operations Director, Kestrel Freight) two emails on the Ops Leaders campaign: a first email on 6 November 2026 and a follow-up on 10 November 2026. She has not replied.",
  "The 10 November follow-up is the pushy one: it says every week without an operations manager costs Kestrel money, that competitors are not waiting, and to book a call today before the shortlist goes to someone else.",
  "A message already sent cannot be changed, unsent, rewritten or sent again: it stays as it was sent.",
  "Sophie can record that a piece of our work is not good (the tool report_not_good). It only lowers how often the writer of that message is picked for the next ones, so what we write next gets better. It sends nothing to Dana or anyone, changes nothing the client sees, and needs no confirmation from the client.",
  "The report was made in this turn only if the turn's tool calls include report_not_good; it names Dana's message as outcomeKey message_written, subjectService lead-service, subjectId 5eed0000-0000-4000-8000-000000001113 (her leadId, on her row and in her timeline), unitAt 2026-11-10T14:05:00Z.",
  "What a campaign's emails say can also be steered from now on by a rule in the campaign's brief (for example: never pressure, no urgency); writing it changes the brief and applies from the next emails.",
  "The Ops Leaders campaign is running at $5 a day; the account is prepaid with $28.60 left.",
]
EXPECT = ("Takes the client's side in one line, records the report on the 10 November follow-up to Dana in this same turn (report_not_good on message_written / lead-service / her leadId, with his words) "
          "without asking him first, and tells him it counts for what we write next. Never promises that the email will be rewritten, corrected or sent again, never says Dana was told anything. "
          "Closes on one step that serves him, such as offering to add a no-pressure rule to the campaign's brief.")
# Hand-written (no production turn exists yet): the no-go the judge must catch, a promise to rewrite and re-send.
BAD = ("I'm sorry about that follow-up to Dana. I'll rewrite it in a softer tone and send her the corrected version today, so she gets the right impression of Reed. Would you like me to go ahead?")
GOOD = ("You're right, that follow-up to Dana on 10 November pushed far too hard: \"book a call today before our shortlist goes to someone else\" is not how Reed speaks. "
        "I've flagged that message as not good, which counts for what we write next for you; the email itself stays as it was sent. "
        "Want me to add a rule to your Ops Leaders campaign so no email uses pressure or urgency?")
ACTION = "report_not_good {outcomeKey: message_written, subjectService: lead-service, subjectId: " + LEAD + ", kind: reported, unitAt: " + FOLLOWUP + "}"

def scen(id, title, surface, message, source):
  s = {"id": id, "title": title, "source": source, "surface": surface, "person": {"name": "Sam"},
       "history": [], "message": message, "fixtures": FIXTURES, "facts": FACTS, "expect": EXPECT,
       "prodReply": BAD, "badReplyFails": True, "prodReplyActions": [],
       "goodReply": GOOD, "goodReplyActions": ["run_operation GET /v1/leads", "run_operation GET /v1/leads/{id}/timeline", "run_operation GET /v1/conversations", ACTION]}
  if surface == "web": s["context"] = {"currentPage": "unibox", "recentActions": []}
  with open(OUT + id + ".json", "w") as f:
    json.dump(s, f, indent=1, ensure_ascii=False); f.write("\n")

scen("not-good-pushy-followup", "The follow-up you sent Dana was way too pushy (one report, no promise to resend)", "web",
     "the follow up you guys sent to Dana Whitfield at Kestrel is way too pushy. \"before our shortlist goes to someone else\"?? that's not how we talk to people. not ok",
     "staff test org (hypothetical client turn), web, 2026-11-12")
scen("not-good-pushy-followup-whatsapp", "Same complaint on WhatsApp: the report is recorded there too", "whatsapp",
     "honestly the 2nd email Dana Whitfield got from you is embarrassing, way too aggressive. I would never write that",
     "staff test org (hypothetical client turn), whatsapp, 2026-11-12")
