# Sophie's model bake-off at equal conditions (SOPHIE-MODEL-BAKEOFF-1113, 2026-11-13)

Owner, 2026-11-13: « Tu es sûr que tu as comparé toutes choses étant égales ? Est-ce que tu avais bien permis le multimodal sur Haiku, le thinking équivalent des deux côtés, etc ? »
The 2026-11-11 bake-off (SOPHIE-CORE-1111: DeepSeek 63.8% / Haiku 5.5 47.1% / Sonnet 5.5 63.0%) was not: Claude ran on an eval-only mini-loop with no thinking block, the history as plain text and no photos, while DeepSeek ran the real /chat vendor loop. This run fixes the harness and replays every arm on the same scenarios, judge and hour.

## Results (51 scenarios x 3 replies x 2 rounds = 306 replies per arm)

Round A ran 11:38-11:51 UTC, round B 11:51-12:02 UTC, the five arms of each round launched together in fresh directories of one throwaway container (`sophie-bakeoff-1113`). Pass = a reply passes all six criteria (Jev `jev-1.13.0`, calibration unchanged). $/reply = billed lines of the model calls (judge excluded), mean. s/reply = wall time of the turn, mean, 4 replies in flight per arm.

| Arm | Wire sent (checked on every request) | Images | Loop | Replies | Pass | true | respectful | proactive | answers | next action | form | $/reply | s/reply |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DeepSeek V4.1 Flash (prod) | `deepseek-flash`, no `thinking` field (vendor default: reasoning on), max_tokens 32000 | on (6 req, photo scen. 4/6) | /chat vendor loop (`streamVendorChat`) | 306 (51 scen.) | **54.9%** | 86% | 93% | 91% | 92% | 86% | 97% | $0.0021 | 15.4 |
| Haiku 5.5, effort not sent (prod backup) | `claude-haiku-5-5`, thinking `adaptive` (block_binding drop_block), effort `not sent`, max_tokens 64000, context management on | on (6 req, photo scen. 6/6) | /chat Anthropic request (`createStream`) | 306 (51 scen.) | **48.7%** | 90% | 84% | 85% | 85% | 80% | 96% | $0.0016 | 7.7 |
| Haiku 5.5, effort low | `claude-haiku-5-5`, thinking `adaptive` (block_binding drop_block), effort `low`, max_tokens 64000, context management on | on (6 req, photo scen. 6/6) | /chat Anthropic request (`createStream`) | 306 (51 scen.) | **51.0%** | 91% | 84% | 84% | 86% | 82% | 98% | $0.0015 | 5.6 |
| Haiku 5.5, effort medium | `claude-haiku-5-5`, thinking `adaptive` (block_binding drop_block), effort `medium`, max_tokens 64000, context management on | on (6 req, photo scen. 4/6) | /chat Anthropic request (`createStream`) | 306 (51 scen.) | **46.4%** | 87% | 81% | 87% | 83% | 82% | 97% | $0.0016 | 7.8 |
| Sonnet 5.5, effort not sent (reference) | `claude-sonnet-5-5`, thinking `adaptive` (block_binding drop_block), effort `not sent`, max_tokens 64000, context management on | on (6 req, photo scen. 6/6) | /chat Anthropic request (`createStream`) | 306 (51 scen.) | **49.0%** | 92% | 85% | 90% | 86% | 85% | 95% | $0.0328 | 9.3 |

Per round (pass rate): DeepSeek 54.9% / 54.9%; Haiku not sent 50.3% / 47.1%; Haiku low 50.3% / 51.6%; Haiku medium 47.1% / 45.8%; Sonnet 50.3% / 47.7%. Two runs of the same code move ~7 points on 112 replies (README): every Claude arm is within noise of the others; DeepSeek is ahead of each in BOTH rounds (3 to 9 points).

Where they differ (scenario-level, 6 replies each, DeepSeek vs Haiku low): DeepSeek wins on client-account turns (`martian-close-account` +5, `martian-exclude-leads` +4, `core-refill-on-small-budget` +4, `martian-which-ai` +3, `false-ready-preview-fails` +3), mostly on **respectful** (Haiku fails it 39 times on `martian-*` vs 18 for DeepSeek: "I can't close the account from here"); Haiku wins on Lead event turns (`lead-whatsapp-unanswered-asks` +5, `lead-check-what-they-have` +4, `lead-whatsapp-signed-up-live` +4, `truth-campaign-rule` +4).

