# Chat Service

Multi-org AI chat service. Streams Claude Sonnet 4.6 responses via SSE with configurable system prompts and built-in workflow tools.

## Quick Start

```bash
cp .env.example .env   # fill in your keys
npm install
npm run dev            # starts on port 3002
```

## Authentication

All endpoints (except `/health` and `/openapi.json`) require these headers:

| Header | Description |
|---|---|
| `x-api-key` | Service-to-service API key |
| `x-org-id` | Internal org UUID from client-service |
| `x-user-id` | Internal user UUID from client-service |
| `x-run-id` | Caller's run ID — used as `parentRunId` when creating this service's own run in runs-service |
| `x-campaign-id` | _(optional)_ Campaign ID — injected automatically by workflow-service |
| `x-brand-id` | _(optional)_ Brand ID(s) — injected automatically by workflow-service. May be a single UUID or a comma-separated list of UUIDs for multi-brand campaigns (e.g. `uuid1,uuid2,uuid3`). |
| `x-workflow-slug` | _(optional)_ Workflow slug — injected automatically by workflow-service |
| `x-feature-slug` | _(optional)_ Feature slug — propagated through the entire service chain |
| `x-audience-id` | _(optional)_ Priority audience ID for the campaign run — injected by campaign-service. Propagated through the chain and stamped on every runs-service run + cost (and the `sessions` row) for per-audience cost attribution. Absent outside the campaign flow. |

## App Config Registration

Before using `/chat`, register a config for each chat mode your app needs. Each config is identified by a `key` (e.g. `"workflow"`, `"feature"`, `"press-kit"`) and defines the system prompt + which tools the LLM can use.

`PUT /config`

**Example — workflow chat:**
```json
{
  "key": "workflow",
  "systemPrompt": "You are an AI assistant that helps users understand and modify their outreach workflows...",
  "allowedTools": [
    "request_user_input",
    "create_workflow",
    "upgrade_workflow",
    "fork_workflow",
    "validate_workflow",
    "get_workflow_details",
    "get_workflow_required_providers",
    "list_workflows",
    "get_prompt_template",
    "update_prompt_template",
    "list_services",
    "list_service_endpoints",
    "list_org_keys",
    "get_key_source",
    "list_key_sources",
    "check_provider_requirements"
  ]
}
```

**Example — feature chat:**
```json
{
  "key": "feature",
  "systemPrompt": "You are an AI assistant that helps users design and manage features...",
  "allowedTools": [
    "request_user_input",
    "create_feature",
    "update_feature",
    "list_features",
    "get_feature",
    "get_feature_inputs",
    "prefill_feature",
    "get_feature_stats"
  ]
}
```

**Example — campaign-prefill chat:**
```json
{
  "key": "campaign-prefill",
  "systemPrompt": "You help users create campaigns by pre-filling form fields based on their brand...",
  "allowedTools": [
    "update_campaign_fields",
    "extract_brand_fields"
  ]
}
```

