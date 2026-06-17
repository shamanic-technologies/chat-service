import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
process.env.API_SERVICE_URL = process.env.API_SERVICE_URL || "https://api.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";

interface MockRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { ok: boolean; status?: number; body: unknown; text?: string };
}

let routes: MockRoute[] = [];
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

const sessionId = "00000000-0000-4000-8000-000000000101";
const runId = "00000000-0000-4000-8000-000000000102";
const brandId = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";

vi.mock("../../src/db/index.js", () => {
  const brandProfileConfig = {
    id: "cfg-brand-profile",
    orgId: "org-1",
    key: "brand-profile-editor",
    systemPrompt: "Brand profile editor.",
    allowedTools: [
      "request_user_input",
      "get_brand_profile",
      "save_brand_profile_version",
      "refresh_brand_profile_from_website",
    ],
    provider: "google",
    model: "flash-pro",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([brandProfileConfig])),
          limit: vi.fn(() => Promise.resolve([brandProfileConfig])),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: sessionId }])),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      })),
      query: {
        messages: {
          findMany: vi.fn(() => Promise.resolve([])),
        },
      },
    },
  };
});

function buildResponse(out: { ok: boolean; status?: number; body: unknown; text?: string }): Response {
  const text = out.text ?? (typeof out.body === "string" ? out.body : JSON.stringify(out.body));
  return {
    ok: out.ok,
    status: out.status ?? (out.ok ? 200 : 500),
    json: () => Promise.resolve(out.body),
    text: () => Promise.resolve(text),
    headers: new Headers(),
  } as unknown as Response;
}

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });
      for (const route of routes) {
        if (route.match(url, init)) return buildResponse(route.respond(url, init));
      }
      throw new Error(`[test] Unmocked fetch: ${url}`);
    }),
  );
}

function mockKeyDecrypt() {
  return {
    match: (url: string) => url.includes("/keys/google/decrypt"),
    respond: () => ({ ok: true, body: { provider: "google", key: "fake-google-key", keySource: "platform" } }),
  } satisfies MockRoute;
}

function mockRunCreate() {
  return {
    match: (url: string, init?: RequestInit) => url.endsWith("/v1/runs") && (init?.method ?? "GET") === "POST",
    respond: () => ({ ok: true, status: 201, body: { id: runId, status: "running" } }),
  } satisfies MockRoute;
}

function mockRunPatch() {
  return {
    match: (url: string, init?: RequestInit) => /\/v1\/runs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
    respond: () => ({ ok: true, body: { id: runId, status: "completed" } }),
  } satisfies MockRoute;
}

function mockTraceEvents() {
  return {
    match: (url: string, init?: RequestInit) => /\/v1\/runs\/[^/]+\/events$/.test(url) && (init?.method ?? "GET") === "POST",
    respond: () => ({ ok: true, status: 201, body: { id: "evt-1" } }),
  } satisfies MockRoute;
}

function mockBrandProfileGet() {
  return {
    match: (url: string, init?: RequestInit) =>
      url === `https://api.test.local/v1/brands/${brandId}/brand-profile` &&
      (init?.method ?? "GET") === "GET",
    respond: () => ({
      ok: true,
      body: {
        current: {
          id: "v2",
          brandId,
          version: 2,
          fields: {
            valueProposition: "Old value",
            differentiators: ["Old diff"],
            tone: "Clear",
          },
          createdAt: "2026-06-01T00:00:00Z",
        },
        versions: [{ id: "v2", version: 2, createdAt: "2026-06-01T00:00:00Z" }],
      },
    }),
  } satisfies MockRoute;
}

function mockExtractFields() {
  return {
    match: (url: string, init?: RequestInit) =>
      url === "https://api.test.local/v1/brands/extract-fields" &&
      (init?.method ?? "GET") === "POST",
    respond: () => ({
      ok: true,
      body: {
        brands: [{ brandId, domain: "example.com", name: "Example", brandUrl: "https://example.com" }],
        fields: {
          valueProposition: {
            value: "New value from website",
            byBrand: {
              "example.com": {
                value: "New value from website",
                cached: false,
                extractedAt: "2026-06-17T00:00:00Z",
                expiresAt: null,
                sourceUrls: ["https://example.com"],
              },
            },
          },
          differentiators: {
            value: ["Faster setup", "Better analytics"],
            byBrand: {},
          },
        },
      },
    }),
  } satisfies MockRoute;
}

function mockBrandProfileSave() {
  return {
    match: (url: string, init?: RequestInit) =>
      url === `https://api.test.local/v1/brands/${brandId}/brand-profile` &&
      (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 201,
      body: {
        version: {
          id: "v3",
          brandId,
          version: 3,
          fields: JSON.parse(init?.body as string).fields,
          createdAt: "2026-06-17T00:00:00Z",
        },
      },
    }),
  } satisfies MockRoute;
}

const AUTH = {
  "x-api-key": "test-key",
  "x-org-id": "org-1",
  "x-user-id": "user-1",
  "x-run-id": "parent-run-1",
};

describe("POST /chat — brand-profile-editor website refresh", () => {
  beforeEach(() => {
    vi.resetModules();
    routes = [];
    fetchCalls = [];
    installFetchMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loadApp() {
    return (await import("../../src/index.js")).default;
  }

  it("saves a new brand-profile version for a latest-website update intent", async () => {
    const app = await loadApp();
    routes.push(
      mockKeyDecrypt(),
      mockRunCreate(),
      mockRunPatch(),
      mockTraceEvents(),
      mockBrandProfileGet(),
      mockExtractFields(),
      mockBrandProfileSave(),
    );

    const res = await request(app)
      .post("/chat")
      .set(AUTH)
      .send({
        configKey: "brand-profile-editor",
        message: "Mets a jour avec mon dernier site web",
        context: {
          brandId,
          fieldDefinitions: [
            { key: "valueProposition", description: "The brand value proposition" },
            { key: "differentiators", description: "List of differentiators", type: "list" },
          ],
        },
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain("refresh_brand_profile_from_website");
    expect(res.text).toContain("Saved brand profile v3");
    expect(res.text).toContain("Updated fields: valueProposition, differentiators.");

    const extractCall = fetchCalls.find((call) => call.url.endsWith("/v1/brands/extract-fields"));
    expect(JSON.parse(extractCall?.init?.body as string)).toEqual({
      brandIds: [brandId],
      fields: [
        { key: "valueProposition", description: "The brand value proposition" },
        { key: "differentiators", description: "List of differentiators" },
        { key: "tone", description: 'Brand profile field "tone" from the brand\'s current website.' },
      ],
      resetCache: true,
    });

    const saveCall = fetchCalls.find(
      (call) =>
        call.url === `https://api.test.local/v1/brands/${brandId}/brand-profile` &&
        call.init?.method === "POST",
    );
    expect(JSON.parse(saveCall?.init?.body as string)).toEqual({
      fields: {
        valueProposition: "New value from website",
        differentiators: ["Faster setup", "Better analytics"],
        tone: "Clear",
      },
    });
  });
});
