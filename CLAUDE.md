# Chat Service - Claude Agent Instructions

## Commands

- `npm test` — run all tests
- `npm run test:unit` — run unit tests only
- `npm run test:integration` — run integration tests only
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm run dev` — local dev server with hot reload (port 3002)
- `npm run generate:openapi` — regenerate openapi.json from Zod schemas
- `npm run db:generate` — generate Drizzle migrations
- `npm run db:migrate` — run migrations
- `npm run db:push` — push schema directly (dev only)

## README Maintenance (MANDATORY)

**Every PR that changes functionality must include a README.md update.** This is a hard rule.

When making changes to this codebase, always check if the README needs updating. Specifically:

- **New or changed endpoints**: Update the SSE Protocol section
- **New or changed environment variables**: Update the Environment Variables table
- **New dependencies**: Mention if they affect setup
- **New or changed SSE event types**: Update the protocol docs and rendering guidance
- **Schema changes**: Update if they affect the API contract
- **Docker/deployment changes**: Update relevant sections
- **New scripts**: Update the Development section

After completing your code changes, re-read README.md and verify every section is still accurate. If anything is stale, fix it in the same PR.

## Regression Tests (MANDATORY)

**Every PR that fixes a bug or adds functionality must include tests.** This is a hard rule.

- **Bug fixes**: Add a test that reproduces the bug and verifies the fix. The test must fail without the fix and pass with it.
- **New features**: Add unit tests covering the happy path and key edge cases.
- **Test location**: `tests/unit/` for pure logic, `tests/integration/` for endpoint/DB behavior.
- **Naming**: Test file should mirror the source file (e.g., `src/lib/gemini.ts` → `tests/unit/gemini.test.ts`).
- **Minimum**: At least one new or modified test file per PR that touches `src/`.

CI will warn if source files change without corresponding test changes. Do not skip this.

## Architecture

- `src/index.ts` — Express server, `/chat`, `/config`, `/health`, `/openapi.json`
- `src/schemas.ts` — Zod schemas (source of truth for validation + OpenAPI)
- `src/types.ts` — SSE event TypeScript interfaces
- `src/middleware/auth.ts` — Auth middleware (Authorization Bearer + x-org-id + x-user-id)
- `src/db/schema.ts` — Drizzle table definitions (sessions, messages, app_configs)
- `src/db/index.ts` — Drizzle client init
- `src/lib/gemini.ts` — Gemini AI client, streaming + function calling
- `src/lib/mcp-client.ts` — MCP server connection via Streamable HTTP + tool execution
- `src/lib/key-client.ts` — Key-service client for app-key and org-key decryption
- `src/lib/runs-client.ts` — RunsService HTTP client for run tracking and cost reporting
- `src/lib/config-defaults.ts` — Chat provider/model default resolution + registration merge semantics
- `scripts/generate-openapi.ts` — Generates openapi.json from Zod schemas
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually

## Chat provider/model default — Gemini, in code (not the DB)

The default LLM for `/chat` is **Gemini `google`/`flash-pro`** (Gemini 3.5 Flash, mid-tier), resolved in code by `resolveChatProviderModel` (`src/lib/config-defaults.ts`). A config row (`app_configs` / `platform_configs`) with `provider`/`model` NULL resolves to `google`/`flash-pro` — **NOT** `anthropic`/`sonnet`. The Anthropic platform key has no credit balance; defaulting to it 400s every chat that uses a default config.

**The agentic `workflow` chat is the one deliberate exception — pinned to `pro`** via an explicit `platform_configs` row (`key='workflow'`, `provider='google'`, `model='pro'` NOT NULL), so the heaviest tool-calling / DAG-generation mode keeps the strongest model. The pin is durable for the same no-clobber reason below (the registrar re-registers `workflow` without `provider`/`model`, so `buildConfigConflictSet` keeps the explicit `pro`). The default moved `pro → flash-pro` 2026-06-04 (DIS-130) so all OTHER dashboard chats (NULL configs: `feature`, `press-kit`, `campaign-prefill`, plus the explicit `default`-key rows) run the cheaper mid-tier model. **Do NOT flip `defaultModelAliasFor` back to `pro`, and do NOT remove the `workflow` pin** — that silently downgrades or upgrades the wrong chats.

Do NOT "fix" a provider switch by flipping the DB `provider`/`model` columns alone. That reverts: apps re-register their config at every cold start via `PUT /config` / `PUT /platform-config`, and the registration **must not clobber an omitted field**. Both handlers build their `onConflictDoUpdate.set` via `buildConfigConflictSet`, which includes `provider`/`model` ONLY when the caller actually supplied them — an omitted field keeps the stored value. **Never reintroduce `provider: provider ?? null` (or `model ?? null`) into the conflict `set`** — that resets every explicit override to NULL on the next app boot, which is exactly the bug that silently put all chat back on the dead Anthropic key (incident 2026-06-01, fixed v0.32.1). The `?? null` belongs only in the INSERT `.values` (a brand-new row legitimately starts NULL, then resolves to the Gemini default).

**Two platform configs are SELF-SEEDED by chat-service, not the dashboard.** `persona-editor` + `brand-profile-editor` are owned by chat-service: their prompts, allowedTools, and provider/model live in `src/lib/seed-platform-configs.ts` and are upserted at boot (in the `migrate(...).then()` → `seedPlatformConfigs(db)` path, before `app.listen()`). This is DELIBERATE and differs from every other config (`workflow`, `feature`, `press-kit`, `campaign-prefill`), which the dashboard registers via `PUT /platform-config` at ITS boot. Do NOT "fix" the absence of these two keys from the dashboard's `instrumentation.ts` registrar by adding them there — that would split prompt ownership and risk a clobber war. The seed only upserts these two keys, so it never touches dashboard-owned configs; it upserts on every boot so the stored config always reflects the code (no manual DB flip). Their tools (`list_personas`/`create_persona`/`duplicate_persona`/`set_persona_status`, `get_brand_profile`/`save_brand_profile_version`) call brand-service through api-service via `src/lib/brand-content-client.ts`, scoped to `context.brandId`. Personas are immutable-except-status (no hard delete; 409 name clash → friendly `name_taken` result, NOT a throw); brand profile is versioned-immutable (save reads current → merges `changes` → POSTs the FULL field map as a new version). (Shipped 2026-06-16.)

**Deploy ordering when adding a new model alias:** a config row's `model` value is only resolvable by code that knows the alias (`MODEL_MAP`/`PROVIDER_MODELS`). When introducing a new alias (e.g. `flash-pro`) AND flipping DB config rows to it, **deploy the alias code to PROD first, then write the DB rows** — never the reverse. A row set to `flash-pro` while old prod code is still live throws `Unknown model "flash-pro"` → 500 on every chat using that config. Gate the DB write on prod actually serving the new code (the prod api-registry's deployed `/complete` model enum showing the alias is a safe signal), since staging+prod may share the Neon branch. The `pro`-pin for `workflow` is the opposite case — `pro` is known to all versions, so it can be written anytime, ideally BEFORE the default-flip code lands so `workflow` never briefly resolves to the new default (incident 2026-06-04, DIS-130 flash-pro rollout).

## Gemini `/chat` streaming — SSE framing must stay tolerant

`/chat` on `provider:"google"` streams via `gemini-chat.ts:streamGeminiChat`. Gemini's `:streamGenerateContent?alt=sse` stream frames events with **any of `\n\n`, `\r\r`, `\r\n\r\n`** and may emit `data:` with or without a trailing space — exactly what Google's official `@google/genai` SDK handles (`processStreamResponse`: `delimiters = ['\n\n', '\r\r', '\r\n\r\n']`, prefix `data:`). `parseGeminiSSEBuffer` mirrors this. **Never narrow it back to `indexOf("\n\n")` or `startsWith("data: ")`** — the real stream uses `\r\n\r\n`, so an `\n\n`-only parser yields ZERO events and an empty chat response with HTTP 200 and no error (incident 2026-06-01, fixed v0.32.2; the bug hid for the whole Anthropic-only period because the streaming parser had no test coverage). The Gemini stream path must also **fail loud**, not return `""`: throw on an in-band `{"error":...}` chunk and on a wholly-empty stream (no content, tool calls, or usage). When touching any provider's streaming parser, confirm the wire framing against that provider's official SDK source, not an assumption.

### Gemini 3 thought signatures — required on tool-call replay

Gemini 3 enforces [thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures): a `functionCall` part returned by the model carries an opaque `thoughtSignature` that **must be echoed back in the same part on every later request**, or the API returns `400 INVALID_ARGUMENT: Function call ... is missing a thought_signature`. (Gemini 2.5 only warns; Gemini 3 hard-400s.) `gemini-chat.ts` captures `part.thoughtSignature` from the stream, persists it on `ToolCallRecord.thoughtSignature` (jsonb), and re-attaches it on replay (`toGeminiHistory`) and in the agentic loop's `modelParts`. For tool calls recorded before the field existed (no stored signature), it injects Google's sanctioned bypass value **`skip_thought_signature_validator`**. **Never drop `thoughtSignature` from a replayed `functionCall` part** — every functionCall sent in history must carry one (real or the dummy), or multi-turn tool chats 400 on the second turn (incident 2026-06-01, fixed v0.32.3).

### Gemini 3 `functionResponse` — `$ref` in tool results must be sanitized

Gemini 3 reads `{"$ref": "<name>"}` inside a `functionResponse.response` as a reference to a **multimodal part** (the model substitutes the named part — see the [function-calling docs](https://ai.google.dev/gemini-api/docs/function-calling)). Tool results that embed JSON-Schema / OpenAPI `$ref`s — e.g. the api-registry / endpoint tools returning `{"$ref": "#/components/schemas/OrgId"}` — collide: the name matches no part `displayName`, so the API returns `400 INVALID_ARGUMENT: ... does not match to a display_name ...` and kills the chat turn. `sanitizeGeminiToolResponse` recursively renames every `$ref` key to `ref` (value preserved as plain data) and is applied to **both** the live tool result and the replayed result in `toGeminiHistory` (stored `tool_calls` carry the raw `$ref`). **Never send a tool result into `functionResponse.response` without this pass** (incident 2026-06-01, fixed v0.32.4). Only the `{"$ref": ...}` key form triggers it — a bare string containing `#/...` is harmless.

