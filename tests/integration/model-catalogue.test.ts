import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";

// NODE_ENV=test prevents app.listen() at module load (see src/index.ts bottom).
beforeAll(() => {
  process.env.NODE_ENV = "test";
});

describe("GET /internal/models", () => {
  it("requires the service API key", async () => {
    const { default: app } = await import("../../src/index.js");
    const res = await request(app).get("/internal/models");
    expect(res.status).toBe(401);
  });

  it("serves every alias with its capability tier", async () => {
    const { default: app } = await import("../../src/index.js");
    const { PROVIDER_MODELS } = await import("../../src/lib/anthropic.js");

    const res = await request(app).get("/internal/models").set("x-api-key", "test-key");
    expect(res.status).toBe(200);

    const models = res.body.models as Array<{
      provider: string;
      model: string;
      capabilityTier: string;
    }>;
    const expected = Object.entries(PROVIDER_MODELS).flatMap(([p, aliases]) =>
      (aliases as readonly string[]).map((m) => `${p}/${m}`),
    );
    expect(models.map((m) => `${m.provider}/${m.model}`).sort()).toEqual(expected.sort());
    for (const m of models) {
      expect(["cheap", "strong", "frontier"]).toContain(m.capabilityTier);
    }
  });

  it("reports flash-pro as cheap over the wire", async () => {
    const { default: app } = await import("../../src/index.js");
    const res = await request(app).get("/internal/models").set("x-api-key", "test-key");
    const flashPro = (res.body.models as Array<Record<string, string>>).find(
      (m) => m.provider === "google" && m.model === "flash-pro",
    );
    expect(flashPro?.capabilityTier).toBe("cheap");
  });
});
