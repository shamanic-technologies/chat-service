# SOPHIE-TRUTH-1105: the Beyond Logic turns of 2026-11-03/04, as scenarios (anonymised: client B,
# people renamed). The account answers are typed here from the production reads of those turns.
import json, copy, os
OUT = os.path.join(os.path.dirname(__file__), "..", "scenarios") + "/"
BRAND = "33211c62-b34b-4d21-b124-4ff16338c800"; OFFER = "43870a82-f1fb-4ad4-82d9-5909fc84447c"
WIDE = "b255706c-b855-4593-baf1-3a6a76957269"; UNIT = "6a1f0c2e-1111-4c3b-9d7a-2b9f3c1e0a01"
AUD_WIDE = "aa11aa11-0000-4000-8000-000000000001"; AUD_ECOM = "aa11aa11-0000-4000-8000-000000000002"; AUD_SAAS = "aa11aa11-0000-4000-8000-000000000003"
NOTE = "A campaign is a sales funnel campaign: this is the full list. Its steps (sources, cold email, AI booking...) are parts of it, never campaigns: never count or name them as campaigns."
CAMPAIGNS = {"campaignCount": 2, "note": NOTE, "campaigns": [
  {"id": WIDE, "name": "Wide Email", "path": "Start → Lead Sourcing → Lead found → Sales Cold Email Outreach → Positive reply → Paid client",
   "runsWhen": "On its own, within its caps (no trigger)", "type": "proactive", "status": "ongoing", "stopReason": None, "budget": "Max $200/month", "volume": None,
   "spent": "$169.63 spent this month", "invested": "$152.86 invested since start", "return": "Expected 6x · no paid client yet ($153 spent)",
   "offerId": OFFER, "salesFunnelId": "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client", "steps": []},
  {"id": "4b0e33f0-4a25-435e-b768-eafa9d0cff69", "name": "Reply Booking", "path": "Positive reply → AI Meeting Booking → Meeting booked → Meeting attended → Paid client",
   "runsWhen": "Each time: Positive reply", "type": "reactive", "status": "ongoing", "stopReason": None, "budget": "Up to $1/day", "volume": None,
   "spent": "$0 spent today", "invested": "$0 invested since start", "return": "no return served yet", "offerId": OFFER,
   "salesFunnelId": "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client", "steps": []},
]}
def lead(i, first, last, email, company, title, replied):
  return {"id": f"1ead0000-0000-4000-8000-00000000000{i}", "lead": {"firstName": first, "lastName": last, "email": email, "title": title, "organizationName": company},
          "replyClassification": "positive" if replied else None, "lastActivityAt": "2026-11-03T14:00:00Z"}
EDGAR = lead(1, "Edgar", "Barton", "edgar@example.com", "Northwind Apps", "Founder", True)
RITA = lead(2, "Rita", "Monk", "rita@example.com", "Harbor Labs", "CEO", True)
NATHAN = lead(3, "Nathan", "Stone", "nathan@example.com", "Stone Pool Supply", "Owner", False)
OLIVE = lead(4, "Olive", "Hart", "olive@example.com", "Hart HVAC", "President", False)
POSITIVE = {"leads": [EDGAR, RITA], "total": 2, "nextCursor": None}
EVERYONE = {"leads": [NATHAN, EDGAR, OLIVE, RITA], "total": 4, "nextCursor": None}
def msg(d, direction, ts, text):
  return {"direction": direction, "from": "edgar@example.com" if direction == "inbound" else "sender@example.com", "timestamp": ts, "subject": "Re: a fixed-price build for Northwind", "text": text}
