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
| `x-brand-id` | _(optional)_ Brand ID — injected automatically by workflow-service |
| `x-workflow-slug` | _(optional)_ Workflow slug — injected automatically by workflow-service |
| `x-feature-slug` | _(optional)_ Feature slug — propagated through the entire service chain |

## App Config Registration

Before using `/chat`, orgs must register their configuration via:

`PUT /config`

Request body:
```json
{
  "systemPrompt": "You are a helpful assistant for cold email campaigns..."
}
```

- `systemPrompt` (required) — the system prompt sent to Claude for this org

This endpoint is **idempotent** (upsert on `orgId` from the `x-org-id` header). Call it on every cold start.

Response:
```json
{
  "orgId": "org-uuid",
  "systemPrompt": "...",
  "createdAt": "2026-02-26T00:00:00.000Z",
  "updatedAt": "2026-02-26T00:00:00.000Z"
}
```

## Platform Config Registration

Register a global (non-org-scoped) chat configuration used as fallback when no per-org config exists:

`PUT /platform-config`

**Auth:** `X-API-Key` only — no `x-org-id`, `x-user-id`, or `x-run-id` headers required.

Request body:
```json
{
  "systemPrompt": "You are a helpful assistant..."
}
```

- `systemPrompt` (required) — the default system prompt for all orgs without a per-org config

This endpoint is **idempotent** (upsert). Called on every cold start by api-service.

**Config resolution in POST /chat:** Per-org config (from `PUT /config`) takes priority. If none exists, the platform config (from `PUT /platform-config`) is used. If neither exists, the request fails with 404. There is no merging — it's one or the other.

Response:
```json
{
  "systemPrompt": "...",
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
  "responseFormat": "json",
  "temperature": 0.3,
  "maxTokens": 2000,
  "model": "claude-haiku-4-5"
}
```

- `message` (required) — the prompt to send to the LLM
- `systemPrompt` (required) — inline system prompt (no pre-registered config needed)
- `responseFormat` (optional) — set to `"json"` to instruct the model to return valid JSON. The parsed result appears in the `json` field.
- `temperature` (optional) — sampling temperature, 0–2 (default: model default)
- `maxTokens` (optional) — max output tokens, 1–64000 (default: 16000)
- `model` (optional) — Anthropic model to use: `claude-sonnet-4-6` (default) or `claude-haiku-4-5`. Use Haiku for simpler tasks (extraction, classification) to reduce cost.

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

