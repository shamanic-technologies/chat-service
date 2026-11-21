# HUMAN-BRIEF-1121 (owner 2026-11-21: « c'est Sophie qui choisit un brief court concis, clair », « On ne devrait
# pas lancer de campaign sans brief »): a client asks for a new campaign in their own words; the create carries a
# brief Sophie wrote from them, one or two plain sentences, shown to the client before the start. Staff test org
# (06ffd332-...), invented brand: no client account is read.
import json, copy, os
OUT = os.path.join(os.path.dirname(__file__), "..", "scenarios") + "/"
ORG = "06ffd332-b05d-4468-bc33-fe2789caad95"
BRAND = "b71e0000-0000-4000-8000-00000000f001"; OFFER = "0ffe0000-0000-4000-8000-00000000f002"
AUD = "aa22aa22-0000-4000-8000-00000000f003"; NEW = "ca220000-0000-4000-8000-00000000f004"
FUNNEL = "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking"
OFFER_ROW = {"offerId": OFFER, "brandId": BRAND, "name": "Investor Conversations", "status": "active",
             "description": "Relationships with equity investors (seed and Series A funds, angels) in Europe for Fernwood, an AI bookkeeping startup."}
COMMON = {
  "list_brands": [{"brands": [{"id": BRAND, "name": "Fernwood", "domain": "fernwood.example", "brandUrl": "https://fernwood.example"}]}],
  "list_offers": [{"offers": [OFFER_ROW]}],
  "get_offer_settings": [{"lifetimeRevenueUsd": None, "bookingUrl": "https://cal.example/fernwood"}],
  "get_offer_performance": [{"brandId": BRAND, "offerId": OFFER, "recipientsContacted": 0, "recipientsClicked": {"total": 0},
                             "recipientsRepliesPositive": {"total": 0}, "spent": {"actualSpentCents": 0, "totalSpentCents": 0}, "return": "no return served yet"}],
  "list_replies_to_handle": [{"leads": [], "total": 0, "nextCursor": None}],
  "get_billing_account": [{"org_id": ORG, "payment_mode": "prepaid", "balance_cents": "5000.0000000000", "usage_cents": "0", "credited_cents": "5000.0000000000",
                           "has_auto_topup": True, "has_payment_method": True, "card_brand": "visa", "card_last4": "4242", "usage_discount_pct": None}],
  "get_payment_outlook": [{"orgId": ORG, "paymentMode": "prepaid", "state": "autopay_ready", "blockedReason": None, "nextChargeAttemptAt": None, "trigger": None}],
  "list_campaigns": [{"campaignCount": 0, "note": "A campaign is a sales funnel campaign: this is the full list.", "campaigns": []},
                     {"_after": "POST /v1/sales-funnel-campaigns", "campaignCount": 1, "note": "A campaign is a sales funnel campaign: this is the full list.", "campaigns": [
                       {"id": NEW, "name": "Investor Conversations", "path": "Start → Lead Sourcing → Lead found → Sales Cold Email Outreach → Positive reply → AI Meeting Booking → Meeting booked",
                        "runsWhen": "On its own, within its caps (no trigger)", "type": "proactive", "status": "stopped", "stopReason": None, "budget": "Max $20/day",
                        "volume": None, "spent": "$0 spent today", "invested": "$0 invested since start", "return": "no return served yet", "offerId": OFFER, "salesFunnelId": FUNNEL, "steps": []}]}],
  "GET /v1/brands/{id}/offers": [{"offers": [OFFER_ROW]}],
  "GET /v1/orgs/audiences": [{"audiences": [{"id": AUD, "name": "European seed and Series A investors", "status": "active",
                                             "nlPrompt": "Partners and principals at seed and Series A venture funds in Europe, and active angel investors in European software"}]}],
  "GET /v1/offers/{offerId}/sales-funnels": [{"rows": [{"id": FUNNEL, "name": "Cold email to meetings", "type": "proactive", "mixed": False, "runnable": True,
                                                         "line": "Lead Sourcing → Sales Cold Email Outreach → AI Meeting Booking",
                                                         "path": "Start → Lead found → Positive reply → Meeting booked"}], "setAside": []}],
  "POST /v1/sales-funnel-campaigns": [{"created": True, "started": False, "salesFunnelCampaign": {"id": NEW, "brandId": BRAND, "offerId": OFFER, "salesFunnelId": FUNNEL, "status": "stopped"}}],
  "PUT /v1/brands/{brandId}/offers/{offerId}/sales-funnels/{salesFunnelId}/caps": [{"maxBudget": {"amountCents": 2000, "period": "daily"}, "maxVolume": None, "funded": True}],
  "GET /v1/brands/{brandId}/offers/{offerId}/sales-funnels/{salesFunnelId}/caps": [{"maxBudget": None, "maxVolume": None, "funded": False},
                                                                                {"_after": "PUT /v1/brands/{brandId}/offers/{offerId}/sales-funnels/{salesFunnelId}/caps", "maxBudget": {"amountCents": 2000, "period": "daily"}, "maxVolume": None, "funded": True}],
}
FACTS = [
  "Fernwood (fernwood.example) has one active offer, Investor Conversations: relationships with equity investors in Europe. Its audience \"European seed and Series A investors\" is ready. No campaign exists yet; the prepaid balance is $50 with a card on file.",
  "One sales funnel runs for this offer today: \"Cold email to meetings\" (Lead Sourcing → Sales Cold Email Outreach → AI Meeting Booking), proactive.",
  "A new campaign is created stopped (POST /v1/sales-funnel-campaigns) with a brief: the one text our judge and every AI writer of the campaign read. It starts only after the client's yes in a later message.",
]
EXPECT = ("Creates the campaign stopped with a brief it wrote from the client's words: one or two plain sentences saying what it aims at, who and how "
          "(e.g. conversations with European equity investors by cold email, no pitch of the round), never a list or labels like \"Goal:\" or \"Use only these channels\". "
          "Sets the $20 a day cap, shows the client the brief and the cap, and asks their yes to start. Never starts it in this turn.")