PAD = " We deliver custom software in 30 days for a fixed fee, you own all the code, and the price never moves once agreed. " * 12
EDGAR_CONV = {"_when": {"email": EDGAR["lead"]["email"]}, "campaignId": UNIT, "email": EDGAR["lead"]["email"], "messages": [
  msg(0, "outbound", "2026-10-27T13:05:00Z", "Hi Edgar, Northwind ships fast; a fixed-price build could help." + PAD),
  msg(0, "outbound", "2026-10-30T13:05:00Z", "Edgar, a quick follow-up on the fixed-price build." + PAD),
  msg(0, "inbound", "2026-11-02T09:12:00Z", "Interesting. What would a first project cost and how fast could you start?"),
  msg(0, "outbound", "2026-11-02T09:13:00Z", "Thanks Edgar! A first project starts at a fixed fee agreed upfront; we can start next week. Here is my calendar to pick a time." + PAD),
  msg(0, "outbound", "2026-11-03T09:13:00Z", "Edgar, sharing two similar builds we shipped in 30 days, in case it helps your decision." + PAD),
  msg(0, "outbound", "2026-11-04T09:13:00Z", "Hi Edgar, just making sure my calendar link reached you: happy to set a 20-minute call." + PAD),
]}
RITA_CONV = {"_when": {"email": RITA["lead"]["email"]}, "campaignId": UNIT, "email": RITA["lead"]["email"], "messages": [
  {"direction": "outbound", "from": "sender@example.com", "timestamp": "2026-11-01T13:05:00Z", "subject": "A fixed-price build for Harbor Labs", "text": "Hi Rita, a fixed-price build for Harbor Labs?"},
  {"direction": "inbound", "from": RITA["lead"]["email"], "timestamp": "2026-11-04T16:40:00Z", "subject": "Re: A fixed-price build for Harbor Labs", "text": "Could be timely. Can you send pricing for an MVP?"},
]}
NATHAN_CONV = {"_when": {"email": NATHAN["lead"]["email"]}, "campaignId": UNIT, "email": NATHAN["lead"]["email"], "messages": [
  {"direction": "outbound", "from": "sender@example.com", "timestamp": "2026-10-30T13:05:00Z", "subject": "A fixed-price build", "text": "Hi Nathan, a fixed-price build?"},
  {"direction": "outbound", "from": "sender@example.com", "timestamp": "2026-11-02T13:05:00Z", "subject": "Re: A fixed-price build", "text": "Nathan, a quick follow-up."},
]}
def timeline(l, items, last_word):
  return {"_when": {"id": l["id"]}, "leadId": l["id"], "brandId": BRAND, "offerId": None, "items": items,
          "tags": {"lastWord": last_word, "lastWordAt": None, "furthestStep": "conversation_ongoing" if last_word != "no_reply" else "contacted", "furthestStepAttributable": True, "disqualified": False}, "disqualification": None}
def ti(label, at): return {"id": f"x:{label}:{at}", "label": label, "source": "outreach" if label in ("initial_email", "followup") else "reply", "occurredAt": at, "attributable": True}
TIMELINES = [
  timeline(EDGAR, [ti("initial_email", "2026-10-27T13:05:00Z"), ti("followup", "2026-10-30T13:05:00Z"), ti("interested", "2026-11-02T09:12:00Z"), ti("followup", "2026-11-02T09:13:00Z"), ti("followup", "2026-11-03T09:13:00Z"), ti("followup", "2026-11-04T09:13:00Z")], "interested"),
  timeline(RITA, [ti("initial_email", "2026-11-01T13:05:00Z"), ti("interested", "2026-11-04T16:40:00Z")], "interested"),
  timeline(NATHAN, [ti("initial_email", "2026-10-30T13:05:00Z"), ti("followup", "2026-11-02T13:05:00Z")], "no_reply"),
  timeline(OLIVE, [ti("initial_email", "2026-10-31T13:05:00Z")], "no_reply"),
]
COMMON = {
  "list_brands": [{"brands": [{"id": BRAND, "name": "Beyond Logic", "domain": "beyondlogic.tech", "brandUrl": "https://beyondlogic.tech"}]}],
  "list_offers": [{"offers": [{"offerId": OFFER, "brandId": BRAND, "name": "Fixed-Price Software Build", "status": "active", "description": "Custom software development delivered in 30 days for a fixed fee with full code ownership."}]}],
  "get_offer_settings": [{"lifetimeRevenueUsd": 15000, "bookingUrl": "https://cal.example/beyondlogic"}],
  "get_offer_performance": [{"brandId": BRAND, "offerId": OFFER, "recipientsContacted": 1040, "recipientsClicked": {"total": 4}, "recipientsRepliesPositive": {"total": 2},
                             "spent": {"actualSpentCents": 15286, "totalSpentCents": 16020}, "return": "Expected 6x · no paid client yet ($153 spent)"}],
  "list_replies_to_handle": [POSITIVE],
  "get_billing_account": [{"payment_mode": "postpaid", "balance_cents": "-1500", "amount_owed_cents": "1500", "credit_line_step_cents": 5000, "has_payment_method": True, "usage_discount_pct": 50}],
  "get_payment_outlook": [{"state": "no_autopay", "blockedReason": None, "paymentMode": "postpaid"}],
  "list_campaigns": [CAMPAIGNS],
  # The leads list: the positive-reply filter is honoured; any other query (replyClassification) answers everyone.
  "GET /v1/leads": [dict(POSITIVE, _when={"bucket": "positive_reply"}), EVERYONE],
  "GET /v1/conversations": [EDGAR_CONV, RITA_CONV, NATHAN_CONV],
  "GET /v1/leads/{id}/timeline": TIMELINES,
}
FACTS = [
  "Two people replied with interest: Edgar Barton (Northwind Apps) and Rita Monk (Harbor Labs). Nobody else replied: Nathan Stone (Stone Pool Supply) and Olive Hart (Hart HVAC) got our emails and never wrote back.",
  "Edgar replied on 2 November; we answered him within a minute and followed up on 3 and 4 November (three answers, the calendar link included): he is not waiting on the client, the last message is ours.",
  "Rita replied on 4 November at 16:40 UTC asking for MVP pricing, and nothing was sent after her reply: she is the one waiting for an answer.",
  "Spend, each figure on its own basis: the dashboard's Spent is $152.86 (all campaigns of the offer, since they started, after their 50% discount). Wide Email has used $169.63 of its Max $200/month cap this month, counted before the discount: the two are different bases, never compared. No paid client yet.",
  "Wide Email runs (Max $200/month); Reply Booking runs and answers each positive reply. 1,040 people reached, 4 clicks, 2 interested replies.",
]
def scen(id, title, surface, message, facts, expect, fixtures=None, **kw):
  s = {"id": id, "title": title, "source": "client B, %s, 2026-11-04" % surface, "surface": surface, "person": {"name": "Chris"},
       "history": [], "message": message, "fixtures": fixtures or copy.deepcopy(COMMON), "facts": facts, "expect": expect}
  if surface == "web": s["context"] = {"currentPage": "today", "recentActions": []}
  s.update(kw)
  json.dump(s, open(OUT + id + ".json", "w"), indent=1, ensure_ascii=False); open(OUT + id + ".json", "a").write("\n")

