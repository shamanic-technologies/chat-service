# Chat Service

Multi-org AI chat service. Streams Gemini AI responses via SSE with configurable system prompts and built-in workflow tools.

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
| `x-workflow-name` | _(optional)_ Workflow name — injected automatically by workflow-service |

## App Config Registration

Before using `/chat`, orgs must register their configuration via:

`PUT /config`

Request body:
```json
{
  "systemPrompt": "You are a helpful assistant for cold email campaigns..."
}
```

- `systemPrompt` (required) — the system prompt sent to Gemini for this org

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
- `sessionId` (optional) — UUID of an existing session to continue. **Omit to start a new conversation** — the service creates the session and returns its ID in the first SSE event (`{"sessionId":"<uuid>"}`). Store that ID and pass it in subsequent requests. If a provided `sessionId` does not exist or belongs to a different org, the stream returns `"Session not found."` and closes. **Do not generate your own UUID** — always use the one returned by the service.
- `context` (optional) — free-form JSON injected into the system prompt for this request only (not stored)

The response is a stream of SSE events in this order:

### 1. Session ID
```
data: {"sessionId":"uuid"}
```

### 2. Thinking (optional)
When Gemini uses internal reasoning, thinking events are streamed progressively:
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
| `update_workflow` | Updates a workflow's metadata (name, description, tags) via workflow-service `PUT /workflows/{id}` |
| `update_workflow_node_config` | Updates a specific node's config in a workflow's DAG (e.g. change prompt type on `email-generate` node). Fetches, merges, and saves. |
| `validate_workflow` | Validates a workflow's DAG structure via workflow-service `POST /workflows/{id}/validate` |
| `get_prompt_template` | Retrieves a stored prompt template by type from content-generation `GET /prompts?type=...` |
| `update_prompt_template` | Creates a new version of an existing prompt template via content-generation `PUT /prompts` (auto-versions: e.g. `cold-email` → `cold-email-v2`) |
| `request_user_input` | Asks the user for structured input (see Input Request below) |

**Native Gemini tools** (always enabled, invoked automatically by the model):

| Tool | Description | Cost tracking |
|---|---|---|
| `googleSearch` | Gemini searches the web when it needs real-time information. The model decides autonomously when to search. | Billed per search query executed. Reported as `gemini-google-search-query` cost item in runs-service. |
| `urlContext` | Gemini reads web page content when URLs appear in the conversation. | Billed as input tokens (page content is injected into context). Already covered by `{model}-tokens-input` cost item. |

These tools are transparent to the frontend — no SSE events are emitted for them. The model's response simply includes grounded information with citations.

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
| `KEY_SERVICE_API_KEY` | Yes | Service-to-service key for key-service (used to resolve the Gemini API key per-request) |
| `CHAT_SERVICE_DATABASE_URL` | Yes | PostgreSQL connection string |
| `KEY_SERVICE_URL` | No | Key-service endpoint (default: `https://key.mcpfactory.org`) |
| `RUNS_SERVICE_URL` | No | RunsService endpoint (default: `https://runs.mcpfactory.org`) |
| `RUNS_SERVICE_API_KEY` | No | API key for RunsService (runs tracking disabled if unset) |
| `WORKFLOW_SERVICE_URL` | No | Workflow-service endpoint (default: `https://workflow.mcpfactory.org`) |
| `WORKFLOW_SERVICE_API_KEY` | No | API key for workflow-service (built-in workflow tools fail if unset) |
| `CONTENT_GENERATION_SERVICE_URL` | No | Content-generation service endpoint (default: `https://content-generation.distribute.you`) |
| `CONTENT_GENERATION_SERVICE_API_KEY` | No | API key for content-generation service (get_prompt_template tool fails if unset) |
| `PORT` | No | Server port (default: `3002`) |

## Database

Uses PostgreSQL via Drizzle ORM. Three tables:

- **sessions** — conversation sessions scoped by `orgId` and `userId`
- **messages** — chat messages with role, content, optional `toolCalls`, `buttons` JSONB, `runId` linking to RunsService, and optional `campaign_id`, `brand_id`, `workflow_name` for workflow tracking
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

## Architecture

```
src/
  index.ts          # Express server, /chat, /config, /platform-config, /health, /openapi.json
  types.ts          # SSE event TypeScript interfaces
  schemas.ts        # Zod schemas, OpenAPI registry, and request/response types
  middleware/
    auth.ts         # requireAuth middleware (x-api-key, x-org-id, x-user-id, x-run-id) + requireInternalAuth (x-api-key only)
  db/
    index.ts        # Drizzle client init
    schema.ts       # sessions + messages + app_configs + platform_configs table definitions
  lib/
    gemini.ts          # Gemini AI client, streaming + function calling, buildSystemPrompt helper, built-in tool declarations
    key-client.ts      # Key-service client for resolving Gemini keys (platform or BYOK per org)
    runs-client.ts     # RunsService HTTP client for run tracking and cost reporting
    workflow-client.ts              # Workflow-service client for update_workflow and validate_workflow built-in tools
    content-generation-client.ts    # Content-generation service client for get_prompt_template built-in tool
scripts/
  generate-openapi.ts  # Generates openapi.json from zod schemas via OpenApiGeneratorV3
```
