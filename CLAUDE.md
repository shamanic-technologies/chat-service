# Project: chat-service

Backend chat service powering Foxy, the MCP Factory AI assistant. Streams Gemini AI responses via SSE with MCP tool calling support.

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

## Architecture

- `src/index.ts` — Express server, `/chat`, `/health`, and `/openapi.json` endpoints
- `src/schemas.ts` — Zod schemas (source of truth for validation + OpenAPI)
- `src/types.ts` — SSE event TypeScript interfaces
- `src/db/schema.ts` — Drizzle table definitions (sessions + messages)
- `src/db/index.ts` — Drizzle client init
- `src/lib/gemini.ts` — Gemini AI client, streaming + function calling
- `src/lib/mcp-client.ts` — MCP server connection via Streamable HTTP + tool execution
- `src/lib/runs-client.ts` — RunsService HTTP client for run tracking and cost reporting
- `scripts/generate-openapi.ts` — Generates openapi.json from Zod schemas
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually
