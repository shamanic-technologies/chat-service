import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";

// Regression: /complete and /internal/platform-complete must reject Anthropic
// JSON mode without `responseSchema` with a 400 — Anthropic API has no native
// standalone JSON mode, so enforcement requires `output_config.format`. The
// rejection fires before key resolution, billing, and run creation, so no
// external service mocks are required for this test.

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

describe("POST /complete — Anthropic JSON mode requires responseSchema", () => {
  it("returns 400 when provider=anthropic + responseFormat=json + no responseSchema", async () => {
    const { default: app } = await import("../../src/index.js");
    const res = await request(app)
      .post("/complete")
      .set(AUTH_HEADERS)
      .send({
        message: "Hello",
        systemPrompt: "You are helpful.",
        provider: "anthropic",
        model: "sonnet",
        responseFormat: "json",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Anthropic JSON mode requires responseSchema");
  });
});

describe("POST /internal/platform-complete — Anthropic JSON mode requires responseSchema", () => {
  it("returns 400 when provider=anthropic + responseFormat=json + no responseSchema", async () => {
    const { default: app } = await import("../../src/index.js");
    const res = await request(app)
      .post("/internal/platform-complete")
      .set("x-api-key", "test-internal-key")
      .send({
        message: "Hello",
        systemPrompt: "You are helpful.",
        provider: "anthropic",
        model: "sonnet",
        responseFormat: "json",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Anthropic JSON mode requires responseSchema");
  });
});
