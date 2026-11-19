#!/usr/bin/env python3
"""DISTRY-ONE-AI-1118 increment B: a guest's plan before any account, on the website and WhatsApp.

Owner plan 2026-11-19: a guest who gives their website gets their plan built (brand, offer, who to
reach, sample companies, a sample email) on an unclaimed org opened for the conversation; paying and
launching need their account (email proven by code), which then holds the plan. Also the turn right
after a sign-in (eval 2026-11-19: WhatsApp replies stopped at "you're in").

Writes evals/scenarios/one-ai-*.json. Staff-test data only (dutrou.com, sam@example.com): no client.
Run from the repo root: python3 evals/tools/one_ai_plan_scenarios.py
"""
import json
import pathlib

OUT = pathlib.Path("evals/scenarios")
SOURCE = "staff test, {surface}, 2026-11-19"

BRAND = {"brandId": "b-1", "domain": "dutrou.com", "name": "Dutrou", "created": True}
OFFERS = {
    "offers": [
        {"name": "Drain unblocking for restaurants", "description": "Same-day drain and pipe unblocking for restaurant kitchens in Paris.", "icon": "wrench"},
        {"name": "Grease trap cleaning", "description": "Scheduled grease trap cleaning contracts for restaurants.", "icon": "droplet"},
    ]
}
CONFIRMED = {"offers": [{"id": "o-1", "name": "Drain unblocking for restaurants"}], "chosenOfferId": "o-1", "previewEmail": "preparing"}
ICP = {"targetAudience": "Owners and managers of independent restaurants in Paris"}
SEGMENTS = {
    "segments": [
        {"name": "Independent restaurants, Paris", "description": "Owners and managers of independent restaurants in Paris, 1 to 50 employees."},
        {"name": "Restaurant groups, Ile-de-France", "description": "Operations managers of restaurant groups in Ile-de-France."},
    ]
}
AUDIENCES = {"audiences": [{"id": "a-1", "name": "Independent restaurants, Paris"}]}
PREVIEW = {
    "status": "ready",
    "companies": [
        {"name": "Le Petit Zinc", "domain": "lepetitzinc.example", "people": [{"firstName": "Marie", "lastName": "D.", "title": "Owner"}]},
        {"name": "Chez Paulette", "domain": "chezpaulette.example", "people": [{"firstName": "Hugo", "lastName": "L.", "title": "General Manager"}]},
        {"name": "Bistrot Lune", "domain": "bistrotlune.example", "people": [{"firstName": "Ines", "lastName": "R.", "title": "Owner"}]},
    ],
}
EMAIL = {
    "subject": "Blocked kitchen drain at Le Petit Zinc?",
    "body": "Hi Marie,\n\nWhen a kitchen drain blocks in the middle of service, every minute costs covers. Dutrou unblocks restaurant drains in Paris the same day.\n\nWorth keeping our number for the next time?\n\nThe Dutrou team",
}
PREPAID = {
    "state": None,
    "billing_account": "none yet: the payment link opens it",
    "reload_rules": {"first_topup_minimum_cents": 1000, "default_reload_amount_cents": 1000},
}
PLAN_FIXTURES = {
    "create_brand_from_url": [BRAND],
    "propose_offers": [OFFERS],
    "confirm_offers": [CONFIRMED],
    "suggest_icp": [ICP],
    "split_audiences": [SEGMENTS],
    "confirm_audiences": [AUDIENCES],
    "preview_audience": [PREVIEW],
    "preview_email": [EMAIL],
    # Answered only when the turn has an account: a guest's call is refused by the replay's plan guard first.
    "get_prepaid_status": [PREPAID],
    # The same figures, read alone (the gateway serves them apart too; replays of 2026-11-19 reached for it and got "no data").
    "GET /v1/billing/accounts/reload_rules": [PREPAID["reload_rules"]],
    "create_prepaid_checkout": [{"url": "https://checkout.example/session-1"}],
    "list_brands": [{"brands": [{"id": "b-1", "name": "Dutrou", "domain": "dutrou.com"}]}],
    "list_offers": [{"offers": [{"id": "o-1", "name": "Drain unblocking for restaurants"}]}],
}
SIGN_IN_FIXTURES = {
    "start_sign_in": [{"ok": True, "codeSentTo": "sam@example.com", "expiresAt": "2026-11-19T10:15:00Z"}],
    "complete_sign_in": [
        {
            "ok": True,
            "signedIn": "sam@example.com",
            "accountCreated": True,
            "note": "This conversation is now tied to this account. Right after this reply you answer again, automatically, with its access, and that answer is the one they read in place of this reply: here just say in a few words that they are in. Never ask them to send anything to continue.",
            "plan": "The plan built in this conversation (dutrou.com) is now in this account.",
        }
    ],
}

