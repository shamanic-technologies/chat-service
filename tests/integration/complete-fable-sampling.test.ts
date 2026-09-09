import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";

// Regression for the `fable` alias (Claude Fable 5.1, added 2026-09-09).
//
// Anthropic removed the sampling parameters on its always-thinking models, so
// `temperature` is a hard 400 there while it stays a live, honoured field on
// every other alias this service reaches. The failure mode this guards is a
// caller A/B-ing a template: they take a request body that works against
// `sonnet`, swap the model to `fable`, and would otherwise pay for a cost hold
// and then read an Anthropic 400 that names neither the alias nor the field.
//
// The rejection fires before key resolution, cost provisioning and run
// creation, so this needs no external mocks — which is also the point of it
// living at the route rather than only inside the client.

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
  process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
  process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
  process.env.API_SERVICE_URL = process.env.API_SERVICE_URL || "https://api.test.local";
  process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
  process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";
});

const AUTH_HEADERS = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "run-1",
};

const ROUTES = [
  { path: "/complete", headers: AUTH_HEADERS },
  { path: "/internal/platform-complete", headers: { "x-api-key": "test-internal-key" } },
] as const;

for (const { path, headers } of ROUTES) {
  describe(`POST ${path} — Claude Fable 5.1 rejects sampling parameters`, () => {
    it("returns 400, not retryable, naming the field and the aliases that accept it", async () => {
      const { default: app } = await import("../../src/index.js");
      const res = await request(app)
        .post(path)
        .set(headers)
        .send({
          message: "Write three cold emails.",
          systemPrompt: "You are a cold-email writer.",
          provider: "anthropic",
          model: "fable",
          temperature: 0.3,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("claude-fable-5-1");
      expect(res.body.error).toContain("temperature");
      expect(res.body.detail).toContain("haiku, sonnet, opus");
      expect(res.body.retryable).toBe(false);
    });

    // The complement — that the guard is scoped to this ONE model and lets a
    // `fable` call without temperature (and a `sonnet` call with one) through —
    // is asserted in tests/unit/fable-astra-aliases.test.ts against the same
    // `anthropicRejectsSampling` data the route reads. Doing it here would need
    // the request to reach key-service, which this suite deliberately does not.
  });
}
