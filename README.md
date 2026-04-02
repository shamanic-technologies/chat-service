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
    "update_workflow",
    "validate_workflow",
    "get_workflow_details",
    "generate_workflow",
    "get_workflow_required_providers",
    "list_workflows",
    "update_workflow_node_config",
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
    "extract_brand_fields",
    "extract_brand_text"
  ]
}
```

Fields:
- `key` (required) — config identifier, unique per org. Clients pass this as `configKey` in `POST /chat`.
- `systemPrompt` (required) — the system prompt sent to Claude for this chat mode
- `allowedTools` (required, min 1) — which tools the LLM can use. The service rejects any tool call not in this list. See [Available Tools](#available-tools) for the full list.

This endpoint is **idempotent** (upsert on `(orgId, key)`). Call it on every cold start.

Response:
```json
{
  "orgId": "org-uuid",
  "key": "workflow",
  "systemPrompt": "...",
  "allowedTools": ["..."],
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

Fields: same as `PUT /config` — `key`, `systemPrompt`, `allowedTools` (all required).

This endpoint is **idempotent** (upsert on `key`). Called on every cold start by api-service.

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
  "temperature": 0.3,
  "maxTokens": 2000
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
  "temperature": 0,
  "maxTokens": 1024
}
```

- `message` (required) — the prompt to send to the LLM
- `systemPrompt` (required) — inline system prompt (no pre-registered config needed)
- `provider` (required) — LLM provider: `"anthropic"` or `"google"`
- `model` (required) — version-free model alias. The service resolves the latest versioned model internally. Valid combinations:
  - **anthropic**: `haiku` (fast/cheap), `sonnet` (balanced), `opus` (highest quality)
  - **google**: `flash-lite` (cheapest, vision), `flash` (balanced, reasoning), `pro` (most powerful). All require a Google API key in key-service.
- `responseFormat` (optional) — set to `"json"` to instruct the model to return valid JSON. The parsed result appears in the `json` field.
- `temperature` (optional) — sampling temperature, 0–2 (default: model default)
- `maxTokens` (optional) — max output tokens, 1–64000 (default: 64000)
- `thinkingBudget` (optional) — thinking token budget, 0–32000. Enables internal chain-of-thought reasoning before the model responds. Thinking tokens share the `maxTokens` budget, so set `maxTokens` high enough for both. **Google:** maps to `thinkingConfig.thinkingBudget`; when omitted or 0, `thinkingConfig` is not sent (thinking-only models use their default budget). **Anthropic:** maps to `thinking.budget_tokens` (minimum 1024; temperature is forced to 1 when enabled).
- `imageUrl` (optional) — URL of an image to include as visual input. The image is fetched server-side. Supported by all models, but recommended with `google` + `flash-lite` for cost-effective vision tasks.
- `imageContext` (optional) — metadata about the image to help the model classify it: `{ alt?: string, title?: string, sourceUrl?: string }`. Injected into the prompt alongside the image. Only meaningful when `imageUrl` is provided.

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

- `content` — raw text response (always present). **Warning:** when `responseFormat: "json"`, this field may contain markdown code fences (e.g. `` ```json...``` ``). Do **not** use this field for JSON parsing.
- `json` — parsed JSON object (present when `responseFormat: "json"`). **Always use this field** for structured data — markdown fences are already stripped and the JSON is pre-parsed. If the model returns non-parsable JSON, the endpoint returns **502** instead of silently omitting this field.
- `tokensInput` / `tokensOutput` — token usage
- `model` — the versioned model ID that was actually used (resolved from the provider + alias)

Unlike POST /chat, this endpoint is **stateless** (no sessions), accepts an **inline systemPrompt**, and returns **JSON** instead of SSE. Run tracking and billing work identically to POST /chat.

Error responses: 400 (validation), 401 (auth), 402 (insufficient credits), 502 (upstream failure).

## Campaign Context Enrichment

When the `x-campaign-id` header is present, both `/chat` and `/complete` automatically fetch the campaign's `featureInputs` from campaign-service and inject them into the system prompt. This ensures every LLM call is informed by the user's campaign-specific inputs (editorial angle, target geography, audience type, etc.).

- Campaign data is fetched via `GET /campaign/campaigns/{id}` through api-service
- Results are cached in-memory by `campaignId` (featureInputs are immutable for the lifetime of a campaign)
- If the fetch fails, the LLM call proceeds without campaign context (non-blocking)

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
- `sessionId` (optional, nullable) — UUID of an existing session to continue. **Omit or pass `null` to start a new conversation** — the service creates the session and returns its ID in the first SSE event (`{"sessionId":"<uuid>"}`). Store that ID and pass it in subsequent requests. If a provided `sessionId` does not exist or belongs to a different org, the stream returns `"Session not found."` and closes. **Do not generate your own UUID** — always use the one returned by the service.
- `context` (optional) — free-form JSON provided by the **frontend** (not user-editable). Injected into the system prompt for this request only (not stored). **Re-send on every message** — the service does not cache it. After a fork (e.g. workflow updated → new workflow created), update the context with the new IDs.

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
data: {"type":"tool_call","id":"tc_550e8400-e29b-41d4-a716-446655440000","name":"update_workflow","args":{"workflowId":"..."}}
data: {"type":"tool_result","id":"tc_550e8400-e29b-41d4-a716-446655440000","name":"update_workflow","result":{...}}
```
- `id` — unique identifier matching a `tool_call` to its `tool_result`
- `name` — the tool name
- `args` — input arguments as an object
- `result` — the tool output (string or object)

