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

The default LLM for `/chat` is **Gemini `google`/`pro`**, resolved in code by `resolveChatProviderModel` (`src/lib/config-defaults.ts`). A config row (`app_configs` / `platform_configs`) with `provider`/`model` NULL resolves to `google`/`pro` — **NOT** `anthropic`/`sonnet`. The Anthropic platform key has no credit balance; defaulting to it 400s every chat that uses a default config.

Do NOT "fix" a provider switch by flipping the DB `provider`/`model` columns alone. That reverts: apps re-register their config at every cold start via `PUT /config` / `PUT /platform-config`, and the registration **must not clobber an omitted field**. Both handlers build their `onConflictDoUpdate.set` via `buildConfigConflictSet`, which includes `provider`/`model` ONLY when the caller actually supplied them — an omitted field keeps the stored value. **Never reintroduce `provider: provider ?? null` (or `model ?? null`) into the conflict `set`** — that resets every explicit override to NULL on the next app boot, which is exactly the bug that silently put all chat back on the dead Anthropic key (incident 2026-06-01, fixed v0.32.1). The `?? null` belongs only in the INSERT `.values` (a brand-new row legitimately starts NULL, then resolves to the Gemini default).

## Gemini `/chat` streaming — SSE framing must stay tolerant

`/chat` on `provider:"google"` streams via `gemini-chat.ts:streamGeminiChat`. Gemini's `:streamGenerateContent?alt=sse` stream frames events with **any of `\n\n`, `\r\r`, `\r\n\r\n`** and may emit `data:` with or without a trailing space — exactly what Google's official `@google/genai` SDK handles (`processStreamResponse`: `delimiters = ['\n\n', '\r\r', '\r\n\r\n']`, prefix `data:`). `parseGeminiSSEBuffer` mirrors this. **Never narrow it back to `indexOf("\n\n")` or `startsWith("data: ")`** — the real stream uses `\r\n\r\n`, so an `\n\n`-only parser yields ZERO events and an empty chat response with HTTP 200 and no error (incident 2026-06-01, fixed v0.32.2; the bug hid for the whole Anthropic-only period because the streaming parser had no test coverage). The Gemini stream path must also **fail loud**, not return `""`: throw on an in-band `{"error":...}` chunk and on a wholly-empty stream (no content, tool calls, or usage). When touching any provider's streaming parser, confirm the wire framing against that provider's official SDK source, not an assumption.

### Gemini 3 thought signatures — required on tool-call replay

Gemini 3 enforces [thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures): a `functionCall` part returned by the model carries an opaque `thoughtSignature` that **must be echoed back in the same part on every later request**, or the API returns `400 INVALID_ARGUMENT: Function call ... is missing a thought_signature`. (Gemini 2.5 only warns; Gemini 3 hard-400s.) `gemini-chat.ts` captures `part.thoughtSignature` from the stream, persists it on `ToolCallRecord.thoughtSignature` (jsonb), and re-attaches it on replay (`toGeminiHistory`) and in the agentic loop's `modelParts`. For tool calls recorded before the field existed (no stored signature), it injects Google's sanctioned bypass value **`skip_thought_signature_validator`**. **Never drop `thoughtSignature` from a replayed `functionCall` part** — every functionCall sent in history must carry one (real or the dummy), or multi-turn tool chats 400 on the second turn (incident 2026-06-01, fixed v0.32.3).

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
