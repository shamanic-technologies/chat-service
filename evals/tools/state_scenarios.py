import json, copy
import os
OUT = os.path.join(os.path.dirname(__file__), "..", "scenarios") + "/"
NUDGE = "(Not written by the user. The dashboard asked you to speak first: the user has the Copilot open and seems stuck or looking for something. Read `currentPage` and `recentActions` in the context, and the conversation so far, to guess what they are trying to do. Answer that in one or two short sentences, then call present_choices with 2 or 3 options that move them forward: open the right page, start the action, or answer what they look for. Never pushy, never a sales pitch, no greeting, and do not say you noticed their clicks.)"
BRAND = "33211c62-b34b-4d21-b124-4ff16338c800"; OFFER = "43870a82-f1fb-4ad4-82d9-5909fc84447c"; ORG = "8c043fa7-88b9-4e92-a96b-3dab875cb465"
HISTORY = [
  {"role": "user", "content": "diagnose results so far"},
  {"role": "assistant", "content": "Nothing is wrong so far: all 124 emails sent were delivered, none bounced, and nobody has replied yet. That's normal this early, since most went out in the last two days."},
  {"role": "user", "content": "Open my Wide Email campaign page"},
  {"role": "assistant", "content": "Your campaign page is open on the right. It shows the 124 emails delivered and the 57 prospects still waiting for a first email."},
]
NOTE = "A campaign is a sales funnel campaign: this is the full list. Its steps (sources, cold email, AI booking...) are parts of it, never campaigns: never count or name them as campaigns."
def camp(cid, name, fid, status, reason, path, runs, budget, invested, ret):
  return {"id": cid, "name": name, "path": path, "runsWhen": runs, "type": "proactive" if "start_to" in fid else "reactive", "status": status, "stopReason": reason,
          "budget": budget, "volume": None, "spent": None, "invested": invested, "return": ret, "offerId": OFFER, "salesFunnelId": fid, "steps": []}
def campaigns(status, reason):
  return {"campaignCount": 2, "note": NOTE, "campaigns": [
    camp("b255706c-b855-4593-baf1-3a6a76957269", "Wide Email", "start_to_lead_found@lead-sourcing~valid-catch-all+lead_found_to_conversation@sales-cold-email-outreach~no-offer-emails+conversation_to_paid_client", status, reason,
         "Start → Lead Sourcing → Lead found → Sales Cold Email Outreach → Positive reply → Paid client", "On its own, within its caps (no trigger)", "Max $5/day", "$101.87 invested since start", "Expected 6x · no paid client yet ($101.87 spent)"),
    camp("4b0e33f0-4a25-435e-b768-eafa9d0cff69", "Reply Booking", "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client", status, reason,
         "Positive reply → AI Meeting Booking → Meeting booked → Meeting attended → Paid client", "Each time: Positive reply", "Up to $1/day", "$0 invested since start", "no return served yet"),
  ]}
COMMON = {
  "list_brands": [{"brands": [{"id": BRAND, "name": "Beyond Logic", "domain": "beyondlogic.tech", "brandUrl": "https://beyondlogic.tech"}]}],
  "list_offers": [{"offers": [{"offerId": OFFER, "brandId": BRAND, "name": "Fixed-Price Software Build", "status": "active", "description": "Custom software development delivered in 30 days for a fixed fee with full code ownership."}]}],
  "get_offer_settings": [{"lifetimeRevenueUsd": 15000, "bookingUrl": None}],
  "get_offer_performance": [{"brandId": BRAND, "offerId": OFFER, "recipientsContacted": 828, "recipientsClicked": {"total": 3}, "recipientsRepliesPositive": {"total": 1},
                             "spent": {"actualSpentCents": 10316, "totalSpentCents": 14944}, "return": "Expected 6x · no paid client yet ($103.16 spent)"}],
  "list_replies_to_handle": [{"leads": [], "total": 0, "nextCursor": None}],
}
POSTPAID_BILLING = {"org_id": ORG, "payment_mode": "postpaid", "balance_cents": "-13824.6329741000", "usage_cents": "17837.6329741000", "amount_owed_cents": "5867.5325241000",
  "credit_line_cents": 5000, "credit_line_step_cents": 5000, "credited_cents": "4013.0000000000", "cash_paid_cents": "4013.0000000000", "actual_balance_cents": "-10616.5141241000",
  "has_auto_topup": False, "has_payment_method": True, "card_brand": None, "card_last4": None, "usage_discount_pct": 50, "postpaid_card_check": "passed"}
