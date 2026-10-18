import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// POST /internal/platform-transcriptions checks the source, starts a platform
// run, answers 202, and transcribes in the background; GET reads the job back.

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";

const SOURCE = "https://bucket.test/videos/take-12.mp4?X-Amz-Signature=secret";
const VIDEO_BYTES = "fake-mp4-bytes";

interface Captured {
  runsCreated: number;
  costs: Array<Array<{ costName: string; quantity: number; costSource?: string }>>;
  runStatuses: string[];
  generateBodies: Array<Record<string, unknown>>;
  deleted: string[];
  uploadedBody: string | null;
}

let cap: Captured;
let sourceStatus = 206;
let transcriptText = "LANGUAGES: en, fr\n[00:00] Hello everyone, welcome back.\n[00:16] Bon, je passe en français.";

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;

      if (url === SOURCE) {
        if (sourceStatus >= 400) return new Response("NoSuchKey", { status: sourceStatus });
        if (headers.Range) {
          return new Response("f", {
            status: 206,
            headers: { "content-type": "video/mp4", "content-range": `bytes 0-0/${VIDEO_BYTES.length}` },
          });
        }
        return new Response(VIDEO_BYTES, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(VIDEO_BYTES.length) } });
      }
      if (url.includes("/keys/platform/google/decrypt")) return Response.json({ provider: "google", key: "fake-google-key" });
      if (url.endsWith("/v1/platform-runs") && method === "POST") {
        cap.runsCreated += 1;
        return Response.json({ id: "11111111-1111-4111-8111-111111111111", status: "running" }, { status: 201 });
      }
      if (/\/v1\/platform-runs\/[^/]+\/costs$/.test(url)) {
        const items = JSON.parse(init!.body as string).items;
        cap.costs.push(items);
        return Response.json({ costs: items }, { status: 201 });
      }
      if (/\/v1\/platform-runs\/[^/]+$/.test(url) && method === "PATCH") {
        cap.runStatuses.push(JSON.parse(init!.body as string).status);
        return Response.json({ id: "run", status: "completed" });
      }
      if (url.startsWith("https://generativelanguage.googleapis.com/upload/v1beta/files")) {
        expect(headers["X-Goog-Upload-Header-Content-Length"]).toBe(String(VIDEO_BYTES.length));
        return new Response("{}", { status: 200, headers: { "x-goog-upload-url": "https://upload.test/session-1" } });
      }
      if (url === "https://upload.test/session-1") {
        cap.uploadedBody = await new Response(init!.body as ReadableStream).text();
        return Response.json({
          file: { name: "files/abc", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc", mimeType: "video/mp4", state: "ACTIVE", videoMetadata: { videoDuration: "305s" } },
        });
      }
      if (url.includes(":generateContent")) {
        cap.generateBodies.push(JSON.parse(init!.body as string));
        return Response.json({
          candidates: [{ content: { parts: [{ text: transcriptText }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 27930, candidatesTokenCount: 1942, totalTokenCount: 29872 },
        });
      }
      if (url.includes("/v1beta/files/abc") && method === "DELETE") {
        cap.deleted.push("files/abc");
        return Response.json({});
      }
      throw new Error(`[test] Unmocked fetch: ${method} ${url}`);
    }),
  );
}

let app: import("express").Express;

beforeAll(async () => {
  app = (await import("../../src/index.js")).default;
});

beforeEach(() => {
  cap = { runsCreated: 0, costs: [], runStatuses: [], generateBodies: [], deleted: [], uploadedBody: null };
  sourceStatus = 206;
  installFetchMock();
});

afterEach(() => vi.unstubAllGlobals());

async function waitDone(id: string) {
  for (let i = 0; i < 100; i++) {
    const res = await request(app).get(`/internal/platform-transcriptions/${id}`).set("x-api-key", "k");
    if (res.body.status !== "processing") return res;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job never finished");
}

describe("POST /internal/platform-transcriptions", { timeout: 30000 }, () => {
  it("transcribes in the background and declares the cost on a platform run", async () => {
    const start = await request(app).post("/internal/platform-transcriptions").set("x-api-key", "k").send({ url: SOURCE });
    expect(start.status).toBe(202);
    expect(start.body).toMatchObject({ status: "processing", model: "gemini-3.5-flash-lite" });
    // The presigned signature is never stored or served back.
    expect(start.body.source).toEqual({ url: "https://bucket.test/videos/take-12.mp4", mimeType: "video/mp4", sizeBytes: VIDEO_BYTES.length });

    const done = await waitDone(start.body.id);
    expect(done.body).toMatchObject({
      status: "completed",
      languages: ["en", "fr"],
      durationSeconds: 305,
      segments: [
        { startSeconds: 0, start: "00:00", text: "Hello everyone, welcome back." },
        { startSeconds: 16, start: "00:16", text: "Bon, je passe en français." },
      ],
      text: "Hello everyone, welcome back.\nBon, je passe en français.",
    });
    expect(cap.uploadedBody).toBe(VIDEO_BYTES);
    expect(cap.costs).toEqual([
      [
        { costName: "google-flash-lite-3.5-tokens-input", quantity: 27930, costSource: "platform" },
        { costName: "google-flash-lite-3.5-tokens-output", quantity: 1942, costSource: "platform" },
      ],
    ]);
    expect(cap.runStatuses).toEqual(["completed"]);
    expect(cap.deleted).toEqual(["files/abc"]);
  });

  it("still bills a transcript it then refuses, and names why", async () => {
    transcriptText = "Sorry, here is a summary instead.";
    const start = await request(app).post("/internal/platform-transcriptions").set("x-api-key", "k").send({ url: SOURCE });
    const done = await waitDone(start.body.id);
    expect(done.body.status).toBe("failed");
    expect(done.body.error.code).toBe("unparseable_transcript");
    expect(cap.costs).toHaveLength(1);
    expect(cap.runStatuses).toEqual(["failed"]);
    transcriptText = "LANGUAGES: en\n[00:00] Hello.";
  });

  it("answers a 404 URL with a named 422 and starts nothing", async () => {
    sourceStatus = 404;
    const res = await request(app).post("/internal/platform-transcriptions").set("x-api-key", "k").send({ url: SOURCE });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "source_unreachable" });
    expect(res.body.error).toContain("404");
    expect(cap.runsCreated).toBe(0);
  });

  it("refuses a non-https URL and requires the service key", async () => {
    expect((await request(app).post("/internal/platform-transcriptions").set("x-api-key", "k").send({ url: "http://x.test/a.mp4" })).status).toBe(400);
    expect((await request(app).post("/internal/platform-transcriptions").send({ url: SOURCE })).status).toBe(401);
  });

  it("404s an unknown job", async () => {
    const res = await request(app).get("/internal/platform-transcriptions/22222222-2222-4222-8222-222222222222").set("x-api-key", "k");
    expect(res.status).toBe(404);
  });
});
