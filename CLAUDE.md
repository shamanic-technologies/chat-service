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

- `src/index.ts` — Express server, `/chat`, `/apps/:appId/config`, `/health`, `/openapi.json`
- `src/schemas.ts` — Zod schemas (source of truth for validation + OpenAPI)
- `src/types.ts` — SSE event TypeScript interfaces
- `src/middleware/auth.ts` — Auth middleware (Authorization Bearer + x-org-id + x-user-id)
- `src/db/schema.ts` — Drizzle table definitions (sessions, messages, app_configs)
- `src/db/index.ts` — Drizzle client init
- `src/lib/gemini.ts` — Gemini AI client, streaming + function calling
- `src/lib/mcp-client.ts` — MCP server connection via Streamable HTTP + tool execution
- `src/lib/key-client.ts` — Key-service client for app-key and org-key decryption
- `src/lib/runs-client.ts` — RunsService HTTP client for run tracking and cost reporting
- `scripts/generate-openapi.ts` — Generates openapi.json from Zod schemas
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually

## Code Conventions

- TypeScript strict mode, ESM modules
- Functional patterns over classes
- Keep solutions simple, no over-engineering
- Tests in `tests/` with vitest