### Gemini tool DECLARATIONS — param schemas must be sanitized too (`sanitizeGeminiSchema`)

Gemini's `function_declarations[].parameters` is the **same restricted OpenAPI-3.0 `Schema` type as `responseSchema`** ([Schema ref](https://ai.google.dev/api/caching#Schema)) — it 400s on `additionalProperties`, `$ref`, `$schema`, `const`, `examples`, `exclusiveMinimum/Maximum`, `multipleOf`, etc. MCP tool input schemas (JSON-Schema 7) routinely carry these (a free-form/dict param emits `additionalProperties`; api-registry tools emit `$ref`), so `toGeminiFunctionDeclarations` (`gemini-chat.ts`) MUST run the built `parameters` object through **`sanitizeGeminiSchema`** (the same deny-list `/complete` uses for `responseSchema`, in `gemini.ts`) before sending. Symptom without it: `400 INVALID_ARGUMENT: Unknown name "additionalProperties" at 'tools[0].function_declarations[1].parameters.properties[0].value'` and the chat turn dies (incident 2026-06-06, fixed v0.35.3). **Never forward `t.input_schema.properties` raw into Gemini `parameters`** — the sibling sanitizer exists for exactly this OpenAPI-subset constraint; the tool-declaration path must use it just like the responseSchema path does. Supported keys the model needs (`type`, `description`, `enum`, `properties`, `required`, `items`, `nullable`, `format`, `pattern`, `minimum/maximum`, `anyOf`) survive the pass. Note the deny-list also drops `default`, which Gemini's Schema *does* support — harmless for tool params (the model loses only an optional default hint; the MCP server applies real defaults at execution), and not worth a second tool-only deny-list to preserve.