Reading: on today's agent (prompt, skills and tools tuned on DeepSeek since 11-02), DeepSeek V4.1 Flash reasoning on stays first at ~55%. Haiku 5.5 at effort low is the best Claude arm (51%), the cheapest per reply ($0.0015 vs $0.0021) and 2.7x faster (5.6 s vs 15.4 s). Thinking more does not help Haiku (medium 46% < low 51%). Sonnet 5.5 costs 15x more for no gain. The 11-11 gap (17 points Haiku vs DeepSeek) shrinks to 4-6 points once Claude gets its real request.

## What was equal

- Agent: Sophie as the code defines her (`--definition code`, `sophieCodeHash` of origin/main b283e2d), the live skills table, same situation and client briefs, same tools answered from the same fixtures.
- Scenarios: all 51, photos included (`wa-human-photo-no-words`: image blocks on every arm, 6 requests with an image per arm, read from the wire).
- Judge: Jev `jev-1.13.0`, same questions, same thresholds; same hour; fresh output directories launched together; same parallelism (4).
- History: stored tool calls replayed as tool call / tool result pairs on both sides (DeepSeek: /chat vendor loop; Claude: `rebuildAnthropicHistory`, as /chat does).
- Loop rules: 10 tool rounds, final round told to answer with tools off, one re-ask on a silent turn, a lead turn re-asked to call `answer_person`, tool errors returned as errors, working notes beside tool calls held.
- Each side's production setting is measured as production sends it, checked on every request at the fetch boundary (`wire` in each result file): DeepSeek sends no `thinking` field (vendor default: reasoning on, the field SOPHIE_MODEL "on" means); Haiku as Sophie's backup sends `thinking: adaptive` with no `output_config` (the `copilot` config's effort is NULL).

## What could not be made equal, and why

- **Thinking level has no common scale.** DeepSeek V4.1 Flash has two states (reasoning on / off: `thinking: {type: disabled}`), Claude adaptive thinking has an effort scale. The matched pair is "both reasoning on": DeepSeek on vs Haiku adaptive at effort low and medium, plus each one's production setting. DeepSeek off was not re-run: measured on 11-12 at equal wire (VENDOR-TOOLS-FOLLOWUP-1112: off 21-25/51 scenarios vs on 29-30), and it spends the platform DeepSeek balance prod Sophie answers on ($5.96 before this run, $5.36 after).
- **Loop code is copied, not shared, for Claude.** The /chat Anthropic loop lives inline in the /chat handler (index.ts); the replay builds every request with the same function (`createAnthropicClient().createStream`: thinking, context management, cache, betas, max_tokens are byte-identical to prod) but the control flow around it is a copy (`src/evals/anthropic-replay.ts`), pinned by `tests/unit/evals-anthropic-replay.test.ts`. Streaming vs final message only changes transport.
- **Output cap differs:** DeepSeek 32,000 vs Claude 64,000, each loop's production value. No turn came near either (largest: 8,075 output tokens over a whole DeepSeek turn, 4,786 for Claude).
- **Prompt cache warmth differs by vendor:** each vendor caches as in production (DeepSeek implicit, Claude explicit breakpoints). It changes cost, not the answer.
- **Latency is the vendor's own:** DeepSeek turns made 4.4 model calls per reply vs 1.8-2.8 for Claude, and DeepSeek reasons on every call; both arms ran 4 replies in flight from the same box.
- **The agent was tuned on DeepSeek** (every prompt and skill edit since 11-02 was gated on DeepSeek runs). Claude is measured on a definition shaped for another model; this is the production question (switch the model under today's Sophie), not "which model could do better with its own prompt".

## Files

`2026-11-13-bakeoff-{a,b}-<arm>.json`: every reply, its tool calls, cost lines, latency, verdict, and the `wire` block (each distinct request setting with its request count).
