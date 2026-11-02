# Sophie evals (SOPHIE-REFONTE-1102)

Nothing about the conversational agent (prompt, skills, tools, model, thinking level)
merges without a passing run here. Owner, 2026-11-02: « evals first ».

## What is here

| Path | What |
|---|---|
| `scenarios/*.json` | One turn of a real conversation each: history, the message to answer, the account's recorded tool answers (`fixtures`), the `facts` the judge holds true, what a great answer does (`expect`), the production reply, a hand-written good reply. Anonymised: no client email, no phone, person names replaced. |
| `definitions/*.json` | An agent definition: prompt, allowed tools, skills, model. `prod-2026-11-02.json` = the Copilot as it ran in production before the rebuild. `outside-ai.json` = an outside AI driving the account through our API with only the skills (no Sophie role, no brief): proves the skills carry the method. |
| `calibration.json` | Last judge calibration: every known-bad production reply must FAIL, every good reply must PASS. A unit test refuses a merge when it is not 100%. |
| `results/*.json` | Replay runs kept as evidence (per scenario: replies, tools, cost, verdicts). |
| `tools/lead_scenario_from_turns.py` | Builds Lead event scenarios (surface `lead`) from `copilot_lead_turns` rows: the writer's payload, the production answer, facts and a good answer. |
| `tools/scenario_from_session.py` | Builds scenarios from a dump of chat_service sessions + a spec (facts, expect, good reply). Keep the spec out of git: it holds the real names it replaces. |

## The judge

Jev (`src/evals/judge.ts`) answers one yes/no question per criterion: **true** (nothing invented, every done action is in the turn's tool calls), **respectful** (no recited limits, never runs us down), **proactive** (did the work, asked only what only the client knows), **answers** (the question, up front), **nextAction** (ends on one concrete step), **form** (right for the surface). A criterion passes at p(yes) >= 0.5.

A scenario passes when a majority of its replays pass every criterion. A suite passes when every scenario passes, **true** holds on every replay, and the median reply costs under **$0.03**.

**The merge gate** (`evals/last-run.json`, pinned by `tests/unit/evals.test.ts`): on the current `sophieCodeHash()`, the pooled share of replies passing every criterion, over at least 3 replies per scenario (100+) a side, is at least the baseline's, measured the same hour on the same judge. One 60-replay run swings by about two scenarios, so a single run decides nothing.

## Running (inside the chat-service container on the box)

The runner reads platform keys from key-service and declares its spend on platform runs marked `staff_experiment`. Tools are answered from the scenario: no client account is read or written, nothing is sent.

```bash
# local: build and copy into an isolated dir of the container (the live service is untouched)
npx tsc -p . && COPYFILE_DISABLE=1 tar czf /tmp/evals.tgz dist evals src/agent src/lib/client-brief.ts  # the sources: sophieCodeHash() reads them
scp -i ~/.ssh/oracle-distribute /tmp/evals.tgz root@167.233.196.79:/tmp/<workspace>-evals.tgz
# box: unpack in /tmp/sophie-evals of distribute-chat-service-1, symlink /app/node_modules, then
node dist/evals/run.js --definition evals/definitions/<id>.json --runs 3 --parallel 5 --out /tmp/sophie-evals/run.json
node dist/evals/run.js --definition evals/definitions/<id>.json --calibrate --out /tmp/sophie-evals/calibration.json
```

Surfaces: `web`, `whatsapp` and `lead` (a Lead event turn ending on `answer_person`; a decision to write nothing is judged as a decision, never as a message). `--definition code` replays Sophie as the code defines her (her model's reasoning setting included; `--reasoning-on` / `--reasoning-off` override it); `--provider google --model flash-pro` runs her on Gemini (the Anthropic loop lives inside the /chat handler and is not replayable yet); `--seed-skills all` (or a list of slugs) uses the skills as this code seeds them instead of the live table. `--only id1,id2` runs a subset, `--provider` / `--model` override the definition's model (direct vendors only for now: DeepSeek, Z.ai, Moonshot, OpenAI).

## Adding a scenario

Every new failure seen in production becomes a scenario before it is fixed: dump the session, add a spec entry (turn index among the person's visible messages, facts, expect, the production reply flagged `badReplyFails` when it is a failure, a good reply with the actions it stands on), build, recalibrate.