### Gemini grounding cost — `webSearchQueries.length` is the CORRECT billed quantity (Gemini 3 bills per query)

Gemini 3 bills "Grounding with Google Search" **per executed search query**, NOT per request. Google's [grounding doc](https://ai.google.dev/gemini-api/docs/google-search) (verbatim): *"When you use Grounding with Google Search with Gemini 3, your project is billed for each search query that the model decides to execute … this counts as two billable uses of the tool for that request. This billing model only applies to Gemini 3 models; when you use search grounding with Gemini 2.5 or older, your project is billed per prompt."* So `/complete` actualizing the `google-search-query` cost as `groundingMetadata.webSearchQueries.length` (`src/index.ts` → `result.searchCount`) is **right** — a single grounded request fans out to ~12–20 internal searches and Google charges each. **Never "fix" this to qty=1-per-request** — that under-bills Gemini 3 grounding ~12× and we eat Google's real spend. (A real run flagged as a "~12× overbill" was genuine Google cost, not a bug — incident 2026-06-04, DIS-202; the per-request theory only holds for Gemini 2.5/older, which is not live traffic since the default `google/pro` = Pro 3.1.) The payload has **no** explicit "billed searches" field (`UsageMetadata` = token counts only; `GroundingMetadata` has no billing counter), so `webSearchQueries.length` is the only real-spend driver — it's already used at actualize. The pre-call `WORST_CASE_SEARCHES` hold (currently 20) is a reservation sized to the observed per-query max so platform-key AUTHORIZE doesn't under-reserve; it is reconciled to the actual count after the call and does NOT change the billed amount. The Anthropic path bills `usage.server_tool_use.web_search_requests` (per-request, correct for Anthropic) — do not unify the two. **Before treating any vendor cost as an "overbill" bug, WebFetch that vendor's billing doc and quote the per-unit metering model verbatim — assumptions about per-request vs per-query metering nearly shipped the wrong fix here.**