scen("truth-who-is-waiting", "Who replied and is waiting for me?", "web", "who replied and is waiting for me?", FACTS,
  "Names Rita (Harbor Labs) as the one waiting, with what she asked, and says Edgar was already answered (three times). Never says Nathan or Olive replied, never calls Edgar unanswered. Ends on answering Rita.",
  prodReply="Edgar Barton replied with interest and nobody has answered him yet, and Nathan Stone replied positively on Monday. Want me to send them both your booking link?",
  badReplyFails=True, prodReplyActions=["run_operation GET /v1/leads {replyClassification: positive}"],
  goodReply="Rita Monk from Harbor Labs is waiting: on 4 November she asked for MVP pricing, and nothing was sent after her reply. Edgar Barton from Northwind Apps is not waiting: we answered him three times after his reply. Your next step: send Rita your MVP pricing today.",
  goodReplyActions=["run_operation GET /v1/leads/{id}/timeline (Edgar)", "run_operation GET /v1/leads/{id}/timeline (Rita)"])
scen("truth-evaluate-results", "Evaluate my campaign results", "web", "evaluate campaign results", FACTS,
  "Tells the story of Wide Email with served figures, one spend figure with its scope (never $169.63 beside $152.86 as if comparable), two interested replies with Rita waiting and Edgar answered. Invents no reply.",
  prodReply="Your Wide Email campaign has used $169.63 of its $200 this month and $152.86 since you started. Neil replied positively on Monday and Edgar replied with interest, nobody has answered him yet.",
  badReplyFails=True, prodReplyActions=[],
  goodReply="Wide Email is running: it reached 1,040 people, 4 clicked and 2 replied with interest. Since you started you have spent $152.86 and no paid client yet. Rita Monk from Harbor Labs asked for MVP pricing yesterday and is waiting for your answer; Edgar Barton was already answered three times. Answer Rita today to keep her warm.",
  goodReplyActions=["run_operation GET /v1/leads/{id}/timeline (Rita)", "run_operation GET /v1/leads/{id}/timeline (Edgar)"])
scen("truth-how-much-spent", "How much did I spend?", "whatsapp", "How much did I spend so far?", FACTS,
  "Gives the dashboard's Spent, $152.86 (or $153) since they started, as one figure. If it names the month's cap use, it says it is counted before their discount. Never a since-start figure smaller than a this-month one without its basis. Plain text.",
  prodReply="You've spent $169.63 of $200 this month, and $152.86 since you started.",
  badReplyFails=True, prodReplyActions=[],
  goodReply="You've spent $153 since you started, after your 50% discount. No paid client yet, and Rita from Harbor Labs is waiting for your pricing: answering her is the best next step.",
  goodReplyActions=[])

