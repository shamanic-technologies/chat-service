# Chat Service - Claude Agent Instructions

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

## Project Overview

- Express + TypeScript service streaming Gemini AI responses via SSE
- MCP tool calling via `@modelcontextprotocol/sdk`
- PostgreSQL with Drizzle ORM for sessions/messages
- Buttons extracted from AI response for quick-reply UX

## Code Conventions

- TypeScript strict mode, ESM modules
- Functional patterns over classes
- Keep solutions simple, no over-engineering
- Tests in `tests/` with vitest
