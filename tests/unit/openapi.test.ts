import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..", "..");
const openapiPath = join(projectRoot, "openapi.json");

beforeAll(() => {
  execSync("npx tsx scripts/generate-openapi.ts", { cwd: projectRoot });
});

describe("openapi.json", () => {
  it("openapi.json is generated", () => {
    expect(existsSync(openapiPath)).toBe(true);
  });

  it("is valid OpenAPI 3.0", () => {
    const spec = JSON.parse(readFileSync(openapiPath, "utf-8"));
    expect(spec.openapi).toBe("3.0.0");
  });

  it("has correct service info", () => {
    const spec = JSON.parse(readFileSync(openapiPath, "utf-8"));
    expect(spec.info.title).toBe("Chat Service");
    expect(spec.info.version).toBe("1.0.0");
  });

  it("documents GET /health", () => {
    const spec = JSON.parse(readFileSync(openapiPath, "utf-8"));
    expect(spec.paths["/health"]).toBeDefined();
    expect(spec.paths["/health"].get).toBeDefined();
    expect(spec.paths["/health"].get.responses["200"]).toBeDefined();
  });

  it("documents POST /chat with request body and responses", () => {
    const spec = JSON.parse(readFileSync(openapiPath, "utf-8"));
    const chat = spec.paths["/chat"]?.post;
    expect(chat).toBeDefined();
    expect(chat.requestBody.content["application/json"]).toBeDefined();
    expect(chat.responses["200"]).toBeDefined();
    expect(chat.responses["401"]).toBeDefined();
    expect(chat.responses["400"]).toBeDefined();
  });

  it("does not expose /openapi.json as a documented path", () => {
    const spec = JSON.parse(readFileSync(openapiPath, "utf-8"));
    expect(spec.paths["/openapi.json"]).toBeUndefined();
  });

  it("includes component schemas from zod definitions", () => {
    const spec = JSON.parse(readFileSync(openapiPath, "utf-8"));
    expect(spec.components?.schemas?.ChatRequest).toBeDefined();
    expect(spec.components?.schemas?.HealthResponse).toBeDefined();
    expect(spec.components?.schemas?.ErrorResponse).toBeDefined();
  });

  it("ChatRequest schema requires message field", () => {
    const spec = JSON.parse(readFileSync(openapiPath, "utf-8"));
    const chatReq = spec.components.schemas.ChatRequest;
    expect(chatReq.required).toContain("message");
    expect(chatReq.properties.message.type).toBe("string");
    expect(chatReq.properties.sessionId.type).toBe("string");
  });
});
