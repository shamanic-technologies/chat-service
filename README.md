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

Fields: same as `PUT /config` — `key`, `systemPrompt`, `allowedTools` (all required), plus optional `provider` and `model`.

This endpoint is **idempotent** (upsert on `key`). Called on every cold start by api-service.

**Self-seeded configs.** Two platform configs are owned by chat-service itself and seeded at boot (in `src/lib/seed-platform-configs.ts`, run from the migrate→listen path) — they do not need any external registrar:

| configKey | Tools | Purpose |
|---|---|---|
| `persona-editor` | `list_personas`, `create_persona`, `duplicate_persona`, `set_persona_status`, `request_user_input` | Read + curate a brand's customer personas via NL. |
| `brand-profile-editor` | `get_brand_profile`, `save_brand_profile_version`, `request_user_input` | Read + version a brand's brand profile via NL. |

Both default to `google`/`flash-pro`. The dashboard selects them by `configKey` and passes `context: { brandId }`; the tools act on that brand under the caller's org. The boot seed only upserts these two keys, so it never clobbers a dashboard-registered config.

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
- `provider` (required) — LLM provider: `"anthropic"` or `"google"`
- `model` (required) — version-free model alias. The service resolves the latest versioned model internally. Valid combinations:
  - **anthropic**: `haiku` (fast/cheap), `sonnet` (balanced), `opus` (highest quality)
  - **google**: `flash-lite` (cheapest, vision), `flash` (balanced, reasoning), `flash-pro` (mid-tier, Gemini 3.5 Flash), `pro` (most powerful). All require a Google API key in key-service.
- `responseFormat` (optional) — set to `"json"` to enable JSON-mode parsing. **For `provider: "anthropic"`, you MUST also supply `responseSchema`** — Anthropic has no native standalone JSON mode, so the request is rejected with 400 if `responseSchema` is missing. For `provider: "google"` (Gemini), `responseFormat: "json"` alone is sufficient (native `responseMimeType` enforcement).
- `responseSchema` (optional) — JSON Schema enforced server-side by the provider's structured-output API. When set, JSON-mode parsing is implied (no need to also pass `responseFormat: "json"`). The schema is forwarded as:
  - **Google** → `generationConfig.responseSchema` (supported on all Gemini 2.5+ models: `pro`, `flash`, `flash-lite`). Gemini accepts only an OpenAPI 3.0 subset; chat-service auto-sanitizes the caller-supplied schema before forwarding by stripping unsupported JSON-Schema keywords (`additionalProperties`, `$schema`, `$ref`, `$defs`, `definitions`, `patternProperties`, `unevaluatedProperties`, `if`/`then`/`else`, `not`, `const`, `examples`, `default`, `exclusiveMinimum`/`exclusiveMaximum`, `multipleOf`, etc.). A `[chat-service] Gemini schema sanitized` warning is logged once per call when any field is removed.
  - **Anthropic** → `output_config.format = { type: "json_schema", schema }` (Claude 4.x). **Strict schema required**: `additionalProperties: false` and an explicit `properties` map. Permissive schemas are rejected with 400 by Anthropic.
- `temperature` (optional) — sampling temperature, 0–2 (default: model default)
- `webSearch` (optional, default `false`) — opt-in native web search. When `true`, the resolved provider answers using its **own** native web search so the response reflects live web content instead of the model's parametric memory:
  - **Google** → `googleSearch` grounding tool. The number of search queries is read from `groundingMetadata.webSearchQueries`; source URLs from `groundingMetadata.groundingChunks[].web`. **Not count-cappable**: the native `googleSearch` tool exposes no `max_uses`-style knob, so the model autonomously decides how many queries to run (Gemini 3 bills each — see Cost). There is no API parameter to bound it.
  - **Anthropic** → server-side `web_search_20250305` tool (`max_uses: 1`). Capped to **1** search per request for cost control (each search is one billable `web_search_requests` unit at $10/1k); single-fact lookups are unaffected, multi-entity comparison answers lose breadth. The search count is read from `usage.server_tool_use.web_search_requests`; source URLs from citation + result blocks.
  - In **text mode**, deduped citation source URLs are appended to `content` as a trailing `Sources:` block, so they surface in the response text. In **JSON mode** (`responseFormat: "json"` / `responseSchema`) the content is left untouched (a Sources block would corrupt the JSON), but grounding still applies and the search cost is still declared.
  - Omitted or `false` → no grounding, byte-identical to a non-grounded call (no extra cost). The web-search cost is metered per query/search and billed in addition to tokens — see the **Cost** section below.