SITE_FACT = "What distribute.you offers is on its public site (https://distribute.you/llms.txt, /catalog, /terms): read it with read_our_website, whatever it says is true."
PLAN_FACT = (
    "Before any account, the assistant builds the person's plan right in this conversation from their website, with its API tools, "
    "on a draft opened for this conversation: brand, offer, who to reach, sample companies, a sample email (each step's answer is in the tool answers). "
    "Paying and launching need their account: their email and the 6-digit code sent to it, in this conversation (on the website also a phone number for urgent matters); the plan then becomes theirs."
)
GUEST_FACT = "This person has no distribute.you account yet."


def run_op(method, path, body, result):
    return {"name": "run_operation", "args": {"method": method, "path": path, **({"body": body} if body is not None else {})}, "result": {"ok": True, "status": 200, "data": result}}


def plan_history(start):
    """A guest who gave their website, and the plan built up to the sample email."""
    return [
        {"role": "user", "content": start},
        {
            "role": "assistant",
            "content": "I set up Dutrou from dutrou.com. I see two things you sell: drain unblocking for restaurants, and grease trap cleaning. Which one should we start with?",
            "toolCalls": [
                run_op("POST", "/v1/brands", {"url": "https://dutrou.com"}, BRAND),
                run_op("POST", "/v1/brands/b-1/offers/proposals", {"description": "Plumbing for restaurants in Paris"}, OFFERS),
            ],
        },
        {"role": "user", "content": "Drain unblocking, mostly for restaurants in Paris."},
        {
            "role": "assistant",
            "content": (
                "Done. We will reach owners and managers of independent restaurants in Paris: Le Petit Zinc, Chez Paulette and Bistrot Lune are in the sample. "
                "Here is the email Marie at Le Petit Zinc would get:\n\nSubject: Blocked kitchen drain at Le Petit Zinc?\n\n"
                "Hi Marie, when a kitchen drain blocks in the middle of service, every minute costs covers. Dutrou unblocks restaurant drains in Paris the same day. "
                "Worth keeping our number for the next time?\n\nShall I go on to the launch?"
            ),
            "toolCalls": [
                run_op("POST", "/v1/brands/b-1/offers/confirm", {"offers": [OFFERS["offers"][0]]}, CONFIRMED),
                run_op("POST", "/v1/brands/b-1/icp/suggest", {"offerId": "o-1"}, ICP),
                run_op("POST", "/v1/orgs/audiences/split", {"brandId": "b-1", "targetAudience": ICP["targetAudience"]}, SEGMENTS),
                run_op("POST", "/v1/orgs/audiences/split/confirm", {"brandId": "b-1", "offerId": "o-1", "targetAudience": ICP["targetAudience"], "segments": [SEGMENTS["segments"][0]]}, AUDIENCES),
                run_op("GET", "/v1/orgs/audiences/a-1/preview", None, PREVIEW),
                run_op("POST", "/v1/content/preview-email", {"brandId": "b-1", "offerId": "o-1", "audience": ICP["targetAudience"], "recipient": {"firstName": "Marie", "lastName": "D.", "title": "Owner", "companyName": "Le Petit Zinc"}}, EMAIL),
            ],
        },
    ]


def scenario(sid, title, surface, message, history, facts, expect, guest=True, after_sign_in=False, fixtures=None):
    s = {
        "id": sid,
        "title": title,
        "source": SOURCE.format(surface="website" if surface == "site" else "WhatsApp"),
        "surface": surface,
        "person": {"name": "Sam"},
        "guest": guest,
    }
    if after_sign_in:
        s["afterSignIn"] = True
    s.update({"history": history, "message": message, "fixtures": fixtures or {**PLAN_FIXTURES, **SIGN_IN_FIXTURES}, "facts": facts, "expect": expect})
    return s


def main():
    out = []
    for surface, tag in (("site", "site"), ("whatsapp", "whatsapp")):
        start = "Get started with my website dutrou.com" if surface == "site" else "I want to start, my site is dutrou.com"
        phone = " and a phone number for urgent matters, with its country code" if surface == "site" else ""
        out.append(scenario(
            f"one-ai-get-started-{tag}", "A guest wants to start with their website", surface, start, [],
            [GUEST_FACT, SITE_FACT, PLAN_FACT, "The person wants to start with dutrou.com."],
            "Starts their plan from dutrou.com right away (creates the brand from it, then goes on with what they sell), without asking for their email or an account first. "
            "Never sends them to a sign-up page or the dashboard, never asks for the website again. Ends on one next step.",
        ))
        hist = plan_history(start)[:2]
        out.append(scenario(
            f"one-ai-plan-offer-{tag}", "A guest picks what they sell: the plan goes on", surface,
            "Drain unblocking, mostly for restaurants in Paris.", hist,
            [GUEST_FACT, SITE_FACT, PLAN_FACT, "Their brand Dutrou was set up from dutrou.com this conversation; the offers proposed are in the tool answers."],
            "Keeps the offer they chose and moves their plan on in this same turn (who to reach, sample companies, a sample email, as far as the tools go), saying what it picked. "
            "Does not ask for their email or an account yet: nothing here needs one. Ends on one next step.",
        ))
        out.append(scenario(
            f"one-ai-plan-launch-{tag}", "A guest with a plan wants to launch", surface,
            "Looks great. Let's launch it.", plan_history(start),
            [GUEST_FACT, SITE_FACT, PLAN_FACT, "Their plan is built: brand Dutrou, offer drain unblocking for restaurants, independent restaurants in Paris, three sample companies, a sample email. Nothing is paid or launched."],
            f"Says launching needs their account and opens it right here: asks for their email{phone} (or calls start_sign_in once it has them), and says the plan built here comes with it. "
            "Never claims anything is paid or launched, never sends them to a sign-up page or the dashboard.",
        ))
        signed = plan_history(start) + [
            {"role": "user", "content": "Looks great. Let's launch it."},
            {"role": "assistant", "content": "Launching needs your account, and everything we built here comes with it. Which email should it use?"},
            {"role": "user", "content": "sam@example.com" + (", +33612345678" if surface == "site" else "")},
            {
                "role": "assistant",
                "content": "A 6-digit code just went to sam@example.com. Send it here when you have it.",
                "toolCalls": [{"name": "start_sign_in", "args": {"email": "sam@example.com"}, "result": SIGN_IN_FIXTURES["start_sign_in"][0]}],
            },
            {
                "role": "user",
                "content": "482913",
            },
            {
                "role": "assistant",
                "content": "You're in, Sam.",
                "toolCalls": [{"name": "complete_sign_in", "args": {"email": "sam@example.com", "code": "482913"}, "result": SIGN_IN_FIXTURES["complete_sign_in"][0]}],
            },
        ]
        message = "(They just signed in, in this same exchange. With their account, take them one step further from where they stopped.)" if surface == "site" else "482913"
        # WhatsApp (lead-turn.ts): the answer with the account re-runs the SAME lead event (their code) on the
        # whole thread, the sign-in turn's hidden words included; the site gets the hidden trigger. Before, the
        # WhatsApp replay cut the code and graded the sign-in turn itself, which never reaches them.
        out.append(scenario(
            f"one-ai-after-sign-in-{tag}", "Right after the sign-in: the plan is theirs, the next step comes", surface, message, signed,
            [
                "They just proved their email in this conversation: the account is theirs and holds the plan built before (brand Dutrou, offer drain unblocking for restaurants, independent restaurants in Paris, the sample email).",
                "Nothing is paid or launched yet. The account's payment status and its first payment and reload figures are in the tool answers (get_prepaid_status).",
                SITE_FACT,
                "They asked to launch before signing in.",
            ],
            "Says in a few words that they are in, then takes them one step further toward the launch they asked for, with their account (the first payment with its figures read from the account, asking their yes, or the campaign to propose). "
            "Never stops at their being in, never asks them to send anything to continue, never asks for the website or what they sell again.",
            guest=False, after_sign_in=True,
        ))
        # Staff test 2026-11-19: right after the sign-in, asked to pay, the answer gave the dashboard home
        # (« add money … here's the link: https://dashboard.distribute.you ») after « You're in » twice.
        # Owner 2026-11-17: a person who must pay gets a DIRECT checkout link.
        pay = [dict(m) for m in signed]
        ask = next(i for i, m in enumerate(pay) if m["content"] == "Looks great. Let's launch it.")
        pay[ask]["content"] = "Looks great. How do I pay so it can start?"
        pay[ask + 1] = {"role": "assistant", "content": "Paying needs your account, and everything we built here comes with it. Which email should it use?"}
        out.append(scenario(
            f"one-ai-after-sign-in-pay-{tag}", "Right after the sign-in, they asked how to pay: the payment's own link", surface, message, pay,
            [
                "They just proved their email in this conversation: the account is theirs and holds the plan built before (brand Dutrou, offer drain unblocking for restaurants, independent restaurants in Paris, the sample email).",
                "Nothing is paid or launched yet. The account's payment status and its first payment and reload figures are in the tool answers (get_prepaid_status); the payment link is what create_prepaid_checkout returns, after their yes on the amounts.",
                SITE_FACT,
                "They asked how to pay before signing in.",
            ],
            "Says once, in a few words, that they are in, then moves to the payment they asked about: the first payment and reload figures read from their account with their yes asked, or the payment link the checkout returns. "
            "Never gives the dashboard address or tells them to find the payment on the dashboard, never stops at their being in, never says twice that they are in.",
            guest=False, after_sign_in=True,
        ))
    for s in out:
        (OUT / f"{s['id']}.json").write_text(json.dumps(s, indent=2, ensure_ascii=False) + "\n")
        print("wrote", s["id"])


if __name__ == "__main__":
    main()