Fields:
- `key` (required) — config identifier, unique per org. Clients pass this as `configKey` in `POST /chat`.
- `systemPrompt` (required) — the system prompt sent to the LLM for this chat mode
- `allowedTools` (required, min 1) — which tools the LLM can use. The service rejects any tool call not in this list. See [Available Tools](#available-tools) for the full list.
- `provider` (optional) — LLM provider: `"anthropic"` or `"google"`. Defaults to `"google"` when omitted (Gemini is the platform default for chat); a config row with a NULL `provider` resolves to `google`.
- `model` (optional) — Model alias (version-free). Must match the provider: anthropic → `haiku|sonnet|opus`, google → `flash-lite|flash|flash-pro|pro`. Defaults to `"sonnet"` for anthropic, `"flash-pro"` for google (so an all-NULL config resolves to `google`/`flash-pro`). The agentic `workflow` chat is pinned to `pro` via an explicit config row.

This endpoint is **idempotent** (upsert on `(orgId, key)`). Call it on every cold start. **`provider`/`model` are only overwritten when supplied** — omitting them on a re-registration leaves the stored values unchanged, so an app that registers without `provider` does not reset an explicit override back to NULL.

Response:
```json
{
  "orgId": "org-uuid",
  "key": "workflow",
  "systemPrompt": "...",
  "allowedTools": ["..."],
  "provider": "google",
  "model": "pro",
  "createdAt": "2026-02-26T00:00:00.000Z",
  "updatedAt": "2026-02-26T00:00:00.000Z"
}
```

## Platform Config Registration

Register a platform-wide config for a given key. Used as fallback when no per-org config exists for that key.

`PUT /platform-config`

**Auth:** `X-API-Key` only — no `x-org-id`, `x-user-id`, or `x-run-id` headers required.

```json
{
  "key": "workflow",
  "systemPrompt": "You are a helpful assistant...",
  "allowedTools": ["request_user_input", "get_workflow_details", "list_workflows"]
}
```

Fields: same as `PUT /config` — `key`, `systemPrompt`, `allowedTools` (all required), plus optional `provider`, `model`, and `thinkingLevel`.

**`thinkingLevel`** (optional, `"minimal" | "low" | "medium" | "high"`) — per-config Gemini-3 thinking level applied **only** on the `/chat` path. Omit to use the code default (`"low"`). Raise it (e.g. `"medium"`) to give a specific chat mode more reasoning. It is ignored for Anthropic configs and is **never** applied on `/complete` (higher thinking there burns the JSON output budget → truncation). Like `provider`/`model`, omitting `thinkingLevel` on a re-register **preserves** the stored value (never clobbers it back to null).

This endpoint is **idempotent** (upsert on `key`). Called on every cold start by api-service.

**Self-seeded configs.** Four platform configs are owned by chat-service itself and seeded at boot (in `src/lib/seed-platform-configs.ts`, run from the migrate→listen path) — they do not need any external registrar:

| configKey | Tools | Purpose |
|---|---|---|
| `persona-editor` | `list_personas`, `create_persona`, `duplicate_persona`, `set_persona_status`, `request_user_input` | Read + curate a brand's customer personas via NL (brand-service). |
| `brand-profile-editor` | `get_brand_profile`, `save_brand_profile_version`, `refresh_brand_profile_from_website`, `request_user_input` | Read, refresh from website, and version a brand's brand profile via NL. |
| `audience-editor` | `list_audiences`, `suggest_audiences`, `set_audience_status`, `rename_audience`, `refresh_audience_count`, `request_user_input` | Create + curate a brand's customer audiences via NL (human-service, via the api-service gateway `/v1/orgs/audiences/*`). Creation is suggest→activate: `suggest_audiences` persists candidates at status `suggested`; `set_audience_status … active` makes one live. Filters are immutable; archive (never delete) and rename only. |
| `whatsapp` | Full funnel (`create_brand_from_url`, `list_brands`, `launch_campaign`, `list_campaigns`, `stop_campaign`, `get_daily_budget`, `set_daily_budget`, `get_brand_pause`, `set_brand_pause`) + `browse_url` + feature/workflow reads + the brand-profile / audience / persona curation tools. | The public "Distribute.you" WhatsApp assistant — lets a user operate the WHOLE platform by chat, exactly like the dashboard: from a bare URL through brand setup, campaign launch, budget, and pause/resume, on top of the curation tools. A Twilio-based channel service (not chat-service) forwards each inbound WhatsApp message here, scoped to the sender's org/user (the account is provisioned by client-service before the message lands). The funnel tools take the brand/campaign id explicitly, so the assistant can go from nothing to a running campaign purely by chat. LLM cost stays in chat-service exactly as for dashboard chat (the WhatsApp org is billed for its own usage). |

All default to `google`/`flash-pro` and boot at `thinkingLevel: "medium"` (raised above the global `/chat` default of `"low"` for richer tool-calling reasoning). The dashboard selects the editor configs by `configKey` and passes `context: { brandId }`; the channel service selects `whatsapp` and forwards the sender's identity. The boot seed only upserts these keys, so it never clobbers a dashboard-registered config.

All four prompts share a **voice + ground-truth guardrail block** (`VOICE_AND_GROUND_TRUTH_RULES`, appended to each prompt in `seed-platform-configs.ts`): the assistant must never surface internal plumbing in user-facing prose (entity/provider ids, raw filter JSON or field names, tool names, tool errors / HTTP status / 404s, raw count fields — filters become plain language, counts a single rounded number); it may only state an action as done **after** the corresponding tool call returns success (no pre-announcing avatars/creation/activation); and it must reuse only ids returned verbatim by a prior tool result (never construct or guess one — re-list on a not-found). This exists because real sessions leaked UUIDs/`apolloAudienceId`/filter JSON into the prose and fabricated completion before the tools ran.

**Config resolution in POST /chat:**
1. Per-org config `(orgId, configKey)` → if found, use it
2. Platform config `(configKey)` → if found, use it
3. Neither found → **404**

There is no merging — it's one or the other.

Response:
```json
{
  "key": "workflow",
  "systemPrompt": "...",
  "allowedTools": ["..."],
  "createdAt": "2026-02-26T00:00:00.000Z",
  "updatedAt": "2026-02-26T00:00:00.000Z"
}
```

## Synchronous Completion

`POST /complete` — one-shot, non-streaming LLM call for service-to-service use.

Request body:
```json
{
  "message": "Given this brand context, generate 10 Google search queries...",
  "systemPrompt": "You are a PR research assistant...",
  "provider": "google",
  "model": "flash",
  "responseFormat": "json",
  "temperature": 0.3
}
```

**Vision example (image analysis):**
```json
{
  "message": "Analyze this image and score it on: is_logo, is_product, is_team_photo, is_professional (0-1 each)",
  "systemPrompt": "You are an image classification assistant. Return JSON with scores.",
  "provider": "google",
  "model": "flash-lite",
  "imageUrl": "https://example.com/images/hero.jpg",
  "imageContext": { "alt": "Company hero banner", "title": "About Us", "sourceUrl": "https://example.com/about" },
  "responseFormat": "json",
  "temperature": 0
}
```

- `message` (required) — the prompt to send to the LLM
- `systemPrompt` (required) — inline system prompt (no pre-registered config needed). Empty string is allowed: the provider receives no system prompt and falls back to its default behavior. The value is forwarded byte-equal to the provider.
- `provider` (required) — LLM provider: `"anthropic"`, `"google"`, `"deepseek"`, `"zai"`, or `"moonshot"` (see [Direct vendor models](#direct-vendor-models))
- `model` (required) — version-free model alias. The service resolves the current versioned model internally. Valid combinations:
  - **anthropic**: `haiku` (fast/cheap), `sonnet` (balanced), `opus` (highest quality)
  - **google**: `flash-lite` (cheapest, vision, Gemini 3.1 Flash-Lite), `flash` (Gemini 3.5 Flash-Lite), `flash-pro` (mid-tier default, Gemini 3.7 Flash), `pro` (most powerful, Gemini 3.1 Pro). All require a Google API key in key-service.
  - **deepseek**: `deepseek-flash` (DeepSeek V4 Flash — cheapest per unit of intelligence, 1M context), `deepseek-pro` (DeepSeek V4 Pro — the reasoning-heavy sibling)
  - **zai**: `glm-flash` (`glm-4.7-flashx` — fast and very cheap), `glm-pro` (`glm-5.3` — Z.ai's flagship)
  - **moonshot**: `kimi-flash` (`kimi-k2.6` — value tier), `kimi-pro` (`kimi-k3` — flagship, 1M context)

  The three direct-vendor providers are **text only**: `imageUrl` and `webSearch` are rejected with 400 on every one of their models. Each needs its OWN key in key-service, stored under its provider slug.
- `responseFormat` (optional) — set to `"json"` to enable JSON-mode parsing. **For `provider: "anthropic"`, you MUST also supply `responseSchema`** — Anthropic has no native standalone JSON mode, so the request is rejected with 400 if `responseSchema` is missing. For `provider: "google"` (Gemini), `responseFormat: "json"` alone is sufficient (native `responseMimeType` enforcement).
- `responseSchema` (optional) — JSON Schema enforced server-side by the provider's structured-output API. When set, JSON-mode parsing is implied (no need to also pass `responseFormat: "json"`). The schema is forwarded as:
  - **Google** → `generationConfig.responseSchema` (supported on all Gemini 2.5+ models: `pro`, `flash`, `flash-lite`). Gemini accepts only an OpenAPI 3.0 subset; chat-service auto-sanitizes the caller-supplied schema before forwarding by stripping unsupported JSON-Schema keywords (`additionalProperties`, `$schema`, `$ref`, `$defs`, `definitions`, `patternProperties`, `unevaluatedProperties`, `if`/`then`/`else`, `not`, `const`, `examples`, `default`, `exclusiveMinimum`/`exclusiveMaximum`, `multipleOf`, etc.). A `[chat-service] Gemini schema sanitized` warning is logged once per call when any field is removed.
  - **Anthropic** → `output_config.format = { type: "json_schema", schema }` (Claude 4.x). Anthropic's strict mode requires every `type: "object"` node to carry an explicit `additionalProperties: false`; a permissive schema is rejected with `400 ... 'additionalProperties' must be explicitly set to false`. chat-service auto-normalizes the caller-supplied schema before forwarding by stamping `additionalProperties: false` onto every object node that omits it (recursing through `properties`, `items`, `anyOf`/`allOf`/`oneOf`, `$defs`/`definitions`; an explicit value the caller set is preserved). This is the mirror of the Gemini sanitizer above (which *strips* the key). Callers no longer need to add `additionalProperties` themselves.
- `temperature` (optional) — sampling temperature, 0–2 (default: model default)
- `maxTokens` (optional, 1–64000) — output-token budget for this call. When set, it caps the provider generation (Anthropic `max_tokens` / Gemini `maxOutputTokens`, bounded to 64000) **and** sizes the pre-call cost reservation exactly to this budget. When omitted, the provider keeps the full 64000 budget (so long outputs are never truncated) and the service reserves a **right-sized estimate** instead of the flat model max — see [Cost declaration](#cost-declaration). Declare it when you know your output is small (scoring, short JSON, suggestion lists), especially from a high-fan-out caller, to keep concurrent reservations from over-holding against your org balance.
- `webSearch` (optional, default `false`) — opt-in native web search. When `true`, the resolved provider answers using its **own** native web search so the response reflects live web content instead of the model's parametric memory:
  - **Google** → `googleSearch` grounding tool. The number of search queries is read from `groundingMetadata.webSearchQueries`; source URLs from `groundingMetadata.groundingChunks[].web`. **Not count-cappable**: the native `googleSearch` tool exposes no `max_uses`-style knob, so the model autonomously decides how many queries to run (Gemini 3 bills each — see Cost). There is no API parameter to bound it.
  - **Anthropic** → server-side `web_search_20250305` tool (`max_uses: 1`). Capped to **1** search per request for cost control (each search is one billable `web_search_requests` unit at $10/1k); single-fact lookups are unaffected, multi-entity comparison answers lose breadth. The search count is read from `usage.server_tool_use.web_search_requests`; source URLs from citation + result blocks.
  - In **text mode**, deduped citation source URLs are appended to `content` as a trailing `Sources:` block, so they surface in the response text. In **JSON mode** (`responseFormat: "json"` / `responseSchema`) the content is left untouched (a Sources block would corrupt the JSON), but grounding still applies and the search cost is still declared.
  - Omitted or `false` → no grounding, byte-identical to a non-grounded call (no extra cost). The web-search cost is metered per query/search and billed in addition to tokens — see the **Cost** section below.
- `disableThinking` (optional, default `false`) — minimize the model's internal reasoning ("thinking") so the whole output budget goes to the answer. Use for extraction / structured-JSON / scoring tasks that don't need chain-of-thought. **Provider-floored, NOT a guaranteed full-off** (same pattern as a per-provider cap):
  - **Google, Gemini 2.5** (`gemini-2.5-*`) → `thinkingConfig.thinkingBudget: 0` — thinking fully OFF.
  - **Google, Gemini 3** (`gemini-3.*`) → drops to the lowest level **that model** accepts. **Gemini 3 has no full-off** ([thinking docs](https://ai.google.dev/gemini-api/docs/thinking)), so this is "minimize", not zero — and the floor is **per model, not per generation**: Google publishes the accepted levels model by model and they differ inside one generation. Current aliases (floors read from the thinking docs on 2026-08-24 and confirmed against the live API the same day):

    | alias | model | accepted levels | `disableThinking` sends |
    |---|---|---|---|
    | `flash-lite` | `gemini-3.1-flash-lite` | minimal, low, medium, high | `minimal` |
    | `flash` | `gemini-3.5-flash-lite` | minimal, low, medium, high | `minimal` |
    | `flash-pro` | `gemini-3.7-flash` | **low**, medium, high | `low` |
    | `pro` | `gemini-3.1-pro-preview` | **low**, medium, high | `low` |

    A model with no recorded floor **throws** rather than resolving to a guessed one — so upgrading an alias to a model whose floor was never checked fails a unit test, not production. (Sending `minimal` to a model that rejects it returns `400 INVALID_ARGUMENT: Thinking level MINIMAL is not supported for this model` — that is exactly what a generation-plus-substring floor did to `flash-pro` between 2026-08-14 and 2026-08-24.)
  - **Anthropic** → no-op: `/complete` never enables extended thinking, so the field is accepted and ignored.
  - Omitted or `false` → the service default (bounded thinking: `thinkingLevel: "low"` on Gemini 3, `thinkingBudget: 8192` on Gemini 2.5), byte-identical to a normal call.
- `thinkingLevel` (optional, `"minimal" | "low" | "medium" | "high"`) — per-call Gemini-3 thinking level, the same graduated levels the `/chat` config path supports. Lets a caller dial reasoning effort **without changing the model** (e.g. an extraction task that wants `"low"` — cheaper/faster than default but above the floor). Precedence: **`disableThinking` (when set) always wins → the model's floor, ignoring this field.** Otherwise the model generates at this level — and an explicit level **below** that model's floor is rejected with a clear 5xx naming the lowest accepted level, never silently swapped for a different one (use `disableThinking` to ask for the floor). **Omitted → the service default (`"low"`), byte-identical to a normal call — existing callers see ZERO change.** Applies only to Gemini 3; a safe **no-op** on Gemini 2.5 (uses its bounded `thinkingBudget: 8192`) and Anthropic (thinking is never enabled on `/complete`). A caller that opts up to `medium`/`high` owns the tradeoff — higher thinking can consume the output budget on large JSON outputs (`MAX_TOKENS`), so size `maxTokens`/your schema accordingly.
- `imageUrl` (optional) — URL of an image to include as visual input. The image is fetched server-side. Supported by all models, but recommended with `google` + `flash-lite` for cost-effective vision tasks.
- `imageContext` (optional) — metadata about the image to help the model classify it: `{ alt?: string, title?: string, sourceUrl?: string }`. Injected into the prompt alongside the image. Only meaningful when `imageUrl` is provided.

**Example with `responseSchema` (Anthropic — `additionalProperties: false` shown explicitly, but auto-stamped if omitted):**
```json
{
  "message": "Score this image on is_logo, is_product (0-1 each).",
  "systemPrompt": "You are an image classifier.",
  "provider": "anthropic",
  "model": "sonnet",
  "responseSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "is_logo": { "type": "number" },
      "is_product": { "type": "number" }
    },
    "required": ["is_logo", "is_product"]
  }
}
```

Response:
```json
{
  "content": "...",
  "json": { "queries": ["..."] },
  "tokensInput": 450,
  "tokensOutput": 800,
  "model": "claude-sonnet-4-6"
}
```

- `content` — raw text response (always present).
- `json` — parsed JSON object (present when `responseFormat: "json"` or when `responseSchema` is set). Populated by a strict `JSON.parse(content)` fast path, with a **first-complete-value recovery** for two provider quirks: a value wrapped in a markdown ```` ``` ```` fence, or a complete value followed by trailing prose (Gemini 3 thinking models leak trailing content despite JSON-mode metadata). Recovery is a balanced, string-aware scan only — no jsonrepair, no LLM-assisted repair. Genuinely broken output (empty, leading non-fence prose, truncated/unbalanced JSON) still returns **502**.
- `tokensInput` / `tokensOutput` — token usage
- `model` — the versioned model ID that was actually used (resolved from the provider + alias)

Unlike POST /chat, this endpoint is **stateless** (no sessions), accepts an **inline systemPrompt**, and returns **JSON** instead of SSE. Run tracking and billing work identically to POST /chat.

Error responses: 400 (validation), 401 (auth), 402 (insufficient credits), 502 (upstream failure).

## Direct vendor models

A third provider path alongside the two native clients. Where `anthropic.ts` and `gemini.ts` each speak a vendor-specific dialect and carry that vendor's accumulated quirks, `src/lib/openai-compatible.ts` speaks one generic dialect — OpenAI Chat Completions — against vendors that all serve it. **One adapter, three vendors, six models.**

The vendors differ in exactly four things, and all four are *data* in the `VENDORS` registry rather than code: the base URL, the key-service provider slug, where the usage payload reports cached prompt tokens, and **which price dimensions that vendor's catalog actually carries** (`pricing`). So adding a seventh model is a `MODEL_MAP` entry, and adding a fourth vendor is a `VENDORS` entry. Neither is a new client.

| Provider | Alias | Vendor model id | Cost prefix | Priced dimensions | Base URL |
|---|---|---|---|---|---|
| `deepseek` | `deepseek-flash` | `deepseek-v4-flash` | `deepseek-v4-flash` | cache + regime | `https://api.deepseek.com/v1` |
| `deepseek` | `deepseek-pro` | `deepseek-v4-pro` | `deepseek-v4-pro` | cache + regime | `https://api.deepseek.com/v1` |
| `zai` | `glm-flash` | `glm-4.7-flashx` | `zai-glm-4.7-flashx` | cache | `https://api.z.ai/api/paas/v4` |
| `zai` | `glm-pro` | `glm-5.3` | `zai-glm-5.3` | cache | `https://api.z.ai/api/paas/v4` |
| `moonshot` | `kimi-flash` | `kimi-k2.6` | `moonshot-kimi-k2.6` | none seeded → 502 | `https://api.moonshot.ai/v1` |
| `moonshot` | `kimi-pro` | `kimi-k3` | `moonshot-kimi-k3` | none seeded → 502 | `https://api.moonshot.ai/v1` |

Aliases follow one pattern: `<family>-flash` is the cheap tier, `<family>-pro` the strong one. The cost prefix follows the costs-service catalog's own shape: the vendor's model id, prefixed with the vendor slug unless the id already names the vendor (`deepseek-v4-flash` stays bare; `glm-5.3` becomes `zai-glm-5.3`). These strings are byte-equal to the catalog rows — a prefix the catalog does not carry is 422-rejected at declaration. Aliases are version-free — we send the undated id and let the vendor resolve the current build (a dated echo like `deepseek-v4-pro-0813` is accepted; a different model is not). `glm-pro` pointed at `glm-5.2` until 2026-08-20; Z.ai publishes GLM-5.3 as a drop-in swap at an identical list price, so the alias moved and callers saw no contract change.

**Scope.** `/complete` and `/internal/platform-complete` only, non-streaming, text in / text out. Not wired: `/chat` (agentic tool-calling is unproven on these models and must be measured first), web search, image input, image generation, embeddings. `webSearch` or `imageUrl` on any of these providers returns **400** naming the vendor, rather than silently answering ungrounded or blind.

**Opt-in.** No existing caller reaches these implicitly. `/chat` config defaults are untouched (`google`/`flash-pro`), and a caller must name the provider explicitly.

```json
{
  "message": "Extract the company's industry and HQ country from this page.",
  "systemPrompt": "You are an extraction assistant. Return JSON only.",
  "provider": "zai",
  "model": "glm-pro",
  "responseFormat": "json",
  "temperature": 0
}
```

### Model breadth is not catalog breadth

Each vendor serves a large catalog; chat-service reaches exactly the aliases declared in `MODEL_MAP`, and `resolveModel` throws on anything else with the accepted set in the message. Every alias costs a set of costs-service catalog rows — three per alias for a vendor with no time-of-day schedule (`<costPrefix>-tokens-{input,cached-input,output}`), six for one with a peak/off-peak schedule — which must exist in **production** before the alias is called, or runs-service 422s the cost declaration and the call fails loud. A model is unreachable until someone adds it to both places deliberately.

### Cache-hit pricing

All three vendors price a cached input token far below a fresh one, and our dominant workload is a large stable prompt with a small per-item block — so **cache hits are the normal case, not the exception**. Billing the whole prompt at the miss rate would overstate real spend on most calls, so the declaration splits it:

- `<prefix>[-<regime>]-tokens-input` ← `prompt_tokens − cached`, the fresh tokens at the miss rate
- `<prefix>[-<regime>]-tokens-cached-input` ← the cached tokens, at the vendor's cache rate
- `<prefix>[-<regime>]-tokens-output` ← unchanged

The split is exhaustive (the two input quantities always sum to `prompt_tokens`) and the cached row is omitted entirely when the count is zero. The response's `tokensInput` still reports the **total** prompt count — only billing is split.

Each vendor reports the count in a different place, which is the entire reason `readCachedTokens` is per-vendor data:

| Vendor | Field | Cache-hit vs miss (per 1M input) |
|---|---|---|
| DeepSeek | `usage.prompt_cache_hit_tokens` | $0.014 vs $0.44 (V4 Flash, peak) — 31x |
| Z.ai | `usage.prompt_tokens_details.cached_tokens` | $0.26 vs $1.40 (`glm-5.3`) |
| Moonshot | `usage.cached_tokens` | $0.30 vs $3.00 (`kimi-k3`) |

A cached count larger than the prompt total is clamped: a negative fresh-token quantity would make runs-service reject the whole declaration and fail a call that actually succeeded.

### Time-of-day pricing (DeepSeek only)

DeepSeek charges **peak** rates during 01:00–04:00 and 06:00–10:00 UTC and **off-peak** rates at every other hour, so costs-service carries one row per regime and the regime is part of the cost name:

```
deepseek-v4-{flash,pro}-{peak,off-peak}-tokens-{input,cached-input,output}
```

`buildLlmCostNames` (`src/lib/cost-names.ts`) selects the regime from the **UTC clock at declaration**, never from the date: costs-service gave both regimes an identical price point before the schedule takes effect (2026-08-16T16:00Z) and effective-dated the new rates, so the catalog resolves the right price for when the cost was written. Each window is half-open `[start, end)` — 01:00:00 is the first peak minute, 04:00:00 the first off-peak minute again — so at every instant exactly one name matches and no regime-free fallback is needed.

**One timestamp per request.** The pre-call hold and the post-call actual are built from the same `Date`, so a call that straddles a boundary cannot hold against peak and bill against off-peak.

The four regime-free names (`deepseek-v4-{flash,pro}-tokens-{input,output}`) are **superseded and frozen** in the catalog: they still resolve, which is exactly why they must not be declared — they carry the pre-schedule flat rate and would silently under-bill peak traffic. Z.ai publishes no schedule, so its names carry no regime segment; inventing one would name a row that does not exist.

### No routing knobs, no fallback, and the model is asserted

The request body deliberately carries **no** `models` fallback array, **no** `sort`, and **no** provider `order`/`only`. A request that silently resolved to a different model than the alias we priced would declare the wrong cost name. `assertModelMatches` closes the loop: if the response's `model` is not the requested one (or a dated build of it), the call throws rather than billing under a catalog name that no longer describes the spend.

There is likewise **no cross-vendor fallback**. A vendor being down fails loud: substituting another model would hand the caller an answer from a model it did not choose and bill it under a name that does not describe what ran.

### JSON mode is best-effort here

`responseSchema` is forwarded as native `response_format: { type: "json_schema", ... }`, but enforcement strength varies by vendor and model, so the request may reach a model that treats it as a hint. This is not a silent fallback: `parseModelJsonOutput` still fails loud (502) on output it cannot read. It is also precisely what a bake-off has to measure before any existing caller is migrated onto one of these models.

### Retry behaviour

Only **connect-phase** failures are retried (a thrown fetch rejection whose cause is a transient socket code — `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, …), with 250/500/1000 ms backoff. A completed HTTP response — including a 5xx — is a real answer from the vendor and may already have been billed upstream, so it is never replayed. This is intentionally stricter than `gemini.ts`, which retries 429/5xx status codes.

### Operational prerequisites

1. **One key per vendor** in key-service, stored under that vendor's slug: `deepseek`, `zai`, `moonshot`. Org-scoped calls read `GET /keys/{provider}/decrypt`; `/internal/platform-complete` reads `GET /keys/platform/{provider}/decrypt`. A missing key returns **502** naming the vendor and the slug it must live under — not a generic failure — so "which of the three is unconfigured" is answered by the error itself.
2. The catalog rows for the alias live in production costs-service. As of 2026-08-16 every reachable model is priced: the twelve regime-and-cache DeepSeek rows, and three rows per model (`-tokens-{input,cached-input,output}`) for both Z.ai and Moonshot. An alias added ahead of its rows still returns **502** naming the three rows someone must seed (`missingCostNames` in the body), before any key fetch, run or vendor call — a wrong price is silent, a missing one is not. Seed them in costs-service `src/db/seed.ts` (`SEED_PROVIDERS_COSTS`) and deploy to production to lift it.

### Out-of-credit alerting

Each of the three vendors holds its own prepaid balance, and two of them have no auto-reload. When a balance runs dry the vendor refuses every call and the whole model tier stops answering, so **chat-service emails the platform owner, naming the vendor**.

The alert changes nothing about the failure. There is no fallback vendor, no fallback model, no retry: the call fails exactly as it did before, with the same error and the same status. The email is a notification alongside the failure, never a recovery.

**Only out-of-credit alerts.** A rate limit, an auth failure, a bad request and an unknown model all send nothing. That distinction cannot be made from the status code — two of the three vendors answer an empty balance with the same `429` they use for a rate limit — so the classification reads what the vendor actually said, and each vendor states its own signal as data in the `VENDORS` registry (`src/lib/openai-compatible.ts`):

| Vendor | Out-of-credit signal | Its rate limit, for contrast |
| --- | --- | --- |
| DeepSeek | HTTP **402**, "Insufficient Balance … you have run out of balance" ([error codes](https://api-docs.deepseek.com/quick_start/error_codes)) | HTTP 429, "Rate Limit Reached" |
| Z.ai | HTTP 429 with body code **`1113`**, "Insufficient balance or no resource package. Please recharge." | HTTP 429, a different code |
| Moonshot | HTTP 429 with error type **`exceeded_current_quota_error`**, "… is suspended due to insufficient balance, please recharge" | HTTP 429, `rate_limit_reached_error` |

A shared prose fallback (`insufficient balance` / `run out of balance` / `no resource package`) catches a vendor that rewords its body without changing its code. Adding a fourth vendor means adding its `isOutOfCreditRefusal` predicate to its `VENDORS` entry — the test table in `tests/unit/vendor-credit-alert.test.ts` fails until it is there.

**One email per outage, not per call.** A campaign drives many calls a minute, so the alert latches per vendor: the first out-of-credit refusal sends, every later one is silent, and the latch is released the moment that vendor serves a completion again. The latch is **in-process**, which has one consequence worth stating plainly: a restart during an outage re-arms it, so the next refused call sends one more email (and each running instance sends at most one). The balance does not refill because the process restarted — a duplicate alert during an outage is a much smaller problem than a missed one, and this keeps a write off the failure path.

**Sending never blocks the request.** The email is dispatched fire-and-forget; the failing call does not wait on it. A send that fails is logged and dropped, and leaves the latch set — retrying an email once per refused call while the email path is down is the same flood by another route.

The email goes through the fleet's transactional path (`transactional-email-service`). chat-service **owns** the `vendor_out_of_credit` template — a template name has exactly one owner, the service that sends it — and registers it at boot via `PUT /templates` under `appId: "chat-service"` (idempotent upsert, never throws, not awaited before `listen()`). No other service should carry a copy. Requires `TRANSACTIONAL_EMAIL_SERVICE_URL`, `TRANSACTIONAL_EMAIL_SERVICE_API_KEY` and `PLATFORM_OWNER_EMAIL`; with any of them unset the alert logs and does not send.

### Replacing the Vercel AI Gateway

These six models replaced a single gateway path (removed 2026-08-15). The gateway resold the same DeepSeek models above their vendor list price (1.4x on V4 Flash, 4x on V4 Pro), charged a payment-processing fee on every top-up, and gated recent models behind a paid tier. It is removed, not deprecated: there is no fallback to it, and `provider: "vercel"` is rejected with the accepted provider set.

`deepseek-flash` and `deepseek-pro` are **unchanged for callers** — same alias, same request shape (the cost prefix now carries a regime segment, which is internal to the declaration). What moved is the transport underneath, so one externally visible detail changed with it: the response's `model` field now echoes the vendor's own id (`deepseek-v4-flash`) rather than the gateway's namespaced form (`deepseek/deepseek-v4-flash`).

## Internal Platform Completion

`POST /internal/platform-complete` — platform-level LLM completion for internal service-to-service calls.

**Auth:** `X-API-Key` only — no `x-org-id`, `x-user-id`, or `x-run-id` headers required.

```json
{
  "message": "Analyze this workflow definition and suggest field mappings.",
  "systemPrompt": "You are a workflow analysis assistant.",
  "provider": "anthropic",
  "model": "sonnet",
  "responseFormat": "json",
  "temperature": 0.3
}
```

Same fields as `POST /complete` (including the optional `responseSchema`, `webSearch`, `disableThinking`, and `thinkingLevel`) except **no `imageUrl` or `imageContext`** support.

**Key differences from `POST /complete`:**
- **No org billing** — platform-level calls are not charged to any org's credit balance (no affordability authorize).
- **Platform run tracking + cost** — a **platform run** is created in runs-service (`POST /v1/platform-runs`, `x-service-name: chat-service`, `taskName: platform-complete`) and the LLM (and web-search) spend is declared on it as `actual` costs (`costSource: platform`). Platform runs have no cost-status PATCH, so costs are posted post-call as `actual` (no provision/cancel). Fail-loud: if the platform run can't be created or its cost can't be declared, the call returns **502** rather than spending silently.
- **No campaign context** — no `x-campaign-id` enrichment.
- **Platform key resolution** — uses `GET /keys/platform/{provider}/decrypt` directly (no org-level key lookup).

Use this endpoint when a service needs an LLM call during startup or for platform-level operations that don't belong to a specific org or user (e.g. workflow upgrades, schema analysis).

Response format is identical to `POST /complete`.

Error responses: 400 (validation), 401 (auth), 502 (upstream failure).

## Internal Platform Image Generation

`POST /internal/platform-images/generate` — platform-level Gemini image generation for internal service-to-service calls. Platform (no-org) twin of the org-scoped `POST /orgs/images/generate`.

**Auth:** `X-API-Key` only — no `x-org-id`, `x-user-id`, or `x-run-id` headers required.

```json
{
  "prompt": "Generate a square PNG avatar portrait for a B2B SaaS buyer persona: confident marketing leader, clean studio lighting, no text.",
  "size": "small"
}
```

- `prompt` — image-generation prompt.
- `size` (optional) — `small` (default, 512px), `medium` (1K), `large` (2K), or `xlarge` (4K). Chat-service maps this to Gemini `generationConfig.imageConfig.imageSize`.
- Output-token cost is provisioned/declared from Gemini's documented image budget by size: `small` 747, `medium` 1120, `large` 1120, `xlarge` 2000. If Gemini returns usage metadata, the actual provider value is used.

Response:

```json
{
  "url": "https://cdn.distribute.you/images/audience-avatar.png",
  "mimeType": "image/png",
  "model": "gemini-3.1-flash-image",
  "tokensInput": 120,
  "tokensOutput": 747
}
```

**Key differences from `POST /orgs/images/generate`:**
- **No org billing** — platform-level calls are not charged to any org's credit balance (no affordability authorize).
- **Platform run tracking + cost** — a **platform run** is created in runs-service (`POST /v1/platform-runs`, `x-service-name: chat-service`, `taskName: generate-image`) and image-generation token spend is declared on it as `actual` costs (`costSource: platform`, byte-equal to the org route's catalog rows). Platform runs have no cost-status PATCH, so costs are posted post-call as `actual` (no provision/cancel). Fail-loud: if the platform run can't be created or its cost can't be declared, the call returns **502** rather than spending silently.
- **Platform key resolution** — uses `GET /keys/platform/google/decrypt` directly (no org-level key lookup).

Use this endpoint when platform tooling or agents calling through the api-registry MCP (which injects only service-auth headers and strips org id) need to generate an image with no org context.

Error responses: 400 (validation), 401 (auth), 502 (upstream failure).

## Internal: Transfer Brand

`POST /internal/transfer-brand` — re-assigns solo-brand sessions from one org to another.

**Auth:** `X-API-Key` only — no org context needed (org IDs come from the body).

```json
{
  "sourceBrandId": "brand-aaa-uuid",
  "sourceOrgId": "org-source-uuid",
  "targetOrgId": "org-target-uuid",
  "targetBrandId": "brand-bbb-uuid"  // optional — when present, rewrites brand reference
}
```

Updates all sessions where `org_id = sourceOrgId` AND `brand_ids` contains exactly one element matching `sourceBrandId`. When `targetBrandId` is provided (conflict case — target org already has a brand for this domain), brand references are rewritten to `targetBrandId`. Sessions with multiple brand IDs (co-branding) are skipped.

Response:
```json
{
  "updatedTables": [{ "tableName": "sessions", "count": 5 }]
}
```

Idempotent — running it twice with the same params is a no-op (all rows already updated).

## RAG Score (`/orgs/rag/score`)

`POST /orgs/rag/score` — score a batch of documents against a brand profile using semantic similarity.

Used by **journalists-quotes-service** to rank quote requests against a brand for outreach, and by any other consumer that needs cheap document-vs-brand scoring without spending an LLM call per document.

**Auth:** `x-api-key` + `x-org-id` + `x-user-id` + `x-run-id` (standard).

**Request (multi-brand, preferred):**
```json
{
  "brandIds": [
    "550e8400-e29b-41d4-a716-446655440000",
    "660f9500-f30c-42e5-b827-557766551111"
  ],
  "documents": [
    { "id": "quote-7c2b", "text": "Looking to interview a B2B SaaS founder about pricing experiments." },
    { "id": "quote-9f1a", "text": "Need a quote on AI safety from a research lab." }
  ],
  "query": "B2B SaaS pricing experiments"
}
```

**Request (legacy single-brand, still accepted):**
```json
{
  "brandId": "550e8400-e29b-41d4-a716-446655440000",
  "documents": [{ "id": "quote-7c2b", "text": "..." }]
}
```

| Field | Required | Notes |
|---|---|---|
| `brandIds` | one of | 1–5 UUIDs. Brand IDs whose joint profile is used as the semantic query. brand-service consolidates field values (industry, expertise, target audience, voice) across all brands in ONE call; chat-service then computes ONE embedding against the consolidated profile. |
| `brandId` | one of | Legacy single-brand field. Equivalent to `brandIds: [brandId]`. When both are provided, `brandIds` wins. At least one of `brandIds` / `brandId` is required. |
| `documents` | yes | 1–100 items. Each has `id` (caller-supplied, returned verbatim) and `text` (body to embed). |
| `query` | no | When omitted, the service synthesizes a query from the (joint) brand profile. When present, the override is used directly. |

**Response (multi-brand):**
```json
{
  "brandIds": [
    "550e8400-e29b-41d4-a716-446655440000",
    "660f9500-f30c-42e5-b827-557766551111"
  ],
  "queryText": "industry: B2B SaaS\nexpertise: pricing experiments\ntarget audience: founders\nvoice: data-driven",
  "cacheHit": true,
  "model": "gemini-embedding-001",
  "results": [
    { "id": "quote-7c2b", "score": 0.92 },
    { "id": "quote-9f1a", "score": 0.18 }
  ]
}
```

**Response (single-brand — `brandId` echo preserved for legacy consumers):**
```json
{
  "brandIds": ["550e8400-e29b-41d4-a716-446655440000"],
  "brandId": "550e8400-e29b-41d4-a716-446655440000",
  "queryText": "...",
  "cacheHit": true,
  "model": "gemini-embedding-001",
  "results": [{ "id": "quote-7c2b", "score": 0.92 }]
}
```

`brandIds` is always present and canonical-sorted ascending. `brandId` is echoed **only** when the request resolved to exactly one brand. `results` is sorted by `score` descending. Scores are cosine similarity in `[0, 1]` (negatives clamped to `0`).

**Pipeline:**
1. Canonical-sort `brandIds` ascending (e.g. `[b, a]` → `[a, b]`).
2. Resolve joint brand context from brand-service in ONE call (`industry`, `expertise`, `target_audience`, `voice`). brand-service merges field values across all input brands.
3. Synthesize a brand-profile query string (or use `query` override).
4. Compute the brand-profile embedding via Gemini `gemini-embedding-001` (cached per `(orgId, canonical-sorted brandIds CSV, contentHash)` in the `brand_profile_embeddings` table — only the brand-profile vector is cached; document vectors are recomputed per request).
5. Batch-embed every `documents[i].text`.
6. Cosine similarity between brand-profile vector and each document vector.

The cache automatically invalidates when **any** resolved brand field changes (the hash covers all fields). Repeated calls with unchanged brand context skip the brand-profile Gemini call entirely. Reversed-order brandIds (e.g. `[b, a]` after `[a, b]`) hit the same cache row since the key is canonical-sorted.

**Errors:**
- `400` — validation (`documents` empty, `documents.length > 100`, `brandIds.length > 5` or empty, non-UUID, neither `brandIds` nor `brandId` provided, etc.) or empty resolved brand profile (provide an explicit `query` when this happens).
- `404` — one or more `brandIds` not found in brand-service.
- `502` — upstream failure (brand-service, key-service, runs-service, or Gemini).

**Volume:** designed for batches of up to **100** documents per request, up to **5** brands per joint profile. Larger batches must be chunked by the caller.

The Gemini embedding model defaults to `gemini-embedding-001` and is overridable via `GEMINI_EMBEDDING_MODEL`. Key resolution uses the standard `google` provider in key-service.

**Cost handling (provision → authorize → execute → actualize):** the embedding spend is reserved **before** the Gemini call, never after. The flow per request:

1. **Provision** — `POST /v1/runs/{id}/costs` with `status: "provisioned"`, cost name `google-embedding-001-tokens-input` (byte-equal to the costs-service catalog; `costSource` is `org`/`platform` per the resolved key), `quantity` = input-token estimate (~4 chars/token; a cache hit on the brand-profile vector excludes the query tokens, a miss includes them).
2. **Authorize** — platform-key spend is checked against billing-service (`/v1/customer_balance/authorize`); BYOK/org keys skip this.
3. **Execute** — the Gemini embed runs only after 1 + 2 succeed.
4. **Actualize / cancel** — the provisioned cost is set to `actual` on success, or `cancelled` if the embed fails.

**Fail loud:** any provision/authorize/actualize failure returns an error and skips (or aborts) the spend — `502` on a runs-service `422 Unknown cost name` or downstream error, `402` (`Insufficient credits`) when billing rejects a platform-key request. A cost that cannot be declared perfectly blocks the operation rather than under-reporting silently. Errors that exit before provisioning (validation `400`, brand `404`, key-resolve `502`) reserve nothing.

## RAG Embed (`/orgs/rag/embed`)

`POST /orgs/rag/embed` — return raw embedding vectors for a batch of texts. Same embedding model as `/orgs/rag/score` (single source of truth).

Used by callers that need to run their own similarity, clustering, or dedup logic against the vectors (e.g. **journalists-quotes-service** cross-platform opportunity dedup pipeline). For document-vs-brand scoring use `/orgs/rag/score` instead — this endpoint does not score, cache, or persist anything.

**Auth:** `x-api-key` + `x-org-id` + `x-user-id` + `x-run-id` (standard).

**Request:**
```json
{
  "documents": [
    { "id": "quote-7c2b", "text": "Looking to interview a B2B SaaS founder about pricing experiments." },
    { "id": "quote-9f1a", "text": "Need a quote on AI safety from a research lab." }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `documents` | yes | 1–100 items. Each has `id` (caller-supplied, returned verbatim) and `text` (body to embed; max 8000 chars per text — matches Gemini `gemini-embedding-001`'s ~2048-token input limit). |

**Response:**
```json
{
  "model": "gemini-embedding-001",
  "results": [
    { "id": "quote-7c2b", "embedding": [0.0123, -0.0456, ...] },
    { "id": "quote-9f1a", "embedding": [0.0789, -0.0321, ...] }
  ]
}
```

`results` is returned in the **same order** as the input documents (1:1 by index and id). Vector dimensionality is whatever the underlying model returns (3072 for `gemini-embedding-001`).

**Pipeline:**
1. Resolve the org's Google API key via key-service.
2. Call Gemini `batchEmbedContents` for all `documents[i].text` in a single batch.
3. Return raw vectors in input order.

No vector storage, no similarity, no caching — callers persist and compare vectors themselves.

**Errors:**
- `400` — validation (`documents` empty, `documents.length > 100`, `text > 8000` chars, missing `id`/`text`, unknown fields).
- `401` — missing or invalid `x-api-key`.
- `502` — upstream failure (key-service, runs-service, or Gemini).

**Volume:** designed for batches of up to **100** documents per request, **8000** characters per text. Larger inputs must be chunked or truncated by the caller.

**Cost handling:** same **provision → authorize → execute → actualize** flow as `/orgs/rag/score` (see above). The embedding cost (`google-embedding-001-tokens-input`, quantity = document input-token estimate) is provisioned in runs-service and authorized against billing (platform keys) **before** the Gemini call; actualized on success, cancelled on failure. Any cost-declaration failure fails loud (`502`, or `402` on insufficient credits) — the spend is never made if the cost cannot be declared. Early-exit paths (validation `400`, key-resolve `502`) reserve nothing.

Determinism: Gemini `gemini-embedding-001` is deterministic for identical input texts under stable model versions, but Google does not contractually guarantee bit-exact output across server-side updates. Callers that depend on stable vectors over time should re-embed after a model version change.

## Campaign Context Enrichment

**Applies to `/chat` only.** When the `x-campaign-id` header is present on a `/chat` request, the service fetches the campaign's `featureInputs` from campaign-service and injects them into the system prompt as a `## Campaign Context` block.

- Campaign data is fetched via `GET /campaign/campaigns/{id}` through api-service
- Results are cached in-memory by `campaignId` (featureInputs are immutable for the lifetime of a campaign)
- If the fetch fails, the chat proceeds without campaign context (non-blocking)

**`/complete` and `/internal/platform-complete` do NOT inject anything into the system prompt.** They forward the caller's `systemPrompt` byte-equal to the provider. Callers wanting campaign data in the prompt must include it in their own `systemPrompt` payload.

## JSON Mode

`/complete` and `/internal/platform-complete` support JSON output via `responseFormat: "json"` and/or `responseSchema`. Enforcement is provider-native only — no system-prompt injection, no jsonrepair fallback, no LLM repair rounds.

| Provider | `responseFormat: "json"` alone | `responseSchema` (with or without `responseFormat`) |
|----------|-------------------------------|------------------------------------------------------|
| **Anthropic** | **Rejected (400)** — Anthropic has no native standalone JSON mode. Supply `responseSchema`. | Passed to Anthropic as `output_config.format = { type: "json_schema", schema }`. Anthropic enforces server-side. |
| **Google (Gemini)** | Native — passed as `generationConfig.responseMimeType: "application/json"`. | Both passed as `responseMimeType` + `responseSchema` in `generationConfig`. |

When `jsonMode` is set, the service populates `response.json` from the model output: a strict `JSON.parse(content)` fast path, falling back to recovery of the **first complete JSON value** when the provider wraps it in a markdown fence or appends trailing prose (Gemini 3 thinking models do this despite JSON-mode metadata). Recovery is a balanced, string-aware scan — no jsonrepair, no LLM repair rounds. If no complete JSON value is extractable (empty response, leading non-fence prose, truncated/unbalanced JSON), the provider violated its enforcement contract and it is surfaced as a 502 with a classified `detail`.

**Output budget.** Both providers receive an explicit **64k** output-token budget (Gemini `generationConfig.maxOutputTokens`, Anthropic `max_tokens`) — matching the worst-case hold provisioned/authorized for the call. Without an explicit budget Gemini falls back to a lower per-model default and truncates long responses, so it is always set. If the model still stops at the budget (`finishReason: "MAX_TOKENS"`) in JSON mode, the partial output is truncated JSON; the service **fails loud** with `[gemini] Output truncated (MAX_TOKENS)` → 502 (a clear cause, not a cryptic `JSON.parse` error). In text mode the partial content is returned with a warning.

## SSE Protocol

`POST /chat` with headers `Content-Type: application/json`, `x-api-key`, `x-org-id`, `x-user-id`.

Request body:
```json
{
  "configKey": "workflow",
  "message": "Hello",
  "sessionId": "optional-uuid-or-null",
  "context": {
    "workflowId": "wf-550e8400-e29b-41d4-a716-446655440000",
    "workflowSlug": "cold-email-outreach",
    "workflowName": "Cold Email Outreach",
    "brandId": "brand-123",
    "brandUrl": "https://example.com"
  }
}
```

- `configKey` (required) — which config to use (must match a key from `PUT /config` or `PUT /platform-config`)
- `message` (required) — the user's chat message
- `sessionId` (optional, nullable) — UUID of an existing session to continue. **Omit or pass `null` to start a new conversation** — the service creates the session and returns its ID in the first SSE event (`{"sessionId":"<uuid>"}`). Store that ID and pass it in subsequent requests. If a provided `sessionId` does not exist or belongs to a different org, the stream emits an SSE error event `{"type":"error","code":"session_not_found",...}` followed by `[DONE]` and closes. **Do not generate your own UUID** — always use the one returned by the service. Sessions are scoped by `orgId` only — every user inside the same org can resume any session for that org. Different-user-same-org continuation is intentional; if you need per-user isolation, segregate at the caller layer.
- `context` (optional) — free-form JSON provided by the **frontend** (not user-editable). Injected into the system prompt for this request only (not stored). **Re-send on every message** — the service does not cache it. After a fork (e.g. workflow updated → new workflow created), update the context with the new IDs. Capped at **50KB** when serialized to JSON; oversized payloads return `400 {"error":"Invalid request"}`.

The response is a stream of SSE events in this order:

### 1. Session ID
```
data: {"sessionId":"uuid"}
```

### 2. Thinking (optional)
When Claude uses internal reasoning (adaptive thinking), thinking events are streamed progressively:
```
data: {"type":"thinking_start"}
data: {"type":"thinking_delta","thinking":"Let me analyze the user's request..."}
data: {"type":"thinking_delta","thinking":"I should check their campaign data first."}
data: {"type":"thinking_stop"}
```
Thinking blocks may appear before tokens and before/after tool calls. The frontend can render these as collapsible "Thinking…" blocks.

### 3. Streaming tokens
Streamed incrementally as the AI generates its response:
```
data: {"type":"token","content":"Here's"}
data: {"type":"token","content":" what I"}
data: {"type":"token","content":" suggest..."}
```

### 4. Tool calls (optional)
If the AI invokes a built-in tool:
```
data: {"type":"tool_call","id":"tc_550e8400-e29b-41d4-a716-446655440000","name":"fork_workflow","args":{"workflowId":"...","dag":{...}}}
data: {"type":"tool_result","id":"tc_550e8400-e29b-41d4-a716-446655440000","name":"fork_workflow","result":{...}}
```
- `id` — unique identifier matching a `tool_call` to its `tool_result`
- `name` — the tool name
- `args` — input arguments as an object
- `result` — the tool output (string or object). On a tool **failure**, both the Anthropic and Gemini agentic loops emit a structured `result` of shape `{ error, tool, suggestion }` (parsed from the downstream error via `formatToolError`) rather than a raw error blob — this is also what is fed back to the model so it can self-correct. Field-level validation errors (Zod `issues[].path` or workflow-service DAG `details[].field`) are extracted even when api-service double-encodes a downstream 400 as a 500.

After a tool result, more `token` events follow with the AI's continuation.

**Tool-then-empty never surfaces as silence.** If one or more tools run but the model's follow-up "summarize" turn produces no text, the service emits a fallback `token` event built from the real tool results (so the user always sees what was retrieved) and logs the empty turn loudly — never a frozen tool card with a blank reply. This guards both the Gemini and Anthropic agentic loops. The `/chat` Gemini path also sets an explicit **64k** `maxOutputTokens` (Gemini-3 thinking tokens count against the output budget; without an explicit cap a post-tool summary turn can exhaust the lower default cap on thinking and emit zero answer text).

**Thinking config is generation-specific.** Gemini 3.x models (`gemini-3*`, incl. `gemini-3.7-flash` = the `flash-pro` alias) use `thinkingConfig.thinkingLevel` (`"low"` here); the Gemini-2.5-era `thinkingBudget` integer is only "accepted for backwards compatibility" on Gemini 3 and produces degenerate **thinking-only / empty** replies — which is what broke every flash-pro `/chat` once Google flipped `gemini-3.5-flash` to stable. Gemini 2.5 models keep `thinkingBudget`. Selected per-model by `buildThinkingConfig(model, disableThinking, level)`. On `/chat` a config's stored `thinkingLevel` is threaded in as `level` to raise a Gemini-3 chat mode above the `"low"` default (e.g. the self-seeded editor configs run at `"medium"`); `/complete` passes no `level`, so it always stays `"low"`.

#### Tool memory across turns

Tool calls and their results are persisted on the assistant message (in the `tool_calls` jsonb column) and replayed to the provider on every subsequent turn:

- **Anthropic**: prior `tool_use` blocks + matching `tool_result` blocks are rebuilt from `tool_calls` and re-injected into the conversation history. Tool-use ids are synthesized deterministically per (message-index, tool-index) — the live agentic loop uses real Anthropic ids; only cross-turn reconstruction uses synthetic ids. Tool calls without a `result` (e.g. paused on `request_user_input`) are filtered out.
- **Gemini**: prior `functionCall` + `functionResponse` parts are rebuilt and re-injected, merging into the existing user/model turn flow. Gemini 3 `id` fields are captured during the live loop and threaded through `functionResponse`.

Anthropic's beta `clear_tool_uses_20250919` context-management edit auto-clears the oldest tool-use blocks once the input crosses 50k tokens, so multi-turn agentic conversations stay within budget without manual trimming. For Gemini, `trimGeminiHistoryToBudget` drops oldest messages (now accounting for serialized `tool_calls` length) once the heuristic estimate crosses 100k tokens.

### Available Tools

The tools available in each chat session are determined by the `allowedTools` array in the config. The LLM only sees and can call tools that are listed. Unknown or unlisted tools are rejected.

**Workflow tools:**

The three workflow write tools are intent-specific. The frontend's system prompt should make clear which intent applies:

| Tool | Intent | Endpoint |
|---|---|---|
| `create_workflow` | Brand-new workflow from natural language. No existing workflow being modified. Starts a new dynasty. | `POST /v1/workflows/create` |
| `upgrade_workflow` | Re-generate or patch the DAG of an existing workflow within its dynasty. **Hard rule: the discriminator vs fork is INTENT, not topology.** Use for fixing a bug or repairing incorrect/broken/non-functional behavior — **even when the fix adds/removes/rewires nodes** (topology change stays in the same dynasty as a new version) — or clarifying metadata. Introducing NEW behavior/scope/intent/audience must use `fork_workflow`. Accepts either `description` (LLM regenerates) or `dag` (skips LLM, applies verbatim — surgical patch). | `POST /v1/workflows/upgrade` |
| `fork_workflow` | Introduce NEW behavior/scope/intent/audience to an existing workflow. A structural/topology change alone does NOT justify a fork (that's an upgrade). **Never call without explicit user confirmation** — a fork creates a new production dynasty (effectively irreversible). Submits a new DAG to `PUT /v1/workflows/:id`; workflow-service creates a new dynasty when the DAG signature differs. Same-signature submissions return `_action: "updated"` (no-op). | `PUT /v1/workflows/:id` |

Read-only and supporting workflow tools:

| Tool | Description |
|---|---|
| `get_workflow_details` | Fetches full workflow details (DAG, metadata, status) via `GET /workflows/{id}` |
| `get_workflow_required_providers` | Returns BYOK providers needed to execute a workflow via `GET /workflows/{id}/key-status` |
| `list_workflows` | Lists workflows via `GET /workflows` with optional filters |
| `validate_workflow` | Validates a workflow's DAG structure |
| `get_prompt_template` | Retrieves a stored prompt template by type |
| `update_prompt_template` | Creates a new version of an existing prompt template (auto-versions). `variables` is an array of `{ name, description }` objects (the deployed content-generation contract — not bare strings) |

**Service discovery tools (read-only):**

| Tool | Description |
|---|---|
| `list_services` | Lists all microservices with name, description, and endpoint count |
| `list_service_endpoints` | Lists endpoints for a specific service (method, path, summary) |

**Key management tools (read-only):**

| Tool | Description |
|---|---|
| `list_org_keys` | Lists API keys configured for the org (masked, never exposes secrets) |
| `get_key_source` | Gets key source preference (org vs platform) for a provider |
| `list_key_sources` | Lists all key source preferences for the org |
| `check_provider_requirements` | Queries which providers are needed for a set of endpoints |

**Feature tools:**

| Tool | Description |
|---|---|
| `create_feature` | Creates a new feature definition |
| `update_feature` | Updates or forks a feature (fork-on-write if signature changes) |
| `list_features` | Lists features with optional filters |
| `get_feature` | Gets full feature details by slug |
| `get_feature_inputs` | Gets input definitions only (lighter than get_feature) |
| `prefill_feature` | Pre-fills feature inputs from brand data |
| `get_feature_stats` | Gets computed stats for a feature |

**Campaign-prefill tools:**

| Tool | Description |
|---|---|
| `update_campaign_fields` | Passthrough tool — returns `{ fields }` so the frontend can apply values to the campaign form |
| `extract_brand_fields` | Extracts arbitrary fields from a brand's website via brand-service AI (cached 30 days) |
| `browse_url` | Fetches and returns the content of any public URL as markdown (via scraping-service/firecrawl). Read-only. |

**Persona-editor tools** (operate on the brand from `context.brandId`; via brand-service through api-service):

| Tool | Description |
|---|---|
| `list_personas` | Lists the brand's customer personas, optional `status` filter (`active`/`paused`/`archived`). Read-only. `GET /v1/brands/:id/personas` |
| `create_persona` | Creates a NEW immutable persona (`name` + `filters`). Names are unique per brand (case-insensitive); a clash returns `{ created: false, reason: "name_taken" }` — never a silent failure, never a hard delete. "Editing" a persona = creating a new one. `POST /v1/brands/:id/personas` |
| `duplicate_persona` | Duplicates a persona by id; `name` auto-uniquifies server-side (never clashes). `POST /v1/brands/:id/personas/:personaId/duplicate` |
| `set_persona_status` | Flips lifecycle status — the only mutable field (pause→paused, resume/restore→active, archive→archived). Archiving never deletes. `PATCH /v1/brands/:id/personas/:personaId/status` |

**Brand-profile-editor tools** (operate on the brand from `context.brandId`):

| Tool | Description |
|---|---|
| `get_brand_profile` | Gets the current profile fields + version list. Read-only. `GET /v1/brands/:id/brand-profile` |
| `save_brand_profile_version` | Saves a NEW immutable version. Supplies only `changes` (`set`/`setList`/`add`/`remove`); the tool reads current, merges, and POSTs the full field map, so prior versions are untouched and unchanged fields are preserved. `POST /v1/brands/:id/brand-profile` |
| `refresh_brand_profile_from_website` | Handles explicit latest/current website refresh requests end to end: reads current profile, forces fresh website field extraction via `POST /v1/brands/extract-fields` with `resetCache: true`, saves the full merged field map as a NEW immutable version, and returns the new version plus changed fields. Read-only questions never use this path. |

**Audience-editor tools** (operate on the brand from `context.brandId`; via human-service through the api-service gateway `/v1/orgs/audiences/*`, org-scoped by the forwarded `x-org-id`):

| Tool | Description |
|---|---|
| `list_audiences` | Lists the brand's audiences, optional `status` filter (`suggested`/`active`/`paused`/`archived`). Read-only. `GET /v1/orgs/audiences?brandId=` |
| `suggest_audiences` | Creates candidate audiences from a natural-language `nlPrompt`. Each candidate is ALREADY persisted as an inactive `suggested` audience (with generated name, rationale, live match count, winning provider). The model presents them; activation is a separate step. `POST /v1/orgs/audiences/suggest` |
| `set_audience_status` | Flips lifecycle status (activate/resume/restore→active, pause→paused, archive→archived). Activating a `suggested` candidate makes it live. Archiving never deletes; there is no hard delete. `PATCH /v1/orgs/audiences/:id/status` |
| `rename_audience` | Renames an audience (the only editable metadata; filters are immutable). `PATCH /v1/orgs/audiences/:id` |
| `refresh_audience_count` | Re-snapshots apollo + apify match counts via the free live dry-run. `POST /v1/orgs/audiences/:id/refresh-count` |
| `generate_audience_avatar` | (Re)generates the audience's avatar image. Optional `prompt` steers the image; omit to derive it from the audience's descriptors. ORG-BILLED (forwards `x-user-id` like `refresh_audience_count`). Returns the updated audience with its new `avatarUrl`. `POST /v1/orgs/audiences/:id/avatar` |

**Funnel tools** (full end-to-end platform operation — take the brand/campaign id explicitly, so they work in a brand-less onboarding session; all route through api-service with the forwarded identity, so the underlying op is org-billed by the owning service — chat-service adds no cost of its own):

| Tool | Description |
|---|---|
| `create_brand_from_url` | Creates/upserts a brand from its website `url` (onboarding-equivalent) and returns the brandId. `POST /v1/brands` |
| `list_brands` | Lists the org's brands (id, name, URL). Read-only. `GET /v1/brands` |
| `launch_campaign` | Launches a campaign: `name` + `brandUrls` + `featureInputs` + a feature (`featureDynastySlug` preferred) + a workflow (`workflowDynastySlug` preferred); optional budget caps / `maxLeads` / `endDate`. `POST /v1/campaigns` |
| `list_campaigns` | Lists the org's campaigns (id, name, status, brands, budgets); optional `brandId` / `status` filter. Read-only. `GET /v1/campaigns` |
| `stop_campaign` | Stops a running campaign by `campaignId`. `POST /v1/campaigns/:id/stop` |
| `get_daily_budget` | Reads a brand's current daily budget (`dailyBudgetCents`, null = unset). Read-only. `GET /v1/brands/:brandId/daily-budget` |
| `set_daily_budget` | Sets a brand's daily spend ceiling — `dailyBudgetCents` (IN CENTS; 0 = pause spend). `PATCH /v1/brands/:brandId/daily-budget` |
| `get_brand_pause` | Reads whether a brand is paused. Read-only. `GET /v1/brands/:brandId/pause` |
| `set_brand_pause` | Pauses (`paused: true`) or resumes (`paused: false`) a brand's activity. `PATCH /v1/brands/:brandId/pause` |

**UI tools:**

| Tool | Description |
|---|---|
| `request_user_input` | Asks the user for structured input (see Input Request below) |

### 5. Input Request (optional)
When the AI genuinely needs information it does not have, it emits an input request:
```
data: {"type":"input_request","input_type":"url","label":"What's your brand URL?","placeholder":"https://yourbrand.com","field":"brand_url"}
```
The frontend should render an appropriate input widget based on `input_type` (`url`, `text`, or `email`). When the user submits, send the value as a regular `/chat` message. The `field` key identifies what the input is for.

An optional `value` field can pre-fill the input when the AI already has a suggested value:
```
data: {"type":"input_request","input_type":"text","label":"New description","placeholder":"...","field":"new_description","value":"Automated cold email outreach campaign..."}
```
If `value` is present, the frontend should render the input pre-filled so the user can confirm with a single click. If absent, the field starts empty.

**Note:** The AI is instructed to only use `input_request` when it genuinely lacks information. Values already present in the `context` parameter or conversation history are used directly — the AI will not re-ask for them.

### 6. Buttons (optional)
AI-generated quick-reply buttons, sent after all tokens are done:
```
data: {"type":"buttons","buttons":[{"label":"Send Cold Emails","value":"Send Cold Emails"}]}
```
Buttons are extracted from the AI response when it ends with lines formatted as `- [Button Text]`. The button `label` and `value` are both set to the text inside the brackets. Button lines are stripped from the token stream to prevent duplication.

### Cost: provision → authorize → execute → reconcile (402)

`POST /chat` and `POST /complete` declare LLM spend with the platform cost rule. Output tokens are unknown until the call finishes, so a **right-sized estimate** is reserved up front and trued up to the real usage after:

1. **Provision** — before the model call, two `provisioned` cost rows (`<costPrefix>-tokens-input` + `-tokens-output`) are written to runs-service. The output hold is **right-sized**, not the flat model max: it equals the caller's `maxTokens` when declared, otherwise a realistic per-call estimate clamped well below the 64000 model ceiling. (The provider still receives the full 64000 output budget — or the caller's `maxTokens` — so long answers are never truncated; the hold is purely the affordability reservation, reconciled to the real cost after.) This matters because billing-service counts a `provisioned` hold as already-spent for affordability: a flat 64000-token hold on every call let a high-fan-out caller (e.g. ~12-25 concurrent `/complete` calls) stack dozens of maxed holds against one org balance in the same instant and falsely 402 a solvent org. When `webSearch: true`, a third `provisioned` web-search row is added at the worst-case search count (20 — Gemini 3 bills grounding per executed query and a single request can fan out to ~12-20 internal searches; the hold is reconciled to the actual count post-call). Validates the cost names are declarable.
2. **Authorize** — credit affordability is checked against billing-service for platform-key requests (`keySource: "platform"`). BYOK orgs (`keySource: "org"`) skip this — they pay their provider directly. (`/chat` authorizes pre-stream; `/complete` authorizes inline.) The web-search hold is included in the authorize when `webSearch` is on.
3. **Execute** — the model call runs only after provision + authorize succeed.
4. **Reconcile** — the **actual** token counts (and, when `webSearch` ran, the **actual** search count) are recorded (`actual` rows) and the provisioned worst-case holds are `cancelled`. If the actual write fails, the provisioned-max rows remain as a fallback record — the cost is never silently lost.

**Web-search cost names** (byte-equal to the costs-service catalog): Google grounding → `google-search-query`; Anthropic web search → `anthropic-web-search`. `POST /internal/platform-complete` declares the same token + web-search costs on a **platform run** as `actual` (no provision/authorize/cancel — platform spend, no org).

If the org has insufficient credits, the endpoint returns a **402** (JSON, not SSE on `/chat`):
```json
{
  "error": "Insufficient credits",
  "balance_cents": 5,
  "required_cents": 25
}
```

If a cost can't be declared (runs-service `422 Unknown cost name`) or billing-service is unreachable, the spend is blocked: `502` on `/complete`, an SSE `error` event on `/chat` (the stream is already open by provisioning time). The model is never called when the cost can't be declared or afforded.

### 7. Error (optional)
Sent when the AI model returns an empty response, is overloaded, or an unexpected error occurs:
```
data: {"type":"error","code":"model_overloaded","message":"Claude is temporarily overloaded. Please try again in a moment."}
```

| `code` | Meaning | Suggested UX |
|--------|---------|-------------|
| `model_overloaded` | Claude is temporarily at capacity (retries exhausted) | Show message + "Retry" button |
| `rate_limited` | Too many requests | Show message + auto-retry after delay |
| `model_error` | Transient upstream error (empty response, 5xx) | Show message + "Retry" button |
| `internal_error` | Unexpected server error | Show message |
| `session_not_found` | Provided `sessionId` does not exist or belongs to a different org | Drop the cached `sessionId` and retry with `sessionId: null` to start a new session |

The frontend should display the `message` to the user and use `code` to decide whether to offer a retry action. An `error` event is always followed by `[DONE]`.

### 8. Context Usage (always)
Sent on every successful turn, immediately before `[DONE]`. Use it to render a context-window gauge in the UI.
```
data: {"type":"context_usage","inputTokens":42100,"outputTokens":1280,"maxTokens":200000,"percent":21}
```

- `inputTokens` — tokens used by the prompt for this turn (post-compaction for Anthropic, post-trim for Gemini).
- `outputTokens` — tokens generated by the model on this turn.
- `maxTokens` — upper bound the service is willing to use, in tokens. Always `200000` regardless of provider — the service deliberately stays in the same context-window class as Claude Sonnet and never opts into the 1M-token Gemini tier.
- `percent` — `inputTokens / maxTokens` rounded to the nearest integer, capped at 100. Render this as a usage bar; show a warning tint past ~75%.

The Anthropic path relies on the SDK's beta `compact_20260112` to keep the input window under control. The Gemini path applies a heuristic trim (~chars/4 token estimate) when the prompt exceeds 100k tokens, dropping the oldest message pairs until back under 60k while always preserving at least the last two messages.

### 9. Done
```
data: "[DONE]"
```

## Session History (read)

`GET /sessions/{sessionId}` returns the full ordered conversation for a session so a client holding its `sessionId` can rebuild the chat panel exactly as the user last saw it — e.g. after a dashboard page refresh, where the client kept only the `sessionId`. It is **read-only** over the same `sessions`/`messages` tables `POST /chat` writes: no new storage, no run tracking, no cost, and no change to session lifecycle.

Headers: `x-api-key`, `x-org-id`, `x-user-id`, `x-run-id` (same auth as `POST /chat`). **Org-scoped** — the session must belong to the caller's `x-org-id`.

- **404** — an unknown `sessionId`, or one owned by a different org, returns `{"error":"Session not found. …"}` (the same message the `POST /chat` stream emits for `session_not_found`; existence is not leaked across orgs).
- **400** — `sessionId` is not a valid UUID.

Response `200`:
```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "orgId": "org-1",
  "campaignId": null,
  "brandIds": null,
  "workflowSlug": null,
  "featureSlug": null,
  "audienceId": null,
  "createdAt": "2026-07-16T10:00:00.000Z",
  "updatedAt": "2026-07-16T10:05:00.000Z",
  "messages": [
    { "id": "…", "role": "user", "content": "hi", "contentBlocks": null, "toolCalls": null, "buttons": null, "tokenCount": null, "createdAt": "2026-07-16T10:00:01.000Z" },
    {
      "id": "…",
      "role": "assistant",
      "content": "hello",
      "contentBlocks": [{ "type": "thinking", "thinking": "…" }, { "type": "text", "text": "hello" }],
      "toolCalls": [{ "name": "list_workflows", "args": { "limit": 5 }, "result": { "workflows": [] } }],
      "buttons": [{ "label": "More", "value": "more" }],
      "tokenCount": 12,
      "createdAt": "2026-07-16T10:00:02.000Z"
    }
  ]
}
```

`messages` is oldest-first. Per turn: `role`, plain-text `content`, optional provider `contentBlocks` (Anthropic content blocks including `thinking` reasoning — richer than `content`, which is the safe text fallback), and any `toolCalls` (tool `name` + input `args` + `result`; `result` is absent for a paused call such as `request_user_input`). The internal Gemini `thoughtSignature` replay token is not surfaced.

### Health Check

`GET /health` returns `{"status":"ok"}`.

### OpenAPI Spec

`GET /openapi.json` returns the OpenAPI 3.0 specification generated from zod schemas via `@asteasolutions/zod-to-openapi`. Used by the API Registry Service for automatic service discovery.

## Rendering Buttons on the Frontend

Listen for the `{"type":"buttons"}` SSE event. It arrives **after** all token streaming is complete and **before** `[DONE]`. Each button has a `label` (display text) and `value` (text to send back as the next user message). Only render buttons when `buttons.length > 0`.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ADMIN_DISTRIBUTE_API_KEY` | Yes | Admin API key for api-service gateway (sent as `X-API-Key` header) — all client-facing backend calls (workflows, features, keys, prompts, api-registry) route through api-service |
| `API_SERVICE_URL` | No | Api-service endpoint (default: `https://api.distribute.you`) |
| `KEY_SERVICE_API_KEY` | Yes | Service-to-service key for key-service (used only for Anthropic API key decryption — infrastructure, not routed via api-service) |
| `KEY_SERVICE_URL` | No | Key-service endpoint (default: `https://key.mcpfactory.org`) |
| `CHAT_SERVICE_DATABASE_URL` | Yes | PostgreSQL connection string |
| `RUNS_SERVICE_URL` | No | RunsService endpoint (default: `https://runs.mcpfactory.org`) |
| `RUNS_SERVICE_API_KEY` | No | API key for RunsService (runs tracking and trace events disabled if unset) |
| `BILLING_SERVICE_URL` | No | Billing-service endpoint (default: `https://billing.mcpfactory.org`) |
| `BILLING_SERVICE_API_KEY` | Yes | API key for billing-service — required for credit authorization on platform-key requests |
| `GEMINI_EMBEDDING_MODEL` | No | Gemini embedding model used by `/orgs/rag/score` and `/orgs/rag/embed` (default: `gemini-embedding-001`) |
| `TRANSACTIONAL_EMAIL_SERVICE_URL` | No | Transactional-email-service endpoint (default: `https://transactional-email.distribute.you`) |
| `TRANSACTIONAL_EMAIL_SERVICE_API_KEY` | No | API key for transactional-email-service. Unset → the `vendor_out_of_credit` template is not registered and the alert does not send (logged, never fatal) |
| `PLATFORM_OWNER_EMAIL` | No | Recipient of the direct-vendor out-of-credit alert. Unset → the alert logs and does not send |
| `PORT` | No | Server port (default: `3002`) |

## Database

Uses PostgreSQL via Drizzle ORM. Five tables:

- **sessions** — conversation sessions scoped by `orgId` and `userId`. Stores all identity/tracking context: `runId` (this service's run), `parentRunId` (caller's run from `x-run-id` header), `campaignId`, `brandIds` (text array for multi-brand support), `workflowSlug`, `featureSlug`
- **messages** — chat messages with role, content, optional `toolCalls`, `buttons`, `contentBlocks` JSONB (stores full Anthropic content blocks for context management)
- **app_configs** — per-org configuration keyed by `(orgId, key)`. Each entry defines a system prompt and `allowedTools` for a specific chat mode.
- **platform_configs** — platform-wide configuration keyed by `key`. Fallback when no per-org config exists for the same key.
- **brand_profile_embeddings** — cached Gemini embeddings of the brand-profile query, keyed by `(orgId, brandId, contentHash)`. Used by `/orgs/rag/score` so identical brand contexts skip the brand-profile embedding call. Document embeddings are not cached.

Migrations run automatically on server start. To generate new migrations after schema changes:

```bash
npm run db:generate
```

## Trace Events

`/chat` and `/complete` emit structured trace events to runs-service via `POST /v1/runs/{runId}/events`. Calls are fire-and-forget — failures are logged but never throw or block the request. Disabled when `RUNS_SERVICE_API_KEY` is unset.

| Endpoint | Events emitted |
|---|---|
| `/orgs/rag/score` | `run-created`, `rag-score-done`, `rag-score-failed` |
| `/orgs/rag/embed` | `run-created`, `rag-embed-done`, `rag-embed-failed` |
| `/complete` | `run-created`, `llm-call-start`, `llm-call-done`, `llm-call-failed` |
| `/chat` | `run-created`, `stream-start`, `stream-done`, `stream-failed` |

Body shape: `{ service: "chat-service", event, detail?, level?, data? }`. All identity (`x-org-id`, `x-user-id`, `x-run-id`, `x-api-key`) and tracking headers (`x-brand-id`, `x-campaign-id`, `x-workflow-slug`, `x-feature-slug`) are forwarded.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` and generate `openapi.json` |
| `npm run generate:openapi` | Regenerate `openapi.json` from zod schemas |
| `npm start` | Run compiled server |
| `npm test` | Run all tests |
| `npm run test:unit` | Run unit tests only |
| `npm run test:integration` | Run integration tests only |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run db:migrate` | Run migrations via drizzle-kit |
| `npm run db:push` | Push schema directly (dev only) |

## Testing Policy

Every PR that touches `src/` must include corresponding tests. CI enforces this:

- **`check-tests`** — fails if source files change without new or updated test files
- **`run-tests`** — runs `npm run test:unit` on every PR
- **`test-integration`** — starts a `postgres:17` service container, builds the schema by replaying `drizzle/*.sql`, and runs `npm run test:integration`

Integration tests get their own database per run: the service container is created when the job starts, is reachable only from that job, and dies with the runner. Concurrent PRs never interfere, and nothing outlives the run — there is no external project to provision and no cleanup step that can leave a database behind.

The schema is built with `drizzle-kit migrate` (journal replay), the same path the boot migrator takes in production, rather than `drizzle-kit push` — migrations here are hand-authored and `push` derives the schema from `schema.ts` instead. `tests/integration/schema-parity.test.ts` then asserts every table, column and index `schema.ts` declares is actually present, so a migration that fails to build the database fails the suite by name rather than somewhere unrelated.

Bug fixes must include a regression test that reproduces the issue. New features need unit tests covering the happy path and edge cases.

## Docker

```bash
docker build -t chat-service .
docker run -p 3002:3002 --env-file .env chat-service
```

Uses `node:20-alpine`. Requires Node >= 20.

### Graceful Shutdown

On `SIGTERM` / `SIGINT`, the server stops accepting new connections and waits up to 25 seconds for in-flight SSE streams to finish before exiting. This prevents active chat streams from being killed during Railway deployments.

### SSE Stream Timeouts

Node 20 defaults `requestTimeout` to 300s (5 min), which would kill long-running SSE streams. The server disables `requestTimeout` entirely (`0`) since chat streams can run for 30–60 min when the LLM makes many tool calls. `headersTimeout` stays at 60s to reject slow/malformed initial requests. `keepAliveTimeout` is set to 120s.

## Architecture

```
src/
  index.ts          # Express server, /chat, /complete, /internal/platform-complete, /internal/transfer-brand, /config, /platform-config, /health, /openapi.json
  types.ts          # SSE event TypeScript interfaces
  schemas.ts        # Zod schemas, OpenAPI registry, and request/response types
  middleware/
    auth.ts         # requireAuth middleware (x-api-key, x-org-id, x-user-id, x-run-id) + requireInternalAuth (x-api-key only)
  db/
    index.ts        # Drizzle client init
    schema.ts       # sessions + messages + app_configs + platform_configs table definitions
  lib/
    anthropic.ts       # Claude AI client (Sonnet 4.6), streaming + non-streaming, tool calling, adaptive thinking, context management (compaction), built-in tool declarations. Both paths retry transient errors (overloaded, 429, 5xx) up to 2× with exponential backoff: streaming (/chat) only when no tokens have been emitted yet; non-streaming complete() (/complete, /internal/platform-complete) always, since finalMessage() resolves atomically
    gemini.ts          # Gemini REST API client (non-streaming) — retry with exponential backoff (3 retries) + fallback to stable 2.5 models on failure
    gemini-chat.ts     # Gemini streaming chat client — streaming + function calling for /chat endpoint
    merge-messages.ts  # Ensures alternating user/assistant roles by merging orphaned consecutive same-role messages
    billing-client.ts  # Billing-service client for credit authorization before platform-key operations
    key-client.ts      # Key-service client: resolveKey (decrypt), listOrgKeys, getKeySource, listKeySources, checkProviderRequirements
    api-registry-client.ts # API Registry client: listServices, listServiceEndpoints, callApi (progressive disclosure)
    runs-client.ts     # RunsService HTTP client for run tracking and cost reporting
    workflow-client.ts              # Workflow-service client for create/upgrade/fork/validate built-in tools
    content-generation-client.ts    # Content-generation service client for get_prompt_template built-in tool
    features-client.ts              # Features-service client (create, update/fork, list, get, inputs, prefill, stats)
scripts/
  generate-openapi.ts  # Generates openapi.json from zod schemas via OpenApiGeneratorV3
```
