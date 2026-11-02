"""Build Lead event eval scenarios from recorded lead turns (SOPHIE-REFONTE-1102).

Input: a dump of chat_service `copilot_lead_turns` (one JSON object per line:
id, payload, answer, accountOrgId) and a spec (JSON list: id, turn = lead turn
id prefix, title, source, replace = real name -> invented name, facts, expect,
goodReply, goodReplyActions, badReplyFails). Emails and phones are replaced
everywhere; a decision to write nothing is rendered in plain words, the way the
judge reads it.

  python3 evals/tools/lead_scenario_from_turns.py <lead-turns.jsonl> <spec.json>
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from scenario_from_session import scrub

TRIGGER = "(Not the person's words.) A Lead event about this person: decide and answer through answer_person."

def readable(answer, field):
    sent = answer.get(field) or ""
    if sent.strip():
        return sent
    reason = answer.get("reason") or answer.get("why") or answer.get("nextFollowUpWhy")
    nxt = answer.get("nextFollowUpAt")
    return " ".join(x for x in ["Nothing sent to them now.", f"Reason: {reason}" if reason else None, f"Next look: {nxt}." if nxt else None] if x)

def main():
    rows = {json.loads(l)["id"][:8]: json.loads(l) for l in open(sys.argv[1])}
    out_dir = os.path.join(os.path.dirname(__file__), "..", "scenarios")
    for spec in json.load(open(sys.argv[2])):
        r = rows[spec["turn"]]; p = r["payload"]
        emails = {}
        def walk(v):
            if isinstance(v, str): return scrub(v, spec["replace"], emails)
            if isinstance(v, list): return [walk(x) for x in v]
            if isinstance(v, dict): return {k: walk(x) for k, x in v.items()}
            return v
        sc = walk({
            "title": spec["title"], "source": spec["source"], "surface": "lead",
            "person": {"name": list(spec["replace"].values())[0]},
            "lead": {"payload": p, "guest": not bool(r["accountOrgId"]),
                     "phoneBound": p["medium"] == "whatsapp" and bool((p.get("recipient") or {}).get("phone"))},
            "history": [], "message": TRIGGER, "fixtures": {},
            "facts": spec["facts"], "expect": spec["expect"],
            "prodReply": readable(r["answer"] or {}, p["messageField"]),
            **({"badReplyFails": True} if spec.get("badReplyFails") else {}),
            "goodReply": spec["goodReply"], "goodReplyActions": spec["goodReplyActions"],
        })
        sc = {"id": spec["id"], **sc}
        with open(os.path.join(out_dir, f"{spec['id']}.json"), "w") as f:
            json.dump(sc, f, indent=2, ensure_ascii=False)
        print(spec["id"])

if __name__ == "__main__":
    main()
