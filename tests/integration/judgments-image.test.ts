import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import sharp from "sharp";

// IMAGE-JUDGE-1021: the judgments door judges an IMAGE against the caller's
// own question, through the judge the caller names (Jev by default, or OpenAI
// Decisions gpt-6-luna), with the spend declared under that judge's cost name.

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";

const IMAGE_URL = "https://pub.test.r2.dev/lead-qualification/underdogroofing.com.png";
let screenshot: Buffer;

type Out = { ok: boolean; status?: number; body: unknown; bytes?: Buffer };
type Route = { match: (url: string, init?: RequestInit) => boolean; respond: (url: string, init?: RequestInit) => Out };
let routes: Route[] = [];
type PostedCost = { costName: string; quantity: number; costSource?: string };

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      for (const r of routes) {
        if (!r.match(url, init)) continue;
        const out = r.respond(url, init);
        return {
          ok: out.ok,
          status: out.status ?? (out.ok ? 200 : 500),
          json: () => Promise.resolve(out.body),
          text: () => Promise.resolve(typeof out.body === "string" ? out.body : JSON.stringify(out.body)),
          arrayBuffer: () => Promise.resolve(out.bytes ?? Buffer.alloc(0)),
          headers: new Headers(),
        } as unknown as Response;
      }
      throw new Error(`[test] Unmocked fetch: ${url}`);
    }),
  );
}

function platformRuns(cap: { costs: PostedCost[][]; statuses: string[] }): Route[] {
  return [
    {
      match: (u, i) => u.endsWith("/v1/platform-runs") && i?.method === "POST",
      respond: () => ({ ok: true, status: 201, body: { id: "prun-img-1", status: "running" } }),
    },
    {
      match: (u, i) => /\/v1\/platform-runs\/[^/]+\/costs$/.test(u) && i?.method === "POST",
      respond: (_u, i) => {
        const items = (JSON.parse(i!.body as string) as { items: PostedCost[] }).items;
        cap.costs.push(items);
        return { ok: true, status: 201, body: { costs: items.map((it, n) => ({ id: `c-${n}`, ...it })) } };
      },
    },
    {
      match: (u, i) => /\/v1\/platform-runs\/[^/]+$/.test(u) && i?.method === "PATCH",
      respond: (_u, i) => {
        cap.statuses.push((JSON.parse(i!.body as string) as { status: string }).status);
        return { ok: true, body: {} };
      },
    },
  ];
}

const imageRoute = (status = 200): Route => ({
  match: (u) => u === IMAGE_URL,
  respond: () => (status === 200 ? { ok: true, body: null, bytes: screenshot } : { ok: false, status, body: "nope" }),
});

const keyRoute = (provider: string): Route => ({
  match: (u) => u.includes(`/keys/platform/${provider}/decrypt`),
  respond: () => ({ ok: true, body: { provider, key: `fake-${provider}-key` } }),
});

const QUESTION = "Is there no clearly visible phone number in the header of the homepage above the fold?";
const BODY = { image: { url: IMAGE_URL }, questions: { no_phone: { type: "noul", instructions: QUESTION } } };
const AUTH = { "x-api-key": "test-key" };

