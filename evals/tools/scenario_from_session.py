"""Build eval scenarios from recorded Copilot sessions (SOPHIE-REFONTE-1102).

Input: a sessions dump (one JSON object per line: sessionId, messages[] with role,
content, toolCalls, hidden) and a spec file (JSON list). Each spec entry names the
session (id prefix), the person's message to answer (index among their VISIBLE
messages), the surface, a replacement map (real name -> invented name) and the
hand-written facts / expect / goodReply. Output: evals/scenarios/<id>.json.

Every email and phone number is replaced; names in `replace` are replaced
everywhere (history, fixtures, prod reply). Fixtures = the tool answers recorded
in the session, the target turn's own first, then earlier ones (latest first),
then later ones.

  python3 evals/tools/scenario_from_session.py <sessions.jsonl> <spec.json>
"""
import json, re, sys, os

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@(?!distribute\.you)[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?<![\w.])\+?\d[\d ]{9,13}\d(?![\w.])")
MAX_FIXTURE_CHARS = 30000

def scrub(text, replace, emails):
    for real, fake in replace.items():
        text = re.sub(re.escape(real), fake, text, flags=re.IGNORECASE)
    def mail(m):
        e = m.group(0).lower()
        if e not in emails:
            emails[e] = f"person{len(emails) + 1}@example.com"
        return emails[e]
    text = EMAIL_RE.sub(mail, text)
    return PHONE_RE.sub("+10000000000", text)

def build(session, spec):
    msgs = [m for m in (session["messages"] or []) if not (m["role"] == "user" and m["hidden"])]
    users = [i for i, m in enumerate(msgs) if m["role"] == "user"]
    t = users[spec["turn"]]
    history = []
    for m in msgs[:t]:
        if m["role"] == "assistant" and not (m["content"] or "").strip() and not m["toolCalls"]:
            continue
        h = {"role": m["role"], "content": m["content"] or ""}
        if m["toolCalls"]:
            h["toolCalls"] = [{"name": c["name"], "args": c.get("args") or {}, **({"result": c["result"]} if "result" in c else {})} for c in m["toolCalls"]]
        history.append(h)
    reply_msgs = []
    for m in msgs[t + 1:]:
        if m["role"] == "user":
            break
        reply_msgs.append(m)
    prod_reply = "\n\n".join((m["content"] or "").strip() for m in reply_msgs if (m["content"] or "").strip())
    prod_actions = []
    for m in reply_msgs:
        for c in m["toolCalls"] or []:
            a = json.dumps(c.get("args") or {}, ensure_ascii=False)
            call = c["name"] if a == "{}" else f'{c["name"]} {a[:300]}'
            if "result" in c:
                r = json.dumps(c["result"], ensure_ascii=False)
                call += " → " + (r[:20000] + "..." if len(r) > 20000 else r)
            prod_actions.append(call)
    ordered = reply_msgs + list(reversed(msgs[:t])) + msgs[t + 1:]
    fixtures = {}
    for m in ordered:
        for c in m["toolCalls"] or []:
            if "result" not in c or c["name"] in ("present_choices", "open_page", "read_skill", "read_our_website", "request_user_input"):
                continue
            r = c["result"]
            if len(json.dumps(r)) > MAX_FIXTURE_CHARS:
                continue
            lst = fixtures.setdefault(c["name"], [])
            if len(lst) < 3 and r not in lst:
                lst.append(r)
    scenario = {
        "id": spec["id"], "title": spec["title"], "source": spec["source"], "surface": spec["surface"],
        "person": spec["person"],
        **({"context": spec["context"]} if spec.get("context") else {}),
        "history": history[-spec.get("historyMax", 40):],
        "message": msgs[t]["content"],
        "fixtures": fixtures,
        "facts": spec["facts"], "expect": spec["expect"],
        **({"prodReply": prod_reply} if prod_reply else {}),
        **({"prodReplyActions": prod_actions} if prod_reply and prod_actions else {}),
        **({"badReplyFails": True} if spec.get("badReplyFails") else {}),
        **({"goodReply": spec["goodReply"]} if spec.get("goodReply") else {}),
        **({"goodReplyActions": spec["goodReplyActions"]} if spec.get("goodReplyActions") else {}),
    }
    emails = {}
    def walk(v):
        if isinstance(v, str):
            return scrub(v, spec.get("replace", {}), emails)
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        return v
    return walk(scenario)

def main():
    sessions = {}
    for line in open(sys.argv[1]):
        s = json.loads(line)
        sessions[s["sessionId"]] = s
    out_dir = os.path.join(os.path.dirname(__file__), "..", "scenarios")
    for spec in json.load(open(sys.argv[2])):
        session = next(s for sid, s in sessions.items() if sid.startswith(spec["session"]))
        scenario = build(session, spec)
        path = os.path.join(out_dir, f"{spec['id']}.json")
        with open(path, "w") as f:
            json.dump(scenario, f, indent=2, ensure_ascii=False)
        print(spec["id"], len(json.dumps(scenario)), "chars,", len(scenario["fixtures"]), "fixture tools")

if __name__ == "__main__":
    main()
