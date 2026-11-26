import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// REELS-1124: POST /orgs/media-transcriptions checks the source, opens an org
// run, answers 202 and streams the file to our own transcriber (the transcriber
// sidecar, stubbed here); the tick follows the job to its end. Charged $0: no
// key, no hold, no cost line, ever.

// The SSRF guard is pinned in tests/unit/safe-fetch.test.ts. Here a PUBLIC name
// goes to the stubbed global fetch; a literal private address goes to the REAL
// guard (it refuses before any network), so the route's refusal is the real one.
vi.mock("../../src/lib/safe-fetch.js", async (orig) => {
  const real = await orig<typeof import("../../src/lib/safe-fetch.js")>();
  return {
    ...real,
    publicFetch: (url: string | URL, init?: RequestInit) =>
      /^https?:\/\/(10\.|127\.|192\.168\.|169\.254\.|localhost|\[)/.test(String(url))
        ? real.publicFetch(url, init as Parameters<typeof real.publicFetch>[1])
        : globalThis.fetch(url, init),
  };
});

// Every cost function of the runs client is watched: none may ever be called for this route.
const costSpies = vi.hoisted(() => ({
  addRunCosts: vi.fn(),
  updateRunCostStatus: vi.fn(),
  addPlatformRunCosts: vi.fn(),
}));
vi.mock("../../src/lib/runs-client.js", async (orig) => {
  const real = await orig<typeof import("../../src/lib/runs-client.js")>();
  return {
    ...real,
    addRunCosts: (...args: Parameters<typeof real.addRunCosts>) => {
      costSpies.addRunCosts(...args);
      return real.addRunCosts(...args);
    },
    updateRunCostStatus: (...args: Parameters<typeof real.updateRunCostStatus>) => {
      costSpies.updateRunCostStatus(...args);
      return real.updateRunCostStatus(...args);
    },
    addPlatformRunCosts: (...args: Parameters<typeof real.addPlatformRunCosts>) => {
      costSpies.addPlatformRunCosts(...args);
      return real.addPlatformRunCosts(...args);
    },
  };
});

import request from "supertest";

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "https://key.test.local";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.test.local";

const TRANSCRIBER_URL = "http://transcriber.test.local:8080";
const TRANSCRIBER_KEY = "test-transcriber-key";

const STAMP = Date.now();
const ORG = `org-media-${STAMP}-a`;
const OTHER_ORG = `org-media-${STAMP}-b`;
const CALLER_RUN = "5f0c2a8e-1b3d-4c6e-9f70-a1b2c3d4e5f6";
const AUTH = { "x-api-key": "test-key", "x-org-id": ORG, "x-user-id": "user-media-1", "x-run-id": CALLER_RUN };
const OTHER_AUTH = { ...AUTH, "x-org-id": OTHER_ORG, "x-user-id": "user-media-2" };

const SOURCE = "https://bucket.test/videos/interview.mp4?X-Amz-Signature=secret";
const VIDEO_BYTES = "fake-mp4-bytes-of-a-long-interview";

const RESULT = {
  language: "fr",
  languageProbability: 0.987,
  durationSeconds: 12.5,
  computeSeconds: 3.25,
  model: "nemo-parakeet-tdt-0.6b-v3",
  segments: [
    {
      start: 0,
      end: 4.2,
      text: "Bonjour à tous.",
      words: [
        { start: 0, end: 0.6, word: "Bonjour", probability: 0.98 },
        { start: 0.6, end: 0.9, word: "à", probability: 0.91 },
        { start: 0.9, end: 4.2, word: "tous.", probability: 0.95 },
      ],
    },
    // A NUL byte: Postgres refuses it in jsonb, the save must still succeed.
    { start: 5, end: 9.75, text: "On com\u0000mence.", words: [{ start: 5, end: 5.4, word: "On", probability: 0.9 }, { start: 5.4, end: 9.75, word: "commence.", probability: 0.8 }] },
    { start: 10, end: 12, text: "Merci.", words: [{ start: 10, end: 12, word: "Merci.", probability: 0.7 }] },
  ],
};

interface SidecarJobState {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  model: string;
  language: string | null;
  languageProbability: number | null;
  durationSeconds: number | null;
  transcribedSeconds: number;
  computeSeconds: number;
  error: string | null;
}

interface Captured {
  runsCreated: Array<{ body: Record<string, unknown>; headers: Record<string, string> }>;
  runStatuses: Array<{ id: string; status: string; headers: Record<string, string> }>;
  costCalls: string[];
  otherCalls: string[];
  puts: Array<{ id: string; query: string; body: string; headers: Record<string, string> }>;
  sidecarDeleted: string[];
  sidecarReads: number;
}

let cap: Captured;
let jobs: Map<string, SidecarJobState>;
let results: Map<string, unknown>;
let sidecarDown = false;
let putStatus = 202;
let runCreateStatus = 201;
let sourceDownload: "ok" | "http_500" | "short" = "ok";
const realFetch = globalThis.fetch;

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;

      // A real HTTP server of one test (the streamed PUT for real).
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);

      if (url === SOURCE) {
        if (headers.Range) {
          return new Response("f", { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes 0-0/${VIDEO_BYTES.length}` } });
        }
        if (sourceDownload === "http_500") return new Response("boom", { status: 500 });
        if (sourceDownload === "short") return new Response(VIDEO_BYTES.slice(0, 10), { status: 200, headers: { "content-type": "video/mp4" } });
        return new Response(VIDEO_BYTES, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(VIDEO_BYTES.length) } });
      }

      if (url.includes("/costs")) {
        cap.costCalls.push(`${method} ${url}`);
        return Response.json({ costs: [] }, { status: 201 });
      }
      if (url.endsWith("/v1/runs") && method === "POST") {
        if (runCreateStatus >= 400) return new Response("runs down", { status: runCreateStatus });
        cap.runsCreated.push({ body: JSON.parse(init!.body as string), headers });
        return Response.json({ id: crypto.randomUUID(), status: "running" }, { status: 201 });
      }
      const runPatch = /\/v1\/runs\/([^/]+)$/.exec(url);
      if (runPatch && method === "PATCH") {
        cap.runStatuses.push({ id: runPatch[1], status: JSON.parse(init!.body as string).status, headers });
        return Response.json({ id: runPatch[1], status: "completed" });
      }

      if (url.startsWith(TRANSCRIBER_URL)) {
        if (sidecarDown) throw new TypeError("fetch failed");
        expect(headers["x-api-key"]).toBe(TRANSCRIBER_KEY);
        const u = new URL(url);
        const m = /^\/jobs\/([^/]+)(\/media|\/result)?$/.exec(u.pathname);
        if (!m) throw new Error(`[test] unknown sidecar path ${u.pathname}`);
        const [, id, tail] = m;
        if (method === "PUT" && tail === "/media") {
          // Reading the stream to its end is what the real sidecar does; a source that fails rejects here.
          const body = await new Response(init!.body as ReadableStream).text();
          if (putStatus >= 400) return new Response(JSON.stringify({ error: "refused" }), { status: putStatus });
          cap.puts.push({ id, query: u.search, body, headers });
          jobs.set(id, { id, status: "queued", model: "nemo-parakeet-tdt-0.6b-v3", language: null, languageProbability: null, durationSeconds: null, transcribedSeconds: 0, computeSeconds: 0, error: null });
          return Response.json(jobs.get(id), { status: 202 });
        }
        if (method === "DELETE") {
          cap.sidecarDeleted.push(id);
          jobs.delete(id);
          return new Response(null, { status: 204 });
        }
        cap.sidecarReads += 1;
        const job = jobs.get(id);
        if (!job) return Response.json({ error: "no job" }, { status: 404 });
        if (tail === "/result") return job.status === "completed" ? Response.json(results.get(id) ?? RESULT) : Response.json({ error: "not completed" }, { status: 409 });
        return Response.json(job);
      }

      cap.otherCalls.push(`${method} ${url}`);
      throw new Error(`[test] Unmocked fetch: ${method} ${url}`);
    }),
  );
}

let app: import("express").Express;
let db: typeof import("../../src/db/index.js").db;
let mediaTranscriptions: typeof import("../../src/db/schema.js").mediaTranscriptions;
let lib: typeof import("../../src/lib/media-transcription.js");
let orm: typeof import("drizzle-orm");

beforeAll(async () => {
  app = (await import("../../src/index.js")).default;
  db = (await import("../../src/db/index.js")).db;
  mediaTranscriptions = (await import("../../src/db/schema.js")).mediaTranscriptions;
  lib = await import("../../src/lib/media-transcription.js");
  orm = await import("drizzle-orm");
}, 60_000);

async function clearRows() {
  // The tick walks EVERY row in flight: nothing of a previous test may be left.
  await db.delete(mediaTranscriptions).where(orm.like(mediaTranscriptions.orgId, "org-media-%"));
}

beforeEach(async () => {
  process.env.TRANSCRIBER_SERVICE_URL = TRANSCRIBER_URL;
  process.env.TRANSCRIBER_SERVICE_API_KEY = TRANSCRIBER_KEY;
  cap = { runsCreated: [], runStatuses: [], costCalls: [], otherCalls: [], puts: [], sidecarDeleted: [], sidecarReads: 0 };
  jobs = new Map();
  results = new Map();
  sidecarDown = false;
  putStatus = 202;
  runCreateStatus = 201;
  sourceDownload = "ok";
  for (const spy of Object.values(costSpies)) spy.mockClear();
  installFetchMock();
  await clearRows();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  if (db) await clearRows();
  delete process.env.TRANSCRIBER_SERVICE_URL;
  delete process.env.TRANSCRIBER_SERVICE_API_KEY;
});

const start = (body: Record<string, unknown> = { url: SOURCE }, auth: Record<string, string> = AUTH) =>
  request(app).post("/orgs/media-transcriptions").set(auth).send(body);
const read = (id: string, query = "", auth: Record<string, string> = AUTH) =>
  request(app).get(`/orgs/media-transcriptions/${id}${query}`).set(auth);

async function waitPast(id: string, status: string) {
  for (let i = 0; i < 200; i++) {
    const res = await read(id);
    if (res.body.status !== status) return res;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`transcription ${id} never left ${status}`);
}

/** POST, then wait until the file reached the sidecar. */
async function startTranscribing(body: Record<string, unknown> = { url: SOURCE }) {
  const res = await start(body);
  expect(res.status).toBe(202);
  const after = await waitPast(res.body.id, "downloading");
  expect(after.body.status).toBe("transcribing");
  return res.body.id as string;
}

function expectNoCostEver() {
  expect(cap.costCalls).toEqual([]);
  expect(costSpies.addRunCosts).not.toHaveBeenCalled();
  expect(costSpies.updateRunCostStatus).not.toHaveBeenCalled();
  expect(costSpies.addPlatformRunCosts).not.toHaveBeenCalled();
  // No key-service, no billing-service: the only services called are runs-service and the sidecar.
  expect(cap.otherCalls).toEqual([]);
}

describe("POST /orgs/media-transcriptions", { timeout: 30_000 }, () => {
  it("answers 202 at once, streams the file to our transcriber, and the tick follows it to the transcript", async () => {
    const res = await start({ url: SOURCE, language: "FR", idempotencyKey: "interview-1" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "downloading",
      // The presigned signature is never stored or served back.
      source: { url: "https://bucket.test/videos/interview.mp4", mimeType: "video/mp4", sizeBytes: VIDEO_BYTES.length },
      progress: { transcribedSeconds: 0, durationSeconds: null, fraction: 0 },
      charged: { usd: 0, reason: "Runs on our own server: no vendor is paid." },
      completedAt: null,
    });
    expect("segments" in res.body || "words" in res.body || "error" in res.body).toBe(false);
    const id = res.body.id as string;

    // An ORG run, child of the caller's run, with the request's identity.
    expect(cap.runsCreated).toHaveLength(1);
    expect(cap.runsCreated[0].body).toMatchObject({ serviceName: "chat-service", taskName: "transcribe-media-on-box" });
    expect(cap.runsCreated[0].headers).toMatchObject({ "x-org-id": ORG, "x-user-id": "user-media-1", "x-run-id": CALLER_RUN });
    expect(res.body.runId).toMatch(/^[0-9a-f-]{36}$/);

    expect((await waitPast(id, "downloading")).body.status).toBe("transcribing");
    expect(cap.puts).toHaveLength(1);
    expect(cap.puts[0]).toMatchObject({ id, query: "?language=fr", body: VIDEO_BYTES });
    expect(cap.puts[0].headers["Content-Length"]).toBe(String(VIDEO_BYTES.length));

    // Mid-way: the tick stores the sidecar's progress.
    Object.assign(jobs.get(id)!, { status: "running", language: "fr", languageProbability: 0.987, durationSeconds: 12.5, transcribedSeconds: 5, computeSeconds: 1.5 });
    const mid = await lib.tickMediaTranscriptions(db);
    expect(mid.progressed).toEqual([id]);
    const running = await read(id, "?include=segments,words");
    expect(running.body).toMatchObject({ status: "transcribing", language: "fr", model: "nemo-parakeet-tdt-0.6b-v3", durationSeconds: 12.5, progress: { transcribedSeconds: 5, fraction: 0.4 } });
    // Not completed: include adds nothing.
    expect("segments" in running.body || "words" in running.body).toBe(false);
    expect(cap.runStatuses).toEqual([]);

    // Done on the sidecar: the tick stores the transcript, closes the run, frees the sidecar.
    Object.assign(jobs.get(id)!, { status: "completed", transcribedSeconds: 12, computeSeconds: 3.25 });
    const end = await lib.tickMediaTranscriptions(db);
    expect(end.completed).toEqual([id]);
    expect(cap.runStatuses).toHaveLength(1);
    expect(cap.runStatuses[0]).toMatchObject({ id: res.body.runId, status: "completed" });
    expect(cap.runStatuses[0].headers).toMatchObject({ "x-org-id": ORG, "x-user-id": "user-media-1", "x-run-id": res.body.runId });
    expect(cap.sidecarDeleted).toEqual([id]);

    // The summary: no transcript loaded.
    const summary = await read(id);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      id,
      status: "completed",
      model: "nemo-parakeet-tdt-0.6b-v3",
      language: "fr",
      durationSeconds: 12.5,
      progress: { transcribedSeconds: 12, durationSeconds: 12.5, fraction: 1 },
      segmentCount: 3,
      wordCount: 6,
      usage: { audioSeconds: 12.5, computeSeconds: 3.25 },
      charged: { usd: 0 },
      runId: res.body.runId,
    });
    expect(summary.body.languageProbability).toBeCloseTo(0.987, 3);
    expect(summary.body.completedAt).not.toBeNull();
    expect("segments" in summary.body || "words" in summary.body || "text" in summary.body || "error" in summary.body).toBe(false);

    // The whole transcript (the NUL byte was dropped, nothing else).
    const whole = await read(id, "?include=segments,words");
    expect(whole.body.segments).toEqual([
      { startSeconds: 0, endSeconds: 4.2, text: "Bonjour à tous." },
      { startSeconds: 5, endSeconds: 9.75, text: "On commence." },
      { startSeconds: 10, endSeconds: 12, text: "Merci." },
    ]);
    expect(whole.body.text).toBe("Bonjour à tous.\nOn commence.\nMerci.");
    expect(whole.body.words).toHaveLength(6);
    expect(whole.body.words[1]).toEqual({ startSeconds: 0.6, endSeconds: 0.9, word: "à", probability: 0.91 });

    // A time range: segments that overlap it, words that start in it.
    const range = await read(id, "?include=segments,words&fromSeconds=4&toSeconds=5.4");
    expect(range.body.segments.map((s: { text: string }) => s.text)).toEqual(["Bonjour à tous.", "On commence."]);
    expect(range.body.words.map((w: { word: string }) => w.word)).toEqual(["On"]);
    expect(range.body.segmentCount).toBe(3);
    const wordsOnly = await read(id, "?include=words&fromSeconds=10");
    expect(wordsOnly.body.words.map((w: { word: string }) => w.word)).toEqual(["Merci."]);
    expect("segments" in wordsOnly.body || "text" in wordsOnly.body).toBe(false);

    // A later tick has nothing left to do.
    const reads = cap.sidecarReads;
    expect(await lib.tickMediaTranscriptions(db)).toMatchObject({ completed: [], failed: [], progressed: [] });
    expect(cap.sidecarReads).toBe(reads);
    expectNoCostEver();
  });

  it("the same org + idempotencyKey answers the same transcription and starts nothing, whatever its status", async () => {
    const first = await start({ url: SOURCE, idempotencyKey: "same-key" });
    expect(first.status).toBe(202);
    await waitPast(first.body.id, "downloading");

    const again = await start({ url: SOURCE, idempotencyKey: "same-key" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.status).toBe("transcribing");
    expect(cap.runsCreated).toHaveLength(1);
    expect(cap.puts).toHaveLength(1);

    // A failed one is still that answer: a retry needs a new key.
    jobs.get(first.body.id)!.status = "failed";
    jobs.get(first.body.id)!.error = "InvalidDataError: no audio stream";
    await lib.tickMediaTranscriptions(db);
    const afterFailure = await start({ url: SOURCE, idempotencyKey: "same-key" });
    expect(afterFailure.status).toBe(200);
    expect(afterFailure.body).toMatchObject({ id: first.body.id, status: "failed", error: { code: "transcription_failed" } });
    expect(cap.runsCreated).toHaveLength(1);

    // The key is per org; no key = always a new transcription.
    const otherOrg = await start({ url: SOURCE, idempotencyKey: "same-key" }, OTHER_AUTH);
    expect(otherOrg.status).toBe(202);
    expect(otherOrg.body.id).not.toBe(first.body.id);
    const newKey = await start({ url: SOURCE, idempotencyKey: "new-key" });
    expect(newKey.status).toBe(202);
    expect(newKey.body.id).not.toBe(first.body.id);
    await Promise.all([otherOrg.body.id, newKey.body.id].map((id) => waitPast(id, "downloading")));
    expectNoCostEver();
  });

  it("two parallel POSTs with one key start ONE transcription", async () => {
    const [a, b] = await Promise.all([start({ url: SOURCE, idempotencyKey: "race" }), start({ url: SOURCE, idempotencyKey: "race" })]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(a.body.id).toBe(b.body.id);
    await waitPast(a.body.id, "downloading");
    expect(cap.runsCreated).toHaveLength(1);
    expect(cap.puts).toHaveLength(1);
  });

  it("refuses a URL that is not on the public internet: named 422, no run, no row", async () => {
    for (const url of ["https://10.0.0.5/interview.mp4", "https://127.0.0.1/interview.mp4", "https://169.254.169.254/latest/a.mp4"]) {
      const res = await start({ url, idempotencyKey: `private-${url}` });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("source_unreachable");
      expect(res.body.error).toContain("not on the public internet");
    }
    expect(cap.runsCreated).toEqual([]);
    expect(cap.puts).toEqual([]);
    expect(await db.select({ id: mediaTranscriptions.id }).from(mediaTranscriptions).where(orm.eq(mediaTranscriptions.orgId, ORG))).toEqual([]);
  });

  it("answers 503 box_transcriber_not_configured when the env is unset, and starts nothing", async () => {
    delete process.env.TRANSCRIBER_SERVICE_API_KEY;
    const res = await start({ url: SOURCE });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("box_transcriber_not_configured");
    delete process.env.TRANSCRIBER_SERVICE_URL;
    expect((await start({ url: SOURCE })).status).toBe(503);
    expect(cap.runsCreated).toEqual([]);
    // The rest of the service still answers.
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("refuses an invalid body (400) and a missing or wrong service key (401)", async () => {
    expect((await start({ url: "http://bucket.test/a.mp4" })).status).toBe(400);
    expect((await start({ url: SOURCE, language: "french" })).status).toBe(400);
    expect((await start({})).status).toBe(400);
    expect((await request(app).post("/orgs/media-transcriptions").set({ ...AUTH, "x-api-key": "wrong" }).send({ url: SOURCE })).status).toBe(401);
    const { "x-api-key": _key, ...noKey } = AUTH;
    expect((await request(app).post("/orgs/media-transcriptions").set(noKey).send({ url: SOURCE })).status).toBe(401);
    expect((await request(app).get(`/orgs/media-transcriptions/${crypto.randomUUID()}`).set(noKey)).status).toBe(401);
    expect(cap.runsCreated).toEqual([]);
  });

  it("a run that cannot be opened starts nothing: 502, no row, the same key can be sent again", async () => {
    runCreateStatus = 503;
    const res = await start({ url: SOURCE, idempotencyKey: "retry-me" });
    expect(res.status).toBe(502);
    expect(cap.puts).toEqual([]);
    expect(await db.select({ id: mediaTranscriptions.id }).from(mediaTranscriptions).where(orm.eq(mediaTranscriptions.orgId, ORG))).toEqual([]);
    runCreateStatus = 201;
    const again = await start({ url: SOURCE, idempotencyKey: "retry-me" });
    expect(again.status).toBe(202);
    await waitPast(again.body.id, "downloading");
  });

  it("a download that fails lands on the row with its code, and the run is closed failed", async () => {
    sourceDownload = "http_500";
    const a = await start({ url: SOURCE });
    const failedA = await waitPast(a.body.id, "downloading");
    expect(failedA.body).toMatchObject({ status: "failed", error: { code: "source_unreachable" } });
    expect(failedA.body.error.message).toContain("HTTP 500");

    sourceDownload = "short";
    const b = await start({ url: SOURCE });
    const failedB = await waitPast(b.body.id, "downloading");
    expect(failedB.body).toMatchObject({ status: "failed", error: { code: "source_unreachable" } });
    expect(failedB.body.error.message).toContain(`10 bytes, ${VIDEO_BYTES.length} were announced`);

    sourceDownload = "ok";
    putStatus = 503;
    const c = await start({ url: SOURCE });
    const failedC = await waitPast(c.body.id, "downloading");
    expect(failedC.body).toMatchObject({ status: "failed", error: { code: "box_transcriber_unreachable" } });

    putStatus = 202;
    sidecarDown = true;
    const d = await start({ url: SOURCE });
    const failedD = await waitPast(d.body.id, "downloading");
    expect(failedD.body).toMatchObject({ status: "failed", error: { code: "box_transcriber_unreachable" } });

    expect(cap.runStatuses.map((r) => r.status)).toEqual(["failed", "failed", "failed", "failed"]);
    expect(cap.runStatuses.map((r) => r.id).sort()).toEqual([a, b, c, d].map((r) => r.body.runId).sort());
    expectNoCostEver();
  });

  it("streams the file over real HTTP with its length, never buffered into one body", async () => {
    const received: { length?: string; encoding?: string; key?: string; body: string; path?: string } = { body: "" };
    const server: Server = createServer((req, res) => {
      received.length = req.headers["content-length"];
      received.encoding = req.headers["transfer-encoding"];
      received.key = req.headers["x-api-key"] as string;
      received.path = req.url;
      req.setEncoding("utf8");
      req.on("data", (c) => (received.body += c));
      req.on("end", () => {
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "queued" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      process.env.TRANSCRIBER_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const res = await start({ url: SOURCE });
      expect(res.status).toBe(202);
      expect((await waitPast(res.body.id, "downloading")).body.status).toBe("transcribing");
      expect(received.body).toBe(VIDEO_BYTES);
      expect(received.path).toBe(`/jobs/${res.body.id}/media`);
      expect(received.key).toBe(TRANSCRIBER_KEY);
      // Either framing is a whole body; the sidecar reads both.
      expect(received.length === String(VIDEO_BYTES.length) || received.encoding === "chunked").toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("GET /orgs/media-transcriptions/:id", { timeout: 30_000 }, () => {
  it("is private to its org: another org gets the same 404 as an unknown id", async () => {
    const id = await startTranscribing();
    expect((await read(id)).status).toBe(200);
    const other = await read(id, "", OTHER_AUTH);
    const unknown = await read(crypto.randomUUID());
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(Object.keys(other.body)).toEqual(Object.keys(unknown.body));
    expect((await read(id, "?include=segments,words", OTHER_AUTH)).status).toBe(404);
  });

  it("refuses a bad id, include or range with 400", async () => {
    const id = await startTranscribing();
    expect((await read("not-a-uuid")).status).toBe(400);
    expect((await read(id, "?include=everything")).status).toBe(400);
    expect((await read(id, "?include=words&fromSeconds=20&toSeconds=10")).status).toBe(400);
    expect((await read(id, "?fromSeconds=abc")).status).toBe(400);
  });
});

describe("tick", { timeout: 30_000 }, () => {
  it("a job our transcriber failed is failed with its reason, the run closed failed", async () => {
    const id = await startTranscribing();
    Object.assign(jobs.get(id)!, { status: "failed", error: "InvalidDataError: no audio stream" });
    const outcome = await lib.tickMediaTranscriptions(db);
    expect(outcome.failed).toEqual([id]);
    const res = await read(id);
    expect(res.body).toMatchObject({ status: "failed", error: { code: "transcription_failed" } });
    expect(res.body.error.message).toContain("no audio stream");
    expect(res.body.completedAt).not.toBeNull();
    expect(cap.runStatuses.map((r) => r.status)).toEqual(["failed"]);
    expect(cap.sidecarDeleted).toEqual([id]);
    // Final: the next tick does not touch it or its run again.
    await lib.tickMediaTranscriptions(db);
    expect(cap.runStatuses).toHaveLength(1);
  });

  it("a job our transcriber no longer holds (404) is interrupted", async () => {
    const id = await startTranscribing();
    jobs.delete(id);
    const outcome = await lib.tickMediaTranscriptions(db);
    expect(outcome.failed).toEqual([id]);
    const res = await read(id);
    expect(res.body).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    expect(res.body.error.message).toContain("new idempotencyKey");
    expect(cap.runStatuses.map((r) => r.status)).toEqual(["failed"]);
  });

  it("a download no process holds, older than 2 minutes, is interrupted; a young one is left alone", async () => {
    const runId = crypto.randomUUID();
    const [orphan] = await db
      .insert(mediaTranscriptions)
      .values({ orgId: ORG, userId: "user-media-1", status: "downloading", sourceUrl: "https://bucket.test/a.mp4", mimeType: "video/mp4", sizeBytes: 10, runId, createdAt: new Date(Date.now() - 5 * 60_000) })
      .returning({ id: mediaTranscriptions.id });
    const [young] = await db
      .insert(mediaTranscriptions)
      .values({ orgId: ORG, userId: "user-media-1", status: "downloading", sourceUrl: "https://bucket.test/b.mp4", mimeType: "video/mp4", sizeBytes: 10, runId: crypto.randomUUID(), createdAt: new Date(Date.now() - 30_000) })
      .returning({ id: mediaTranscriptions.id });
    // Old but held by THIS process (a slow 4 GB download): never interrupted.
    const [held] = await db
      .insert(mediaTranscriptions)
      .values({ orgId: ORG, userId: "user-media-1", status: "downloading", sourceUrl: "https://bucket.test/c.mp4", mimeType: "video/mp4", sizeBytes: 10, runId: crypto.randomUUID(), createdAt: new Date(Date.now() - 20 * 60_000) })
      .returning({ id: mediaTranscriptions.id });
    lib.holdDownload(held.id);
    try {
      const outcome = await lib.tickMediaTranscriptions(db);
      expect(outcome.failed).toEqual([orphan.id]);
      const res = await read(orphan.id);
      expect(res.body).toMatchObject({
        status: "failed",
        error: { code: "interrupted", message: "The download was cut by a service restart. Start it again with a new idempotencyKey." },
      });
      expect(cap.runStatuses).toHaveLength(1);
      expect(cap.runStatuses[0]).toMatchObject({ id: runId, status: "failed" });
      expect(cap.runStatuses[0].headers).toMatchObject({ "x-org-id": ORG, "x-user-id": "user-media-1" });
      // Whatever the cut process delivered is freed on the sidecar.
      expect(cap.sidecarDeleted).toEqual([orphan.id]);
      expect((await read(young.id)).body.status).toBe("downloading");
      expect((await read(held.id)).body.status).toBe("downloading");
    } finally {
      lib.releaseDownload(held.id);
    }
  });

  it("a transcriber that cannot be reached leaves every row as it is", async () => {
    const a = await startTranscribing();
    const b = await startTranscribing();
    Object.assign(jobs.get(a)!, { status: "completed" });
    sidecarDown = true;
    const outcome = await lib.tickMediaTranscriptions(db);
    expect(outcome).toMatchObject({ completed: [], failed: [], progressed: [], boxUnreachable: true });
    expect((await read(a)).body.status).toBe("transcribing");
    expect((await read(b)).body.status).toBe("transcribing");
    expect(cap.runStatuses).toEqual([]);

    // Env gone (a bad deploy): same, nothing is failed for it.
    sidecarDown = false;
    const unset = await lib.tickMediaTranscriptions(db, { config: null });
    expect(unset).toMatchObject({ completed: [], failed: [], boxUnreachable: true });
    expect((await read(a)).body.status).toBe("transcribing");

    // Back: the same rows go on.
    const back = await lib.tickMediaTranscriptions(db);
    expect(back.completed).toEqual([a]);
    expect(back.progressed).toEqual([b]);
  });

  it("a transcriber silent for 30 minutes fails the row: never transcribing forever", async () => {
    const id = await startTranscribing();
    sidecarDown = true;
    const soon = await lib.tickMediaTranscriptions(db, { now: new Date(Date.now() + lib.BOX_SILENT_FAIL_AFTER_MS - 60_000) });
    expect(soon.failed).toEqual([]);
    expect((await read(id)).body.status).toBe("transcribing");

    const late = await lib.tickMediaTranscriptions(db, { now: new Date(Date.now() + lib.BOX_SILENT_FAIL_AFTER_MS + 60_000) });
    expect(late.failed).toEqual([id]);
    expect((await read(id)).body).toMatchObject({
      status: "failed",
      error: { code: "box_transcriber_unreachable", message: lib.BOX_SILENT_MESSAGE },
    });
    expect(cap.runStatuses.map((r) => r.status)).toEqual(["failed"]);
  });

  it("a result that is not a transcript fails the job, never stores an empty one", async () => {
    const id = await startTranscribing();
    Object.assign(jobs.get(id)!, { status: "completed" });
    results.set(id, { language: "fr", segments: "oops" });
    const outcome = await lib.tickMediaTranscriptions(db);
    expect(outcome.failed).toEqual([id]);
    expect((await read(id)).body).toMatchObject({ status: "failed", error: { code: "transcription_failed" }, segmentCount: null });
    expect(cap.runStatuses.map((r) => r.status)).toEqual(["failed"]);
  });
});