- `imageUrl` (optional) — URL of an image to include as visual input. The image is fetched server-side. Supported by all models, but recommended with `google` + `flash-lite` for cost-effective vision tasks.
- `imageContext` (optional) — metadata about the image to help the model classify it: `{ alt?: string, title?: string, sourceUrl?: string }`. Injected into the prompt alongside the image. Only meaningful when `imageUrl` is provided.

**Example with `responseSchema` (Anthropic — strict schema mandatory):**
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
- `json` — parsed JSON object (present when `responseFormat: "json"` or when `responseSchema` is set). Populated via strict `JSON.parse(content)` — no jsonrepair, no LLM-assisted repair. Provider-native enforcement (`output_config.format` for Anthropic, `responseMimeType` / `responseSchema` for Gemini) guarantees the output is valid JSON. A parse failure means the provider violated its contract and the endpoint returns **502**.
- `tokensInput` / `tokensOutput` — token usage
- `model` — the versioned model ID that was actually used (resolved from the provider + alias)

Unlike POST /chat, this endpoint is **stateless** (no sessions), accepts an **inline systemPrompt**, and returns **JSON** instead of SSE. Run tracking and billing work identically to POST /chat.

Error responses: 400 (validation), 401 (auth), 402 (insufficient credits), 502 (upstream failure).

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

Same fields as `POST /complete` (including the optional `responseSchema` and `webSearch`) except **no `imageUrl` or `imageContext`** support.

**Key differences from `POST /complete`:**
- **No org billing** — platform-level calls are not charged to any org's credit balance (no affordability authorize).
- **Platform run tracking + cost** — a **platform run** is created in runs-service (`POST /v1/platform-runs`, `x-service-name: chat-service`, `taskName: platform-complete`) and the LLM (and web-search) spend is declared on it as `actual` costs (`costSource: platform`). Platform runs have no cost-status PATCH, so costs are posted post-call as `actual` (no provision/cancel). Fail-loud: if the platform run can't be created or its cost can't be declared, the call returns **502** rather than spending silently.
- **No campaign context** — no `x-campaign-id` enrichment.
- **Platform key resolution** — uses `GET /keys/platform/{provider}/decrypt` directly (no org-level key lookup).

Use this endpoint when a service needs an LLM call during startup or for platform-level operations that don't belong to a specific org or user (e.g. workflow upgrades, schema analysis).

Response format is identical to `POST /complete`.

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

When `jsonMode` is set, the service runs strict `JSON.parse(content)` on the model output to populate `response.json`. A parse failure means the provider violated its enforcement contract and is surfaced as a 502.

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
- `result` — the tool output (string or object)

After a tool result, more `token` events follow with the AI's continuation.

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
| `upgrade_workflow` | Re-generate or patch the DAG of an existing workflow within its dynasty. **Hard rule: bug fixes, metadata clarifications, or repairing a technically broken/non-functional workflow only.** Substantive changes on a working workflow must use `fork_workflow`. Accepts either `description` (LLM regenerates) or `dag` (skips LLM, applies verbatim — surgical patch). | `POST /v1/workflows/upgrade` |
| `fork_workflow` | Substantive change to an existing workflow. Submits a new DAG to `PUT /v1/workflows/:id`; the workflow-service creates a new dynasty when the DAG signature differs. Same-signature submissions return `_action: "updated"` (no-op). | `PUT /v1/workflows/:id` |

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

`POST /chat` and `POST /complete` declare LLM spend with the platform cost rule. Output tokens are unknown until the call finishes, so the **worst case** is reserved up front and trued up to the real usage after:

1. **Provision** — before the model call, two `provisioned` cost rows (`<costPrefix>-tokens-input` + `-tokens-output`) are written to runs-service with the worst-case quantity (input estimate + the model's output budget). When `webSearch: true`, a third `provisioned` web-search row is added at the worst-case search count (20 — Gemini 3 bills grounding per executed query and a single request can fan out to ~12-20 internal searches; the hold is reconciled to the actual count post-call). Validates the cost names are declarable.
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
- **`test-integration`** — creates an isolated Neon database branch per PR, pushes the schema, and runs `npm run test:integration`

Integration tests use Neon's branch-per-PR pattern: each PR gets a copy-on-write database branch (`pr-<number>`), so concurrent PRs never interfere with each other. Branches are automatically deleted when the PR closes (via `neon-cleanup.yml`).

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