DECLINED_OUTLOOK = {"orgId": ORG, "paymentMode": "postpaid", "state": "charge_blocked", "blockedReason": "card_declined", "nextChargeAttemptAt": "2026-11-04T15:27:00.786Z", "trigger": "retry_rung",
  "runningDailyBudgetCents": "0.0000000000", "configuredDailyBudgetCents": "500.0000000000"}
DECLINED_FACTS = [
  "Their dashboard shows the banner \"Campaigns paused: payment declined\" on every page: the bank declined four charges on their card between 14:57 and 15:40 UTC today, so billing stopped both campaigns (Wide Email and Reply Booking) at 15:30 UTC. Nothing is running.",
  "The campaigns stay paused until they pay the balance due and have a card that works, then a person starts them again: nothing resumes on its own, and it does not clear by itself at month end.",
  "The account is postpaid; the balance due is $58.68. Billing tries the card again Wednesday 4 November at 15:27 UTC.",
  "A payment method (Stripe Link) was added at 15:40 UTC and is on file; no charge on it has succeeded yet, so it is not proven chargeable.",
  "The dashboard's Spent is $103.16 (billed, net of their 50% usage discount). $178.38 is gross usage before the discount: not a figure their dashboard shows.",
  "Their campaigns reached 828 people and brought one interested reply; no paid client yet.",
]
def scen(id, title, surface, message, fixtures, facts, expect, **kw):
  s = {"id": id, "title": title, "source": "client B, %s, 2026-11-03" % surface, "surface": surface, "person": {"name": "Chris"},
       "history": HISTORY if surface == "web" else [], "message": message, "fixtures": fixtures, "facts": facts, "expect": expect}
  if surface == "web": s["context"] = {"currentPage": "today", "recentActions": []}
  s.update(kw)
  json.dump(s, open(OUT + id + ".json", "w"), indent=1, ensure_ascii=False); open(OUT + id + ".json", "a").write("\n")

def fx(billing, outlook, cstatus, creason):
  f = copy.deepcopy(COMMON); f["get_billing_account"] = [billing]; f["get_payment_outlook"] = [outlook]; f["list_campaigns"] = [campaigns(cstatus, creason)]; return f

# 1. The exact production turn (proactive, payment declined).
scen("state-declined-proactive", "Speak first while the card is declined and campaigns are held", "web", NUDGE,
  fx(POSTPAID_BILLING, DECLINED_OUTLOOK, "stopped", "payment_declined"), DECLINED_FACTS,
  "Says first that the campaigns are paused because the card was declined, gives the $58.68 balance due, and ends on the one step that clears it (fix the card on the Billing page, then start the campaigns again). Never says nothing blocks the account, never quotes $178.38 as spent.",
  prodReply="You owe $58.68 today and your card on file is saved and chargeable, so nothing is blocking your account. The $178.38 is what your campaign spent to reach 828 people and bring in your first interested reply. I can charge the $58.68 to your saved card now, or leave it to clear automatically at month end.",
  badReplyFails=True,
  prodReplyActions=["read_skill budget-and-billing", "find_operation billing", "run_operation GET /v1/billing/accounts/saved_payment_method", "run_operation GET /v1/billing/accounts"],
  goodReply="Your campaigns are paused: the bank declined your card, so billing stopped Wide Email and Reply Booking at 15:30. Your balance due is $58.68. Next step: open the Billing page and update your card there; once the $58.68 goes through, start both campaigns again.\n1. Open Billing",
  goodReplyActions=[])