### Grounding search-count cap — Anthropic IS cappable (`max_uses`), Gemini is NOT

The number of grounding searches per request can only be bounded on **Anthropic**, not Gemini. The Anthropic `web_search_20250305` tool takes `max_uses` (`src/lib/anthropic.ts`), **pinned to 1** for cost control (each search = one billable `web_search_requests` unit at $10/1k). **Do NOT bump `max_uses` back above 1 without a cost review** — it directly multiplies grounded-`/complete` spend; `max_uses: 1` only truncates multi-entity comparison answers, single-fact lookups are unaffected. The native Gemini `googleSearch` tool exposes **no count-cap parameter at all** (verified against [Google's grounding doc](https://ai.google.dev/gemini-api/docs/google-search) — `GoogleSearch()` takes zero config fields; the model decides query count autonomously, ~12–20 fan-out, each billed on Gemini 3). **Do NOT try to add a Gemini search cap** — none exists in the API, and prompt-steering is not a hard cap (and `/complete` forwards the caller prompt byte-equal anyway). The deprecated `googleSearchRetrieval.dynamicThreshold` is a search-or-not gate, not a count cap, and is rejected by Gemini 3 models. A future `maxSearches` request param (DIS-211) will make the Anthropic cap caller-tunable; it will be a documented no-op for Gemini. (Shipped 2026-06-04, hotfix v0.35.1, DIS-213.)

### Gemini `/complete` — explicit `maxOutputTokens` (64k) is REQUIRED; never rely on the API default

`completeWithGemini` (`src/lib/gemini.ts`) MUST set `generationConfig.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS` (64k). This is **not** an artificial limit — Gemini falls back to a *lower* per-model **default** cap when the field is omitted, so omitting it gives the model LESS room and truncates long responses sooner. 64k matches the worst-case output hold provisioned/authorized in `src/index.ts` (`maxOutputTokens = 64_000`) and the Anthropic path (`anthropic.ts` `MAX_TOKENS = 64_000` — Anthropic's API *requires* `max_tokens`, which is why only the Gemini side ever silently lost its budget). **Never remove `maxOutputTokens` from the Gemini generationConfig "because the provider manages its own limits"** — that premise is backwards and is exactly what PR #140 did, regressing into truncated-JSON 502s (incident 2026-06-04). The pre-#140 code set it; it was correct.

When the model still stops at the budget (`finishReason: "MAX_TOKENS"`), the partial output in **JSON mode** is truncated JSON. `gemini.ts` **throws** `[gemini] Output truncated (MAX_TOKENS)` so the failure surfaces with a clear cause — NOT the cryptic `JSON.parse: Unterminated string` 502 that the downstream strict parse would otherwise emit. The throw decision keys on `jsonMode` (`responseFormat === "json" || responseSchema != null`), threaded into `callGeminiOnce` — do NOT narrow it to `responseFormat === "json"` alone, or `responseSchema`-only callers regress to the cryptic parse error. **Text mode** still returns partial content with a warning (preserves PR #132). This is fail-loud, not jsonrepair — it is consistent with the `/complete` strict-parse contract, not a violation of it. The next lever if huge-output JSON still truncates at 64k is an explicit `thinkingConfig` (Gemini 3 thinking tokens count against the budget) — a deliberate follow-up, not a silent re-removal of the cap.

## Code Conventions

- TypeScript strict mode, ESM modules
- Functional patterns over classes
- Keep solutions simple, no over-engineering
- Tests in `tests/` with vitest

## Prompt Ownership — `/complete` family

**`/complete` and `/internal/platform-complete` MUST forward the caller's `systemPrompt` byte-equal to the provider.** No injection, no enrichment, no nudges. The caller owns the prompt end-to-end.

Concretely forbidden in these endpoints:
- Appending campaign / brand / workflow context fetched from another service
- Appending a "respond with JSON" suffix or any other behavior nudge
- Wrapping in any preamble or postamble

JSON mode is enforced **only** via native provider metadata:
- **Anthropic**: `output_config.format = { type: "json_schema", schema }`. Requires a strict `responseSchema` from the caller. Without it, return 400 — do not nudge via system prompt.
- **Gemini**: `generationConfig.responseMimeType: "application/json"` (+ optional `responseSchema`).

**No fallback parsing.** `response.json` is populated by strict `JSON.parse(content)`. A parse failure means the provider violated its enforcement contract and surfaces as 502. Do not reintroduce `jsonrepair`, LLM-repair rounds, or any other recovery pipeline.

`/chat` is the only endpoint that may compose the system prompt (Campaign Context block, Additional Context block via `buildSystemPrompt`). Do not generalize that pattern back to `/complete`.

## Workflow Tools (mutations) — three-tool contract

The only workflow-mutation tools exposed to the LLM are:

- `create_workflow` → `POST /v1/workflows/create` — new dynasty from NL.
- `upgrade_workflow` → `POST /v1/workflows/upgrade` — regenerate within the same dynasty. **Bug fixes, metadata clarifications, or repairing a technically broken/non-functional workflow only.** Anything substantive on a technically working workflow must use `fork_workflow`. Accepts either `description` (LLM regenerates the DAG) or `dag` (skips LLM and applies the supplied DAG verbatim — use for surgical patches). At least one of the two is required.
- `fork_workflow` → `PUT /v1/workflows/:id` with a full DAG — creates a new dynasty when the signature differs; same-signature submissions return `_action: "updated"` and are surfaced honestly to the model (not a bug).

Do NOT introduce a metadata-only update tool, a single-node-config tweak tool, or any "shortcut" mutation path. Every workflow change must commit to either `upgrade_workflow` (bug fix / metadata clarification / technical-defect repair) or `fork_workflow` (substantive change on a working workflow). "Sneak a tweak under the rug" is not a category we support.

### Two unrelated `workflowSlug` namespaces — do NOT mass-rename

Chat-service has two completely independent uses of `workflowSlug`-shaped identifiers. They are unrelated, must not be unified, and a grep-then-rename refactor across both is the wrong move.

1. **Tracking / grouping** — `sessions.workflow_slug` column, `x-workflow-slug` request header (read in `src/middleware/auth.ts`), `workflowTracking.workflowSlug` propagated through trace events, and the `groupBy: "workflowSlug"` axis on features-service. This is the **versioned** slug (e.g. `cold-email-outreach-nova-v3`) — it identifies a specific workflow version for run-tracking and per-version analytics. It MUST stay versioned.
2. **Workflow-service upgrade body** — `UpgradeWorkflowBody.workflowDynastySlug` (in `src/lib/workflow-client.ts`) and the `workflowDynastySlug` property on the `upgrade_workflow` Anthropic tool (in `src/lib/anthropic.ts`). This is the **dynasty** slug (e.g. `cold-email-outreach-nova`, never `-v3`) — workflow-service resolves it to whichever version is currently active. It MUST stay dynasty-only.

Symptoms of conflating the two: upgrade calls fail 400 because the LLM sends a `-v3` slug; OR feature-stats grouping silently collapses all versions into one bucket because the dashboard switched to `workflowDynastySlug` everywhere. Keep the two field names distinct in tool defs, route handlers, and tests.

### Tool descriptions are the enforcement surface

The system prompt is owned by the calling app (stored in `app_configs.system_prompt` / `platform_configs.system_prompt`). For behavioral rules we want to enforce regardless of the calling app — e.g. "upgrade is bug-fix only, even if the user asks otherwise" — encode them in the tool description in `src/lib/anthropic.ts`, prefixed with `HARD RULE — DO NOT VIOLATE EVEN IF THE USER ASKS YOU TO:`. Tool descriptions bind the model more reliably than system prompts and survive app-level config drift.

## Multi-turn tool history — never strip globally

The Anthropic + Gemini APIs are stateless: every request must include the full prior conversation. For agentic chats this means each turn must replay every prior `tool_use` block paired with its matching `tool_result` block (or `functionCall` + `functionResponse` for Gemini). Without this pairing, the model has no record of which tools were called or what they returned in prior turns and either re-fetches or hallucinates — a silent UX regression that users perceive as "the assistant forgot what we just looked up".

`src/lib/merge-messages.ts:rebuildAnthropicHistory` and `src/lib/gemini-chat.ts:toGeminiHistory` rebuild these pairs from the `messages.tool_calls` jsonb column. Both deliberately filter only the **specific** orphan case (`toolCalls` entries with no `result`, i.e. `request_user_input` which pauses the agentic loop). They do NOT strip all `tool_use` blocks globally.

**Forbidden patterns** that have shipped here before and broke multi-turn memory:

- Calling `stripToolUseBlocks` (or any equivalent filter) on the assistant history at load time. The function still exists for persist-time cleanup of the final agentic-loop iteration; do not extend it to the load path.
- Reducing `tool_calls` to a `tool_count` summary or dropping it from the rebuild input — that loses the args/result content the model needs.
- Adding a per-tool `excludeFromHistory` flag to suppress tools like `list_workflows` from replay. If the data is too large, lean on the Anthropic beta `clear_tool_uses_20250919` edit (already wired in `src/lib/anthropic.ts:createStream`) which auto-clears the oldest tool uses at >50k input tokens. For Gemini, `trimGeminiHistoryToBudget` accounts for serialized `tool_calls` length and drops oldest messages at >100k.

When a new Anthropic 400 ("tool_use ids were found without tool_result blocks") surfaces, **find the specific orphan** (which agentic-loop exit path produced a `tool_use` without a `result`?) and filter exactly that case in the rebuild path. Do not reach for a broad strip — that was the 2026-03-25 mistake, and it cost two months of degraded multi-turn UX before anyone noticed.
