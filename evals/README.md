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

Jev (`src/evals/judge.ts`) answers one yes/no question per criterion: **true** (nothing invented, every done action is in the turn's tool calls), **respectful** (no recited limits, never runs us down), **proactive** (did the work, asked only what only the client knows), **answers** (the question, up front), **nextAction** (ends on one concrete step), **form** (right for the surface). A criterion passes at p(yes) >= 0.5. The judge reads what the model read: the conversation, every tool answer, the turn's whole context (briefs, channel or Lead event block) and the prompt's `## You` line (its model name). Gateway calls answer in the order the session recorded them. Two runs of the SAME code moved ~7 points on 112 replays (2026-11-02): read a small gap as noise. A scenario's `facts` must agree with its `fixtures`: when they disagree, the reply is graded against data it never saw (fix the facts, never the judge question).

A scenario passes when a majority of its replays pass every criterion. A suite passes when every scenario passes, **true** holds on every replay, and the median reply costs under **$0.03**.

**The merge gate** (`evals/last-run.json`, pinned by `tests/unit/evals.test.ts`): on the current `sophieCodeHash()`, the pooled share of replies passing every criterion, over at least 3 replies per scenario (100+) a side, is at least the baseline's, measured the same hour on the same judge. One 60-replay run swings by about two scenarios, so a single run decides nothing.

## How far the judge's "true" can be trusted (2026-11-02)

`evals/labels/` holds hand-checked labels: per stored reply, is every statement of fact supported by what the model read. `--rejudge <run.json> --labels <file> [--judge <id>]` grades a past run's stored replies again and reports agreement with the labels, so the judge is measured without the agent's own variance. On 112 labelled replies (`results/2026-11-02-judge-true-benchmark.json`): Jev agrees on 79 (71%, 67% before the question was reworded), Cloudflare Clef 70% (calls nearly everything true), claim-by-claim checks 63-65%; two Claude labelers agree with each other on 86%. Every judge misses the same subtle inventions ("3,628 companies" for 3,628 people, "the team will answer you here" when it answers by email). So read the "true" rate as a coarse signal: a change to Sophie's truthfulness is measured on labels, not on the judge's rate alone.

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

**Account states, not only conversations (SOPHIE-BRIEF-EQUALS-DASHBOARD-1103).** Every state the client's dashboard can show (each payment band and Billing note: payment declined, no card, credit run out) has a scenario, once as a proactive "speak first" turn and once asked (`state-*.json`, built by `tools/state_scenarios.py`: the account answers are typed in the script, a payment state through the `get_payment_outlook` fixture). A new banner on the dashboard = two new scenarios here. A scenario without a `get_payment_outlook` fixture reads "not known this turn" in the brief, as production does when billing does not answer.
