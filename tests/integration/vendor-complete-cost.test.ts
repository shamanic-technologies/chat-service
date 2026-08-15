import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";

// Direct-vendor completions (deepseek / zai / moonshot) end-to-end on both
// completion routes: the right vendor is reached at the right URL with the
// right model id, and the spend is declared under catalog names that match the
// costs-service rows — including the CACHE SPLIT, which is the whole economic
// point of calling the vendors directly.

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
process.env.API_SERVICE_URL = process.env.API_SERVICE_URL || "https://api.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";
process.env.BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY || "test-billing-key";
process.env.BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "https://billing.test.local";

interface MockRoute {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { ok: boolean; status?: number; body: unknown };
}

interface CostItem {
  costName: string;
  quantity: number;
  status?: string;
  costSource?: string;
}

let routes: MockRoute[] = [];
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function buildResponse(out: { ok: boolean; status?: number; body: unknown }): Response {
  return {
    ok: out.ok,
    status: out.status ?? (out.ok ? 200 : 500),
    json: () => Promise.resolve(out.body),
    text: () =>
      Promise.resolve(typeof out.body === "string" ? out.body : JSON.stringify(out.body)),
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

function mockRunsCostRoutes(cap: { postedItems: CostItem[][]; patchedStatuses: string[] }) {
  return [
    {
      match: (url: string, init?: RequestInit) =>
        /\/v1\/runs\/[^/]+\/costs$/.test(url) && (init?.method ?? "GET") === "POST",
      respond: (_url: string, init?: RequestInit) => {
        const items = init?.body
          ? (JSON.parse(init.body as string) as { items: CostItem[] }).items
          : [];
        cap.postedItems.push(items);
        return { ok: true, status: 201, body: { costs: items.map((it, i) => ({ id: `cost-${i}`, ...it })) } };
      },
    },
    {
      match: (url: string, init?: RequestInit) =>
        /\/v1\/runs\/[^/]+\/costs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
      respond: (_url: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(init.body as string) as { status: string }) : { status: "?" };
        cap.patchedStatuses.push(body.status);
        return { ok: true, body: { id: "cost-0", status: body.status } };
      },
    },
  ] satisfies MockRoute[];
}

function mockRunsCreate() {
  return {
    match: (url: string, init?: RequestInit) => url.endsWith("/v1/runs") && (init?.method ?? "GET") === "POST",
    respond: () => ({ ok: true, status: 201, body: { id: "run-own-1", status: "running" } }),
  } satisfies MockRoute;
}

function mockRunsStatusPatch() {
  return {
    match: (url: string, init?: RequestInit) => /\/v1\/runs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
    respond: () => ({ ok: true, body: { id: "run-own-1", status: "completed" } }),
  } satisfies MockRoute;
}

/** Org-scoped key lookup for one vendor slug. Any OTHER slug stays unmocked → loud. */
function mockVendorKey(provider: string) {
  return {
    match: (url: string) => url.includes(`/keys/${provider}/decrypt`),
    respond: () => ({ ok: true, body: { provider, key: `fake-${provider}-key`, keySource: "platform" } }),
  } satisfies MockRoute;
}

function mockVendorPlatformKey(provider: string) {
  return {
    match: (url: string) => url.includes(`/keys/platform/${provider}/decrypt`),
    respond: () => ({ ok: true, body: { provider, key: `fake-${provider}-key` } }),
  } satisfies MockRoute;
}

/** Key-service rejects — the shape of an unconfigured vendor key. */
function mockVendorKeyMissing(provider: string, platform = false) {
  const path = platform ? `/keys/platform/${provider}/decrypt` : `/keys/${provider}/decrypt`;
  return {
    match: (url: string) => url.includes(path),
    respond: () => ({ ok: false, status: 404, body: { error: "Key not found" } }),
  } satisfies MockRoute;
}

function mockBilling() {
  return {
    match: (url: string, init?: RequestInit) =>
      url.includes("/v1/customer_balance/authorize") && (init?.method ?? "GET") === "POST",
    respond: () => ({ ok: true, body: { sufficient: true, balance_cents: "100000", required_cents: "1" } }),
  } satisfies MockRoute;
}

function mockPlatformRunCreate() {
  return {
    match: (url: string, init?: RequestInit) => url.endsWith("/v1/platform-runs") && (init?.method ?? "GET") === "POST",
    respond: () => ({ ok: true, status: 201, body: { id: "prun-1", status: "running" } }),
  } satisfies MockRoute;
}

function mockPlatformRunCosts(cap: { postedItems: CostItem[][] }) {
  return {
    match: (url: string, init?: RequestInit) =>
      /\/v1\/platform-runs\/[^/]+\/costs$/.test(url) && (init?.method ?? "GET") === "POST",
    respond: (_url: string, init?: RequestInit) => {
      const items = init?.body ? (JSON.parse(init.body as string) as { items: CostItem[] }).items : [];
      cap.postedItems.push(items);
      return { ok: true, status: 201, body: { costs: items.map((it, i) => ({ id: `cost-${i}`, ...it })) } };
    },
  } satisfies MockRoute;
}

function mockPlatformRunStatus() {
  return {
    match: (url: string, init?: RequestInit) =>
      /\/v1\/platform-runs\/[^/]+$/.test(url) && (init?.method ?? "GET") === "PATCH",
    respond: () => ({ ok: true, body: { id: "prun-1", status: "completed" } }),
  } satisfies MockRoute;
}

/**
 * A vendor's OpenAI-compatible chat-completions endpoint. `usage` is passed
 * verbatim so each test states the cache split in the vendor's OWN dialect.
 */
function mockVendor(
  cap: { calls: number; bodies: Array<Record<string, unknown>> },
  opts: { host: string; model: string; usage: Record<string, unknown>; content?: string },
) {
  return {
    match: (url: string) => url.startsWith(opts.host),
    respond: (_url: string, init?: RequestInit) => {
      cap.calls += 1;
      cap.bodies.push(init?.body ? JSON.parse(init.body as string) : {});
      return {
        ok: true,
        body: {
          id: "chatcmpl-1",
          model: opts.model,
          choices: [{ message: { content: opts.content ?? "vendor answer" }, finish_reason: "stop" }],
          usage: opts.usage,
        },
      };
    },
  } satisfies MockRoute;
}

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const ZAI_URL = "https://api.z.ai/api/paas/v4/chat/completions";
const MOONSHOT_URL = "https://api.moonshot.ai/v1/chat/completions";

const AUTH = { "x-api-key": "test-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "parent-run-1" };
const INTERNAL_AUTH = { "x-api-key": "test-key" };

function actualItems(posted: CostItem[][]): CostItem[] {
  const found = posted.find((items) => items.some((i) => i.status === undefined));
  expect(found).toBeDefined();
  return found!;
}

function quantityOf(items: CostItem[], costName: string): number | undefined {
  return items.find((i) => i.costName === costName)?.quantity;
}

describe("POST /complete — direct vendor routing", () => {
  let app: Awaited<ReturnType<typeof loadApp>>;
  async function loadApp() {
    vi.resetModules();
    return (await import("../../src/index.js")).default;
  }
  beforeAll(async () => {
    app = await loadApp();
  });
  beforeEach(() => {
    routes = [];
    fetchCalls = [];
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  // Each row: alias → the vendor host, the model id on the wire, the key slug,
  // and the catalog prefix. This is the acceptance criterion "a caller can
  // select any of the six models and reach the right vendor with the right
  // model id", asserted rather than assumed.
  const CASES = [
    { provider: "deepseek", model: "deepseek-flash", host: DEEPSEEK_URL, wire: "deepseek-v4-flash", prefix: "deepseek-v4-flash" },
    { provider: "deepseek", model: "deepseek-pro", host: DEEPSEEK_URL, wire: "deepseek-v4-pro", prefix: "deepseek-v4-pro" },
    { provider: "zai", model: "glm-flash", host: ZAI_URL, wire: "glm-4.7-flashx", prefix: "zai-glm-4.7-flashx" },
    { provider: "zai", model: "glm-pro", host: ZAI_URL, wire: "glm-5.2", prefix: "zai-glm-5.2" },
    { provider: "moonshot", model: "kimi-flash", host: MOONSHOT_URL, wire: "kimi-k2.6", prefix: "moonshot-kimi-k2.6" },
    { provider: "moonshot", model: "kimi-pro", host: MOONSHOT_URL, wire: "kimi-k3", prefix: "moonshot-kimi-k3" },
  ] as const;

  for (const c of CASES) {
    it(`"${c.model}" reaches ${c.provider} as "${c.wire}" and declares ${c.prefix}-* costs`, async () => {
      const cap = { postedItems: [] as CostItem[][], patchedStatuses: [] as string[] };
      const vendor = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
      routes.push(
        mockRunsCreate(),
        mockVendorKey(c.provider),
        mockBilling(),
        mockVendor(vendor, { host: c.host, model: c.wire, usage: { prompt_tokens: 30, completion_tokens: 9 } }),
        ...mockRunsCostRoutes(cap),
        mockRunsStatusPatch(),
      );

      const res = await request(app)
        .post("/complete")
        .set(AUTH)
        .send({ message: "hi", systemPrompt: "be brief", provider: c.provider, model: c.model });

      expect(res.status).toBe(200);
      expect(vendor.calls).toBe(1);

      // Right vendor URL, right model id on the wire.
      const call = fetchCalls.find((f) => f.url === c.host);
      expect(call).toBeDefined();
      expect(vendor.bodies[0].model).toBe(c.wire);
      expect(res.body.model).toBe(c.wire);

      // Right key slug — one vendor, one key.
      expect(fetchCalls.some((f) => f.url.includes(`/keys/${c.provider}/decrypt`))).toBe(true);

      // Cost names byte-equal to the costs-service catalog rows.
      expect(cap.postedItems[0].map((i) => i.costName).sort()).toEqual([
        `${c.prefix}-tokens-input`,
        `${c.prefix}-tokens-output`,
      ]);
      const actual = actualItems(cap.postedItems);
      expect(quantityOf(actual, `${c.prefix}-tokens-input`)).toBe(30);
      expect(quantityOf(actual, `${c.prefix}-tokens-output`)).toBe(9);
    });
  }

  it("does not call any other vendor's endpoint", async () => {
    const cap = { postedItems: [] as CostItem[][], patchedStatuses: [] as string[] };
    const vendor = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    routes.push(
      mockRunsCreate(),
      mockVendorKey("zai"),
      mockBilling(),
      mockVendor(vendor, { host: ZAI_URL, model: "glm-5.2", usage: { prompt_tokens: 10, completion_tokens: 2 } }),
      ...mockRunsCostRoutes(cap),
      mockRunsStatusPatch(),
    );

    await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "", provider: "zai", model: "glm-pro" });

    expect(fetchCalls.some((f) => f.url.startsWith(DEEPSEEK_URL))).toBe(false);
    expect(fetchCalls.some((f) => f.url.startsWith(MOONSHOT_URL))).toBe(false);
    // The removed gateway is gone, not demoted to a fallback.
    expect(fetchCalls.some((f) => f.url.includes("ai-gateway.vercel.sh"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Cache-hit pricing — the reason for calling the vendors directly
  // -------------------------------------------------------------------------

  it("bills DeepSeek cache hits under the cached-input name, not the miss rate", async () => {
    const cap = { postedItems: [] as CostItem[][], patchedStatuses: [] as string[] };
    const vendor = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    routes.push(
      mockRunsCreate(),
      mockVendorKey("deepseek"),
      mockBilling(),
      mockVendor(vendor, {
        host: DEEPSEEK_URL,
        model: "deepseek-v4-flash",
        // DeepSeek's own dialect: prompt_tokens = hit + miss.
        usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_cache_hit_tokens: 960, prompt_cache_miss_tokens: 40 },
      }),
      ...mockRunsCostRoutes(cap),
      mockRunsStatusPatch(),
    );

    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "big stable prompt", provider: "deepseek", model: "deepseek-flash" });

    expect(res.status).toBe(200);

    const actual = actualItems(cap.postedItems);
    // 40 fresh tokens at the miss rate, 960 at the (50x cheaper) cache rate.
    expect(quantityOf(actual, "deepseek-v4-flash-tokens-input")).toBe(40);
    expect(quantityOf(actual, "deepseek-v4-flash-tokens-cached-input")).toBe(960);
    expect(quantityOf(actual, "deepseek-v4-flash-tokens-output")).toBe(20);
    // The split is exhaustive: nothing is billed twice, nothing is dropped.
    expect(
      quantityOf(actual, "deepseek-v4-flash-tokens-input")! +
        quantityOf(actual, "deepseek-v4-flash-tokens-cached-input")!,
    ).toBe(1000);

    // The caller still sees the TOTAL prompt count; only billing is split.
    expect(res.body.tokensInput).toBe(1000);
  });

  it("bills Z.ai cache hits from prompt_tokens_details.cached_tokens", async () => {
    const cap = { postedItems: [] as CostItem[][], patchedStatuses: [] as string[] };
    const vendor = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    routes.push(
      mockRunsCreate(),
      mockVendorKey("zai"),
      mockBilling(),
      mockVendor(vendor, {
        host: ZAI_URL,
        model: "glm-5.2",
        usage: { prompt_tokens: 800, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 750 } },
      }),
      ...mockRunsCostRoutes(cap),
      mockRunsStatusPatch(),
    );

    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "big stable prompt", provider: "zai", model: "glm-pro" });

    expect(res.status).toBe(200);
    const actual = actualItems(cap.postedItems);
    expect(quantityOf(actual, "zai-glm-5.2-tokens-input")).toBe(50);
    expect(quantityOf(actual, "zai-glm-5.2-tokens-cached-input")).toBe(750);
  });

  it("bills Moonshot cache hits from the flat cached_tokens field", async () => {
    const cap = { postedItems: [] as CostItem[][], patchedStatuses: [] as string[] };
    const vendor = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    routes.push(
      mockRunsCreate(),
      mockVendorKey("moonshot"),
      mockBilling(),
      mockVendor(vendor, {
        host: MOONSHOT_URL,
        model: "kimi-k3",
        usage: { prompt_tokens: 600, completion_tokens: 11, cached_tokens: 540 },
      }),
      ...mockRunsCostRoutes(cap),
      mockRunsStatusPatch(),
    );

    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "big stable prompt", provider: "moonshot", model: "kimi-pro" });

    expect(res.status).toBe(200);
    const actual = actualItems(cap.postedItems);
    expect(quantityOf(actual, "moonshot-kimi-k3-tokens-input")).toBe(60);
    expect(quantityOf(actual, "moonshot-kimi-k3-tokens-cached-input")).toBe(540);
  });

  it("declares NO cached-input row when the vendor reported no cache hit", async () => {
    // A zero-quantity row on a name that may not be seeded yet buys nothing;
    // the cached name is only ever exercised when there IS a cache hit.
    const cap = { postedItems: [] as CostItem[][], patchedStatuses: [] as string[] };
    const vendor = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    routes.push(
      mockRunsCreate(),
      mockVendorKey("deepseek"),
      mockBilling(),
      mockVendor(vendor, {
        host: DEEPSEEK_URL,
        model: "deepseek-v4-flash",
        usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 },
      }),
      ...mockRunsCostRoutes(cap),
      mockRunsStatusPatch(),
    );

    await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "", provider: "deepseek", model: "deepseek-flash" });

    const actual = actualItems(cap.postedItems);
    expect(actual.some((i) => i.costName.endsWith("-tokens-cached-input"))).toBe(false);
    expect(quantityOf(actual, "deepseek-v4-flash-tokens-input")).toBe(100);
  });

  it("leaves the Gemini declaration untouched — no cached row on a native path", async () => {
    const cap = { postedItems: [] as CostItem[][], patchedStatuses: [] as string[] };
    routes.push(
      mockRunsCreate(),
      {
        match: (url: string) => url.includes("/keys/google/decrypt"),
        respond: () => ({ ok: true, body: { provider: "google", key: "fake-google-key", keySource: "platform" } }),
      },
      mockBilling(),
      {
        match: (url: string) => url.includes(":generateContent"),
        respond: () => ({
          ok: true,
          body: {
            candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          },
        }),
      },
      ...mockRunsCostRoutes(cap),
      mockRunsStatusPatch(),
    );

    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "", provider: "google", model: "flash" });

    expect(res.status).toBe(200);
    const actual = actualItems(cap.postedItems);
    expect(actual.some((i) => i.costName.endsWith("-tokens-cached-input"))).toBe(false);
    expect(quantityOf(actual, "google-flash-lite-3.5-tokens-input")).toBe(10);
  });

  // -------------------------------------------------------------------------
  // Rejections
  // -------------------------------------------------------------------------

  it("rejects webSearch on a vendor path, naming the vendor", async () => {
    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "", provider: "moonshot", model: "kimi-pro", webSearch: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider "moonshot" \(Moonshot \(Kimi\)\) does not support webSearch/);
    // Rejected before any spend: no run, no key, no vendor call.
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects imageUrl on a vendor path, naming the vendor", async () => {
    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({
        message: "hi",
        systemPrompt: "",
        provider: "zai",
        model: "glm-pro",
        imageUrl: "https://example.com/a.png",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider "zai" \(Z\.ai\) does not support imageUrl/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects the removed gateway provider with the accepted set", async () => {
    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "", provider: "vercel", model: "deepseek-flash" });

    expect(res.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });

  it("says WHICH vendor is unconfigured when its key is missing", async () => {
    routes.push(mockRunsCreate(), mockVendorKeyMissing("zai"), mockBilling());

    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "", provider: "zai", model: "glm-pro" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Z\.ai API key \(key-service provider "zai"\)/);
    // Not a generic failure, and not another vendor's name.
    expect(res.body.error).not.toContain("deepseek");
    expect(res.body.error).not.toContain("moonshot");
  });

  it("fails loud when the vendor is down — no substitute model, no substitute vendor", async () => {
    const cap = { postedItems: [] as CostItem[][], patchedStatuses: [] as string[] };
    routes.push(
      mockRunsCreate(),
      mockVendorKey("deepseek"),
      mockBilling(),
      {
        match: (url: string) => url.startsWith(DEEPSEEK_URL),
        respond: () => ({ ok: false, status: 503, body: "service unavailable" }),
      },
      ...mockRunsCostRoutes(cap),
      mockRunsStatusPatch(),
    );

    const res = await request(app)
      .post("/complete")
      .set(AUTH)
      .send({ message: "hi", systemPrompt: "", provider: "deepseek", model: "deepseek-flash" });

    expect(res.status).toBe(502);
    expect(fetchCalls.some((f) => f.url.startsWith(ZAI_URL))).toBe(false);
    expect(fetchCalls.some((f) => f.url.startsWith(MOONSHOT_URL))).toBe(false);
    expect(fetchCalls.some((f) => f.url.includes("generativelanguage.googleapis.com"))).toBe(false);
  });
});

