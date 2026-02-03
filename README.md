# Chat Service

Backend chat service powering Foxy, the MCP Factory AI assistant. Streams Gemini AI responses via SSE with MCP tool calling support.

## Quick Start

```bash
cp .env.example .env   # fill in your keys
npm install
npm run dev            # starts on port 3002
```

## SSE Protocol

`POST /chat` with headers `Content-Type: application/json` and `X-API-Key: <your-key>`.

Request body:
```json
{ "message": "Hello", "sessionId": "optional-uuid" }
```

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

## Rendering Buttons on the Frontend

Listen for the `{"type":"buttons"}` SSE event. It arrives **after** all token streaming is complete and **before** `[DONE]`. Each button has a `label` (display text) and `value` (text to send back as the next user message). Only render buttons when `buttons.length > 0`.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Google Gemini API key |
| `CHAT_SERVICE_DATABASE_URL` | Yes | PostgreSQL connection string |
| `MCP_SERVER_URL` | No | MCP server endpoint (default: `https://mcp.mcpfactory.org`) |
| `PORT` | No | Server port (default: `3002`) |

## Database

Uses PostgreSQL via Drizzle ORM. Two tables:

- **sessions** - conversation sessions scoped by `orgId` (from the API key)
- **messages** - chat messages with role, content, optional `toolCalls` and `buttons` JSONB

Migrations run automatically on server start. To generate new migrations after schema changes:

```bash
npm run db:generate
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
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

**CI secrets/variables:**
- `NEON_API_KEY` (secret) — Neon API key for branch creation/deletion
- `NEON_PROJECT_ID` (variable) — Neon project ID (`billowing-art-88336019`)
- `CHAT_SERVICE_DATABASE_URL_DEV` (secret) — dev database connection string

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
  index.ts          # Express server, /chat and /health endpoints
  types.ts          # Request/response TypeScript interfaces
  db/
    index.ts        # Drizzle client init
    schema.ts       # sessions + messages table definitions
  lib/
    gemini.ts       # Gemini AI client, streaming + function calling
    mcp-client.ts   # MCP server connection via Streamable HTTP transport + tool execution
```