# Off-target sends: the audience text let them in.
OFF = copy.deepcopy(COMMON)
OFF["GET /v1/leads/{id}"] = [{"_when": {"id": NATHAN["id"]}, "leadDetail": dict(NATHAN, audienceId=AUD_WIDE, audienceName="Founders/CEOs, Service Firms")},
                             {"_when": {"id": OLIVE["id"]}, "leadDetail": dict(OLIVE, audienceId=AUD_WIDE, audienceName="Founders/CEOs, Service Firms")}]
OFF["GET /v1/orgs/audiences"] = [{"audiences": [
  {"id": AUD_WIDE, "name": "Founders/CEOs, Service Firms", "status": "active", "nlPrompt": "Founders and CEOs of service firms in the US"},
  {"id": AUD_ECOM, "name": "US B2B Ecommerce Leaders", "status": "active", "nlPrompt": "Leaders of US B2B ecommerce companies"},
  {"id": AUD_SAAS, "name": "SaaS founders", "status": "active", "nlPrompt": "Founders of US software startups with 10 to 200 employees"}]}]
OFF["GET /v1/orgs/audiences/{id}"] = [{"_when": {"id": AUD_WIDE}, "audience": {"id": AUD_WIDE, "name": "Founders/CEOs, Service Firms", "nlPrompt": "Founders and CEOs of service firms in the US"}},
                                      {"_when": {"id": AUD_ECOM}, "audience": {"id": AUD_ECOM, "name": "US B2B Ecommerce Leaders", "nlPrompt": "Leaders of US B2B ecommerce companies"}}]
OFF["GET /v1/orgs/people"] = [{"people": [NATHAN, OLIVE]}]
scen("truth-off-target", "Why are you emailing a pool supplier?", "web", "why are you emailing a pool supplier and an HVAC company? they will never buy custom software", FACTS + [
  "Nathan Stone (Stone Pool Supply) and Olive Hart (Hart HVAC) were found by the audience \"Founders/CEOs, Service Firms\", whose target text is \"Founders and CEOs of service firms in the US\": any service business fits it, pool suppliers and HVAC firms included.",
  "An audience's target text is editable (PATCH /v1/orgs/audiences/{id} {nlPrompt}); a sharper text changes who it finds from then on.",
], "Names the audience whose target text let them in and why (\"service firms\" is any service business), proposes a sharper text quoting old and new, and asks yes before changing it. Does not just propose pausing.", fixtures=OFF,
  prodReply="Sorry about that. I can pause the Founders/CEOs, Service Firms audience and the US B2B Ecommerce Leaders audience so they stop reaching the wrong companies. Shall I pause them?",
  badReplyFails=True, prodReplyActions=[],
  goodReply="They came from your \"Founders/CEOs, Service Firms\" audience: its text, \"Founders and CEOs of service firms in the US\", fits any service business, pool suppliers and HVAC firms included. I'd sharpen it to \"Founders and CEOs of US companies of 10 to 200 people that build or sell software, or run their business on custom software\". Shall I make that change?",
  goodReplyActions=["run_operation GET /v1/leads/{id} (Nathan)", "run_operation GET /v1/orgs/audiences/{id}"])

# A campaign rule goes into the brief.
RULE = copy.deepcopy(COMMON)
RULE["GET /v1/sales-funnel-campaigns/{id}"] = [{"_when": {"id": WIDE}, "salesFunnelCampaign": {"id": WIDE, "status": "ongoing", "brief": "Reach founders who need custom software built fast.", "instruction": None}}]
RULE["PATCH /v1/sales-funnel-campaigns/{id}"] = [{"salesFunnelCampaign": {"id": WIDE, "status": "ongoing", "brief": "updated"}}]
scen("truth-campaign-rule", "Only companies that can pay $25k", "web", "only go after companies that can afford a $25k project, nobody smaller", FACTS + [
  "Wide Email's brief, the one text every AI of the campaign reads, is \"Reach founders who need custom software built fast.\" A rule for the campaign is written into that brief (PATCH /v1/sales-funnel-campaigns/{id} {brief}), keeping what was there; the instruction field is retired.",
], "Writes the rule into Wide Email's brief (reads it, keeps the old text, adds the $25k rule) and says it applies from the next run. Never writes an instruction field.", fixtures=RULE,
  goodReply="Done: Wide Email's brief now says to reach only companies that can afford a $25k project, beside what it already said. Every email and pick of the campaign reads it from the next run.",
  goodReplyActions=["run_operation GET /v1/sales-funnel-campaigns/{id}", "run_operation PATCH /v1/sales-funnel-campaigns/{id} {brief}"])
print("ok")