describe("POST /internal/platform-complete — direct vendor routing", () => {
  let app: Awaited<ReturnType<typeof loadApp>>;
  async function loadApp() {
    vi.resetModules();
    return (await import("../../src/index.js")).default;
  }
  beforeAll(async () => {
    app = await loadApp();
  });
  beforeEach(() => {
    routes = [];
    fetchCalls = [];
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  it("reaches the vendor with its platform key and declares actual costs with the cache split", async () => {
    const costCap = { postedItems: [] as CostItem[][] };
    const vendor = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    routes.push(
      mockVendorPlatformKey("moonshot"),
      mockPlatformRunCreate(),
      mockPlatformRunCosts(costCap),
      mockPlatformRunStatus(),
      mockVendor(vendor, {
        host: MOONSHOT_URL,
        model: "kimi-k2.6",
        usage: { prompt_tokens: 400, completion_tokens: 25, cached_tokens: 360 },
      }),
    );

    const res = await request(app)
      .post("/internal/platform-complete")
      .set(INTERNAL_AUTH)
      .send({ message: "hi", systemPrompt: "be brief", provider: "moonshot", model: "kimi-flash" });

    expect(res.status).toBe(200);
    expect(vendor.calls).toBe(1);
    expect(vendor.bodies[0].model).toBe("kimi-k2.6");

    const actual = costCap.postedItems[0];
    expect(quantityOf(actual, "moonshot-kimi-k2.6-tokens-input")).toBe(40);
    expect(quantityOf(actual, "moonshot-kimi-k2.6-tokens-cached-input")).toBe(360);
    expect(quantityOf(actual, "moonshot-kimi-k2.6-tokens-output")).toBe(25);
    // Platform runs post actuals only — no provision, no hold.
    expect(actual.every((i) => i.status === undefined)).toBe(true);
    expect(actual.every((i) => i.costSource === "platform")).toBe(true);
  });

  it("says WHICH vendor platform key is missing", async () => {
    routes.push(mockVendorKeyMissing("deepseek", true));

    const res = await request(app)
      .post("/internal/platform-complete")
      .set(INTERNAL_AUTH)
      .send({ message: "hi", systemPrompt: "", provider: "deepseek", model: "deepseek-pro" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/DeepSeek API key \(key-service provider "deepseek"\)/);
  });

  it("rejects webSearch on a vendor path before creating a platform run", async () => {
    const res = await request(app)
      .post("/internal/platform-complete")
      .set(INTERNAL_AUTH)
      .send({ message: "hi", systemPrompt: "", provider: "deepseek", model: "deepseek-pro", webSearch: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider "deepseek" \(DeepSeek\) does not support webSearch/);
    expect(fetchCalls).toHaveLength(0);
  });
});