GOOD = ("Your campaign is ready, stopped until you say go. Its brief, the text every email is written from: \"Start conversations with seed and Series A investors and angels in Europe by cold email, "
        "without pitching Fernwood's round.\" It finds them, writes to them and books a meeting when one replies, with a cap of $20 a day. Shall I start it?")
GOOD_ACTIONS = ["run_operation GET /v1/offers/{offerId}/sales-funnels",
                "run_operation POST /v1/sales-funnel-campaigns {brandId, offerId, salesFunnelId, status: stopped, brief: \"Start conversations with seed and Series A investors and angels in Europe by cold email, without pitching Fernwood's round.\"}",
                "run_operation PUT /v1/brands/{brandId}/offers/{offerId}/sales-funnels/{salesFunnelId}/caps {maxBudget: $20 daily, maxVolume: null}"]
MESSAGE = ("I want to start talking to equity investors in Europe, VCs and angels, by cold email. Don't pitch our round, just open the conversation. "
           "Set up the campaign, max $20 a day.")

def scen(id, title, surface, **kw):
  s = {"id": id, "title": title, "source": "staff test, %s, 2026-11-21" % surface, "surface": surface, "person": {"name": "Alex"},
       "history": [], "message": MESSAGE, "fixtures": copy.deepcopy(COMMON), "facts": FACTS, "expect": EXPECT,
       "goodReply": GOOD, "goodReplyActions": GOOD_ACTIONS}
  if surface == "web": s["context"] = {"currentPage": "campaigns", "recentActions": []}
  s.update(kw)
  json.dump(s, open(OUT + id + ".json", "w"), indent=1, ensure_ascii=False); open(OUT + id + ".json", "a").write("\n")

scen("brief-new-campaign", "A client asks for a campaign in their words", "web")
scen("brief-new-campaign-whatsapp", "A client asks for a campaign in their words, on WhatsApp", "whatsapp")
print("ok")