describe("POST /internal/platform-judgments — image", () => {
  let app: Awaited<ReturnType<typeof loadApp>>;
  async function loadApp() {
    vi.resetModules();
    return (await import("../../src/index.js")).default;
  }
  beforeAll(async () => {
    screenshot = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#123456" } })
      .png()
      .toBuffer();
    app = await loadApp();
  });
  beforeEach(() => {
    routes = [];
    installFetchMock();
  });
  afterEach(() => vi.restoreAllMocks());

  it("Jev (default): the resized screenshot travels as an asset with the image header, cost under the Jev name", async () => {
    const cap = { costs: [] as PostedCost[][], statuses: [] as string[] };
    const sent: { body?: Record<string, unknown>; headers?: Record<string, string> } = {};
    routes.push(imageRoute(), keyRoute("typesafe"), ...platformRuns(cap), {
      match: (u) => u.startsWith("https://api.typesafe.ai/v1/systemone"),
      respond: (_u, i) => {
        sent.body = JSON.parse(i!.body as string);
        sent.headers = i!.headers as Record<string, string>;
        return {
          ok: true,
          body: {
            model: "jev-1.13.0",
            answers: { no_phone: { type: "noul", noul: 0.01 } },
            usage: { input_tokens: 3880, output_tokens: 20 },
          },
        };
      },
    });

    const res = await request(app).post("/internal/platform-judgments").set(AUTH).send(BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      judge: "jev",
      model: "jev-1.13.0",
      answers: { no_phone: { type: "noul", noul: 0.01 } },
      usage: { inputTokens: 3880, outputTokens: 20 },
      runId: "prun-img-1",
    });
    expect(sent.headers!["TypeSafe-Danger-Zone-Images"]).toBe("true");
    const ref = sent.body!.state as string;
    const asset = (sent.body!.assets as Record<string, { data_base64: string; format: string }>)[ref]!;
    expect(asset.format).toBe("png");
    const meta = await sharp(Buffer.from(asset.data_base64, "base64")).metadata();
    expect([meta.width, meta.height]).toEqual([1568, 882]);
    expect(cap.costs).toEqual([[{ costName: "typesafe-jev-1.13-tokens-input", quantity: 3880, costSource: "platform" }]]);
    expect(cap.statuses).toEqual(["completed"]);
  });

  it("judge openai-luna: same pixels as a data URL, the OpenAI key, cost under the Luna Decisions name", async () => {
    const cap = { costs: [] as PostedCost[][], statuses: [] as string[] };
    const sent: { body?: Record<string, unknown> } = {};
    routes.push(imageRoute(), keyRoute("openai"), ...platformRuns(cap), {
      match: (u) => u === "https://api.openai.com/v1/decisions",
      respond: (_u, i) => {
        sent.body = JSON.parse(i!.body as string);
        return {
          ok: true,
          body: {
            model: "gpt-6-luna",
            answers: [{ type: "predicate", name: "no_phone", probability: 0.48 }],
            usage: { input_tokens: 1656, output_tokens: 0 },
          },
        };
      },
    });

    const res = await request(app)
      .post("/internal/platform-judgments")
      .set(AUTH)
      .send({ ...BODY, judge: "openai-luna" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      judge: "openai-luna",
      model: "gpt-6-luna",
      answers: { no_phone: { type: "noul", noul: 0.48 } },
      usage: { inputTokens: 1656, outputTokens: 0 },
      runId: "prun-img-1",
    });
    expect(sent.body!.model).toBe("gpt-6-luna");
    expect(sent.body!.questions).toEqual([{ type: "predicate", name: "no_phone", instructions: QUESTION }]);
    const content = (sent.body!.input as Array<{ content: Array<{ type: string; image_url?: string }> }>)[0]!.content;
    expect(content).toHaveLength(1);
    expect(content[0]!.image_url).toMatch(/^data:image\/png;base64,/);
    expect(cap.costs).toEqual([
      [{ costName: "openai-gpt-6-luna-decisions-tokens-input", quantity: 1656, costSource: "platform" }],
    ]);
  });

  it("judge cloudflare-clef-flash: same pixels as base64, the Workers AI key + account, cost under the Clef-flash name", async () => {
    const cap = { costs: [] as PostedCost[][], statuses: [] as string[] };
    const sent: { url?: string; body?: Record<string, unknown> } = {};
    routes.push(imageRoute(), keyRoute("cloudflare-workers-ai"), {
      match: (u) => u.includes("/keys/platform/cloudflare-workers-ai-account-id/decrypt"),
      respond: () => ({ ok: true, body: { provider: "cloudflare-workers-ai-account-id", key: "acct-123" } }),
    }, ...platformRuns(cap), {
      match: (u) => u.startsWith("https://api.cloudflare.com/client/v4/accounts/"),
      respond: (u, i) => {
        sent.url = u;
        sent.body = JSON.parse(i!.body as string);
        return {
          ok: true,
          body: {
            success: true,
            result: {
              model: "clef-flash",
              answers: { no_phone: { type: "noul", noul: 0.08 } },
              usage: { input_tokens: 1179, output_tokens: 0 },
            },
          },
        };
      },
    });

    const res = await request(app).post("/internal/platform-judgments").set(AUTH).send({ ...BODY, judge: "cloudflare-clef-flash" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      judge: "cloudflare-clef-flash",
      model: "clef-flash",
      answers: { no_phone: { type: "noul", noul: 0.08 } },
      usage: { inputTokens: 1179, outputTokens: 0 },
      runId: "prun-img-1",
    });
    expect(sent.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/cloudflare/clef-flash");
    expect(sent.body!.state).toBe("");
    const images = sent.body!.images as Array<{ content_type: string; base64: string }>;
    const meta = await sharp(Buffer.from(images[0]!.base64, "base64")).metadata();
    expect([meta.width, meta.height]).toEqual([1568, 882]);
    expect(cap.costs).toEqual([[{ costName: "cloudflare-clef-flash-tokens-input", quantity: 1179, costSource: "platform" }]]);
  });

  it("a Luna failure is a named error, never a silent fallback to Jev", async () => {
    const cap = { costs: [] as PostedCost[][], statuses: [] as string[] };
    let jevCalls = 0;
    routes.push(
      imageRoute(),
      keyRoute("openai"),
      ...platformRuns(cap),
      { match: (u) => u === "https://api.openai.com/v1/decisions", respond: () => ({ ok: false, status: 500, body: { error: { message: "down" } } }) },
      { match: (u) => u.startsWith("https://api.typesafe.ai"), respond: () => { jevCalls += 1; return { ok: true, body: {} }; } },
    );

    const res = await request(app).post("/internal/platform-judgments").set(AUTH).send({ ...BODY, judge: "openai-luna" });

    expect(res.status).toBe(502);
    expect(res.body.judge).toBe("openai-luna");
    expect(res.body.error).toContain("OpenAI Decisions");
    expect(jevCalls).toBe(0);
    expect(cap.costs).toEqual([]);
    expect(cap.statuses).toEqual(["failed"]);
  });

  it("an unreachable image is a 400 before any key, run or spend", async () => {
    let otherCalls = 0;
    routes.push(imageRoute(404), { match: () => true, respond: () => { otherCalls += 1; return { ok: true, body: {} }; } });

    const res = await request(app).post("/internal/platform-judgments").set(AUTH).send(BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unusable image");
    expect(res.body.detail).toContain("HTTP 404");
    expect(otherCalls).toBe(0);
  });
});
