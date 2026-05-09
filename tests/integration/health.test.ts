import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";

// NODE_ENV=test prevents app.listen() at module load (see src/index.ts bottom).
beforeAll(() => {
  process.env.NODE_ENV = "test";
});

describe("GET /health", () => {
  it("returns 200 with {status: 'ok'}", async () => {
    const { default: app } = await import("../../src/index.js");
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