After a tool result, more `token` events follow with the AI's continuation.

### Available Tools

The tools available in each chat session are determined by the `allowedTools` array in the config. The LLM only sees and can call tools that are listed. Unknown or unlisted tools are rejected.

**Workflow tools:**

| Tool | Description |
|---|---|
| `get_workflow_details` | Fetches full workflow details (DAG, metadata, status) via workflow-service `GET /workflows/{id}` |
| `generate_workflow` | Generates a new workflow from natural language via workflow-service `POST /workflows/generate` |
| `get_workflow_required_providers` | Returns BYOK providers needed to execute a workflow via `GET /workflows/{id}/required-providers` |
| `list_workflows` | Lists workflows via `GET /workflows` with optional filters |
| `update_workflow` | Updates a workflow's metadata or DAG. DAG changes trigger a fork (new workflow). Metadata-only changes update in-place. |
| `update_workflow_node_config` | Updates a specific node's config in a workflow's DAG. May fork if DAG changes. |
| `validate_workflow` | Validates a workflow's DAG structure |
| `get_prompt_template` | Retrieves a stored prompt template by type |
| `update_prompt_template` | Creates a new version of an existing prompt template (auto-versions) |

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
| `extract_brand_text` | Extracts full text content from a brand's public website pages |

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

### Credit Authorization (402)

Before streaming, the service checks credit authorization via billing-service for platform-key requests (`keySource: "platform"`). BYOK orgs (`keySource: "org"`) skip this check — they pay their provider directly.

If the org has insufficient credits, the endpoint returns a **402 JSON response** (not SSE):
```json
{
  "error": "Insufficient credits",
  "balance_cents": 5,
  "required_cents": 25
}
```

If billing-service is unreachable, a **502 JSON response** is returned instead.

### 7. Error (optional)
Sent when the AI model returns an empty response (context overflow, safety filter) or an unexpected error occurs:
```
data: {"type":"error","message":"The AI model returned an empty response. This may happen when the conversation is too long or the message content triggers a safety filter."}
```
The frontend should display the `message` to the user. An `error` event is always followed by `[DONE]`.

### 8. Done
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
| `RUNS_SERVICE_API_KEY` | No | API key for RunsService (runs tracking disabled if unset) |
| `BILLING_SERVICE_URL` | No | Billing-service endpoint (default: `https://billing.mcpfactory.org`) |
| `BILLING_SERVICE_API_KEY` | Yes | API key for billing-service — required for credit authorization on platform-key requests |
| `PORT` | No | Server port (default: `3002`) |

## Database

Uses PostgreSQL via Drizzle ORM. Three tables:

- **sessions** — conversation sessions scoped by `orgId` and `userId`
- **messages** — chat messages with role, content, optional `toolCalls`, `buttons`, `contentBlocks` JSONB (stores full Anthropic content blocks for context management), `runId` linking to RunsService, and optional `campaign_id`, `brand_ids` (text array for multi-brand support), `workflow_slug`, `feature_slug` for workflow tracking
- **app_configs** — per-org configuration keyed by `(orgId, key)`. Each entry defines a system prompt and `allowedTools` for a specific chat mode.
- **platform_configs** — platform-wide configuration keyed by `key`. Fallback when no per-org config exists for the same key.

Migrations run automatically on server start. To generate new migrations after schema changes:

```bash
npm run db:generate
```

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
  index.ts          # Express server, /chat, /complete, /config, /platform-config, /health, /openapi.json
  types.ts          # SSE event TypeScript interfaces
  schemas.ts        # Zod schemas, OpenAPI registry, and request/response types
  middleware/
    auth.ts         # requireAuth middleware (x-api-key, x-org-id, x-user-id, x-run-id) + requireInternalAuth (x-api-key only)
  db/
    index.ts        # Drizzle client init
    schema.ts       # sessions + messages + app_configs + platform_configs table definitions
  lib/
    anthropic.ts       # Claude AI client (Sonnet 4.6), streaming + non-streaming, tool calling, adaptive thinking, context management (compaction), built-in tool declarations
    gemini.ts          # Gemini REST API client (Flash 2.0) for vision tasks — lightweight, no SDK dependency
    merge-messages.ts  # Ensures alternating user/assistant roles by merging orphaned consecutive same-role messages
    billing-client.ts  # Billing-service client for credit authorization before platform-key operations
    key-client.ts      # Key-service client: resolveKey (decrypt), listOrgKeys, getKeySource, listKeySources, checkProviderRequirements
    api-registry-client.ts # API Registry client: listServices, listServiceEndpoints, callApi (progressive disclosure)
    runs-client.ts     # RunsService HTTP client for run tracking and cost reporting
    workflow-client.ts              # Workflow-service client for update_workflow and validate_workflow built-in tools
    content-generation-client.ts    # Content-generation service client for get_prompt_template built-in tool
    features-client.ts              # Features-service client (create, update/fork, list, get, inputs, prefill, stats)
scripts/
  generate-openapi.ts  # Generates openapi.json from zod schemas via OpenApiGeneratorV3
```
