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
