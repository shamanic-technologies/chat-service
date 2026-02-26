# Chat Service

Multi-app AI chat service. Streams Gemini AI responses via SSE with configurable system prompts and optional MCP tool calling per app.

## Quick Start

```bash
cp .env.example .env   # fill in your keys
npm install
npm run dev            # starts on port 3002
```

## Authentication

All endpoints (except `/health` and `/openapi.json`) require three headers:

| Header | Description |
|---|---|
| `x-api-key` | Service-to-service API key |
| `x-org-id` | Internal org UUID from client-service |
| `x-user-id` | Internal user UUID from client-service |

## App Config Registration

Before using `/chat`, apps must register their configuration via:

`PUT /apps/:appId/config`

Request body:
```json
{
  "systemPrompt": "You are a helpful assistant for cold email campaigns...",
  "mcpServerUrl": "https://mcp.mcpfactory.org",
  "mcpKeyName": "mcpfactory"
}
```

- `systemPrompt` (required) — the system prompt sent to Gemini for this app
- `mcpServerUrl` (optional) — MCP server URL to connect to for tool calling
- `mcpKeyName` (optional) — BYOK provider name in key-service; the org's key is decrypted at runtime and used as Bearer token for the MCP server

This endpoint is **idempotent** (upsert on `appId + orgId`). Call it on every cold start.

Response:
```json
{
  "appId": "sales-cold-emails",
  "orgId": "org-uuid",
  "systemPrompt": "...",
  "mcpServerUrl": "https://mcp.mcpfactory.org",
  "mcpKeyName": "mcpfactory",
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
  "appId": "sales-cold-emails",
  "sessionId": "optional-uuid",
  "context": {
    "brandUrl": "https://example.com",
    "objective": "clicks",
    "budgetAmount": 500
  }
}
```

- `message` (required) — the user's chat message
- `appId` (required) — identifies which app config (system prompt, MCP) to use
- `sessionId` (optional) — resume an existing session; omit to start a new one
- `context` (optional) — free-form JSON injected into the system prompt for this request only (not stored)

The response is a stream of SSE events in this order:

### 1. Session ID
```
data: {"sessionId":"uuid"}
```

### 2. Streaming tokens
Streamed incrementally as the AI generates its response:
```
data: {"type":"token","content":"Here's"}
data: {"type":"token","content":" what I"}
data: {"type":"token","content":" suggest..."}
```

### 3. Tool calls (optional)
If the AI invokes an MCP tool:
```
data: {"type":"tool_call","name":"search_leads","args":{"query":"..."}}
data: {"type":"tool_result","name":"search_leads","result":{...}}
```
After a tool result, more `token` events follow with the AI's continuation.

### 4. Input Request (optional)
When the AI needs structured user input (e.g., a URL), it emits an input request instead of asking in plain text:
```
data: {"type":"input_request","input_type":"url","label":"What's your brand URL?","placeholder":"https://yourbrand.com","field":"brand_url"}
```
The frontend should render an appropriate input widget based on `input_type` (`url`, `text`, or `email`). When the user submits, send the value as a regular `/chat` message. The `field` key identifies what the input is for.

### 5. Buttons (optional)
AI-generated quick-reply buttons, sent after all tokens are done:
```
data: {"type":"buttons","buttons":[{"label":"Send Cold Emails","value":"Send Cold Emails"}]}
```
Buttons are extracted from the AI response when it ends with lines formatted as `- [Button Text]`. The button `label` and `value` are both set to the text inside the brackets. Button lines are stripped from the token stream to prevent duplication.

### 6. Done
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
| `KEY_SERVICE_API_KEY` | Yes | Service-to-service key for key-service (used to decrypt the Gemini API key at startup and org MCP keys at runtime) |
| `CHAT_SERVICE_DATABASE_URL` | Yes | PostgreSQL connection string |
| `KEY_SERVICE_URL` | No | Key-service endpoint (default: `https://key.mcpfactory.org`) |
| `RUNS_SERVICE_URL` | No | RunsService endpoint (default: `https://runs.mcpfactory.org`) |
| `RUNS_SERVICE_API_KEY` | No | API key for RunsService (runs tracking disabled if unset) |
| `PORT` | No | Server port (default: `3002`) |

## Database

Uses PostgreSQL via Drizzle ORM. Three tables:

- **sessions** — conversation sessions scoped by `orgId`, `userId`, and `appId`
- **messages** — chat messages with role, content, optional `toolCalls`, `buttons` JSONB, and `runId` linking to RunsService
- **app_configs** — per-app configuration (system prompt, MCP settings) with unique constraint on `(appId, orgId)`

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
  index.ts          # Express server, /chat, /apps/:appId/config, /health, /openapi.json
  types.ts          # SSE event TypeScript interfaces
  schemas.ts        # Zod schemas, OpenAPI registry, and request/response types
  middleware/
    auth.ts         # requireAuth middleware (x-api-key, x-org-id, x-user-id)
  db/
    index.ts        # Drizzle client init
    schema.ts       # sessions + messages + app_configs table definitions
  lib/
    gemini.ts       # Gemini AI client, streaming + function calling, buildSystemPrompt helper
    mcp-client.ts   # MCP server connection via Streamable HTTP transport + tool execution
    key-client.ts   # Key-service client for decrypting app keys (Gemini) and org BYOK keys (MCP)
    runs-client.ts  # RunsService HTTP client for run tracking and cost reporting
scripts/
  generate-openapi.ts  # Generates openapi.json from zod schemas via OpenApiGeneratorV3
```