- `content` — raw text response (always present)
- `json` — parsed JSON object (only when `responseFormat: "json"` and model returned valid JSON)
- `tokensInput` / `tokensOutput` — token usage
- `model` — model used

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
  "message": "Hello",
  "sessionId": "optional-uuid",
  "context": {
    "brandUrl": "https://example.com",
    "objective": "clicks",
    "budgetAmount": 500
  }
}
```

- `message` (required) — the user's chat message
- `sessionId` (optional, nullable) — UUID of an existing session to continue. **Omit or pass `null` to start a new conversation** — the service creates the session and returns its ID in the first SSE event (`{"sessionId":"<uuid>"}`). Store that ID and pass it in subsequent requests. If a provided `sessionId` does not exist or belongs to a different org, the stream returns `"Session not found."` and closes. **Do not generate your own UUID** — always use the one returned by the service.
- `context` (optional) — free-form JSON injected into the system prompt for this request only (not stored)

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

**Built-in tools:**

| Tool | Description |
|---|---|
| `get_workflow_details` | Fetches full workflow details (DAG, metadata, status) via workflow-service `GET /workflows/{id}` |
| `get_workflow_required_providers` | Returns BYOK providers needed to execute a workflow via `GET /workflows/{id}/required-providers`. Proactively warns about missing keys. |
| `list_workflows` | Lists workflows via `GET /workflows` with optional filters: featureSlug, category, channel, audienceType, tag, status, brandId, humanId, campaignId |
| `update_workflow` | Updates a workflow's metadata or DAG via `PUT /workflows/{id}`. DAG changes trigger a fork (201 with new workflow) rather than in-place update. Returns 409 if DAG signature already exists. Metadata-only changes update in-place (200). |
| `update_workflow_node_config` | Updates a specific node's config in a workflow's DAG (e.g. change prompt type on `email-generate` node). Fetches, merges, and saves. May fork the workflow if the DAG changes. |
| `validate_workflow` | Validates a workflow's DAG structure via workflow-service `POST /workflows/{id}/validate` |
| `get_prompt_template` | Retrieves a stored prompt template by type from content-generation `GET /prompts?type=...` |
| `update_prompt_template` | Creates a new version of an existing prompt template via content-generation `PUT /prompts` (auto-versions: e.g. `cold-email` → `cold-email-v2`) |
| `list_services` | Lists all microservices with name, description, and endpoint count via api-registry `GET /llm-context`. Start here for service discovery. |
| `list_service_endpoints` | Lists endpoints (method, path, summary) for a specific service via api-registry `GET /llm-context/{service}`. Use after `list_services` to drill down. |
| `call_api` | Proxies an API call to any registered service via api-registry `POST /call/{service}`. API key injected automatically. Use to verify data or read resources. |
| `list_org_keys` | Lists API keys configured for the current org (provider + masked key) via key-service `GET /keys`. Never exposes actual secrets. |
| `get_key_source` | Gets key source preference (org vs platform) for a provider via key-service `GET /keys/{provider}/source`. |
| `list_key_sources` | Lists all key source preferences for the org via key-service `GET /keys/sources`. |
| `check_provider_requirements` | Queries which providers are needed for a set of endpoints via key-service `POST /provider-requirements`. |
| `request_user_input` | Asks the user for structured input (see Input Request below) |

**Context-specific tools:**

When `context.type` is `"feature-creator"`, the standard workflow tools above are **replaced** by a focused toolset for designing features:

| Tool | Description |
|---|---|
| `request_user_input` | Asks the user for structured input (same as above) |
| `create_feature` | Creates a new feature via `POST /features`. Required: name, description, **icon**, category, channel, audienceType, inputs (with key/label/**type**/**placeholder**/description/**extractKey**), outputs (with **key**/**displayOrder**, optional defaultSort/sortDirection — keys from stats registry), charts (min 1), entities (min 1). Optional: slug, implemented, displayOrder, status. Returns 409 on conflict. Response includes `id`, `displayName`, `signature`. |
| `update_feature` | Updates or forks a feature via `PUT /features/:slug` (fork-on-write). Metadata-only changes update in-place (200). If inputs/outputs change (different signature), a new forked feature is created, the original is deprecated (201). Response includes `forked: boolean`. Supports: name, description, icon, category, channel, audienceType, implemented, displayOrder, status, inputs, outputs, charts, entities. |
| `list_features` | Lists features via `GET /features` with optional filters (category, channel, audienceType, status, implemented). Responses include `displayName` (stable human label) and `name` (machine identifier, may include version suffix). |
| `get_feature` | Gets full feature details by slug via `GET /features/:slug`. |
| `get_feature_inputs` | Gets input definitions only via `GET /features/:slug/inputs`. Lighter than `get_feature`. |
| `prefill_feature` | Pre-fills feature inputs from brand data via `POST /features/:slug/prefill`. Returns a map of input key → suggested text value. |
| `get_feature_stats` | Gets computed stats via `GET /features/:slug/stats`. Supports `groupBy` (workflowSlug, brandId, campaignId) and filter params. Returns system stats (cost, runs, campaigns) and per-output metrics. |

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
- **messages** — chat messages with role, content, optional `toolCalls`, `buttons`, `contentBlocks` JSONB (stores full Anthropic content blocks for context management), `runId` linking to RunsService, and optional `campaign_id`, `brand_id`, `workflow_slug`, `feature_slug` for workflow tracking
- **app_configs** — per-org configuration (system prompt) with unique constraint on `orgId`
- **platform_configs** — global platform-wide chat configuration (fallback when no per-org config exists)

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
