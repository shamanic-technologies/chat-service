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

describe("GET /internal/model-dynasties", () => {
  it("requires the service API key", async () => {
    const { default: app } = await import("../../src/index.js");
    const res = await request(app).get("/internal/model-dynasties");
    expect(res.status).toBe(401);
  });

  it("serves every LLM dynasty with its head, versions and legacy aliases", async () => {
    const { default: app } = await import("../../src/index.js");
    const res = await request(app).get("/internal/model-dynasties").set("x-api-key", "test-key");
    expect(res.status).toBe(200);
    const dynasties = res.body.dynasties as Array<Record<string, unknown>>;
    expect(dynasties).toHaveLength(16);
    const lite = dynasties.find((d) => d.slug === "gemini-flash-lite")!;
    expect(lite).toMatchObject({ headModelId: "gemini-3.5-flash-lite", servedToday: true, legacyAliases: ["flash", "flash-lite"] });
  });

  it("stamps the dynasty on every model id, served and retired", async () => {
    const { default: app } = await import("../../src/index.js");
    const res = await request(app).get("/internal/model-ids").set("x-api-key", "test-key");
    const rows = res.body.models as Array<{ modelId: string; dynasty: string }>;
    for (const r of rows) expect(r.dynasty, r.modelId).toMatch(/^[a-z0-9-]+$/);
    expect(rows.find((r) => r.modelId === "gemini-3.1-flash-lite")).toMatchObject({ dynasty: "gemini-flash-lite", servedToday: false });
  });
});