# 2. Same state, asked.
scen("state-declined-asked", "Why did my campaigns stop? (card declined)", "web", "why did my campaigns stop?",
  fx(POSTPAID_BILLING, DECLINED_OUTLOOK, "stopped", "payment_declined"), DECLINED_FACTS,
  "Answers up front: the card was declined, so billing paused both campaigns; gives the balance due and the one fix (update the card on Billing, then start them again).")
# 3/4. Prepaid, out of credit.
PREPAID_EMPTY = {"org_id": ORG, "payment_mode": "prepaid", "balance_cents": "-12.4000000000", "usage_cents": "5012.4000000000", "credited_cents": "5000.0000000000", "actual_balance_cents": "-12.4000000000",
  "has_auto_topup": False, "has_payment_method": False, "card_brand": None, "card_last4": None, "usage_discount_pct": None, "amount_owed_cents": None}
NOAUTO_OUTLOOK = {"orgId": ORG, "paymentMode": "prepaid", "state": "no_autopay", "blockedReason": None, "nextChargeAttemptAt": None, "trigger": None}
EMPTY_FACTS = [
  "The account is prepaid and its credit has run out: balance -$0.12, no auto top-up, no card saved. Their Billing page shows \"Your credit has run out. Add credit to keep your campaigns running.\"",
  "Both campaigns (Wide Email, Reply Booking) are still switched on, but nothing runs while the balance is at or below zero: no email goes out until they add credit.",
  "Adding credit is a payment link only they pay (prepaid checkout), after their yes on the amount.",
  "The dashboard's Spent is $103.16 since they started. Their campaigns reached 828 people and brought one interested reply.",
]
scen("state-out-of-credit-proactive", "Speak first when prepaid credit has run out", "web", NUDGE,
  fx(PREPAID_EMPTY, NOAUTO_OUTLOOK, "ongoing", None), EMPTY_FACTS,
  "Says the credit has run out so nothing is sent right now, and ends on adding credit (proposes an amount or opens Billing). Never says the campaigns are running fine.")
scen("state-out-of-credit-asked", "Why is nothing being sent? (out of credit)", "whatsapp", "Why is nothing being sent anymore?",
  fx(PREPAID_EMPTY, NOAUTO_OUTLOOK, "ongoing", None), EMPTY_FACTS,
  "Answers up front that the credit ran out, so the switched-on campaigns send nothing; ends on adding credit. Plain text for WhatsApp.")
# 5/6. Postpaid, no card.
NOCARD_BILLING = dict(POSTPAID_BILLING, has_payment_method=False, amount_owed_cents="2140.0000000000", balance_cents="-2140.0000000000", actual_balance_cents="-2140.0000000000")
NOCARD_OUTLOOK = dict(DECLINED_OUTLOOK, blockedReason="no_chargeable_card", nextChargeAttemptAt=None, trigger=None)
NOCARD_FACTS = [
  "Their dashboard shows the banner \"Campaigns paused: no payment method\" on every page: they removed their card, so billing stopped both campaigns (Wide Email and Reply Booking). Nothing is running.",
  "The account is postpaid; the balance due is $21.40. Their Billing page shows \"Add a card so your campaigns can run on credit.\"",
  "Once a card is added (the balance due is charged to it), a person starts the campaigns again: nothing resumes on its own.",
  "The dashboard's Spent is $103.16 since they started. Their campaigns reached 828 people and brought one interested reply.",
]
scen("state-no-card-proactive", "Speak first when there is no card and campaigns are held", "web", NUDGE,
  fx(NOCARD_BILLING, NOCARD_OUTLOOK, "stopped", "no_payment_method"), NOCARD_FACTS,
  "Says the campaigns are paused because no card is on the account, and ends on adding a card on Billing then starting the campaigns again.")
scen("state-no-card-asked", "Is my campaign running? (no card)", "whatsapp", "Is my campaign still running?",
  fx(NOCARD_BILLING, NOCARD_OUTLOOK, "stopped", "no_payment_method"), NOCARD_FACTS,
  "Answers no up front: both campaigns are paused because there is no card on the account; the fix is to add a card, then start them again. Plain text for WhatsApp.")
