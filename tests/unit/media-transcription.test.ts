import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The SSRF guard itself is pinned in tests/unit/safe-fetch.test.ts; here the probe's network is a stub.
const probe = vi.hoisted(() => ({ sizeBytes: 0 }));
vi.mock("../../src/lib/safe-fetch.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/safe-fetch.js")>()),
  publicFetch: async () =>
    new Response("f", { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes 0-0/${probe.sizeBytes}` } }),
}));

import {
  CHARGED_NOTHING,
  MAX_MEDIA_TRANSCRIPTION_BYTES,
  boxTranscriberConfig,
  flattenBoxResult,
  parseInclude,
  progressFraction,
  segmentsInRange,
  toMediaTranscriptionBody,
  wordsInRange,
  type MediaTranscriptionSummary,
} from "../../src/lib/media-transcription.js";
import { LOCAL_FAMILIES, NOT_LOCAL_FAMILIES, ON_OUR_SERVER_FAMILIES } from "../../src/lib/local-llm.js";
import { MAX_TRANSCRIPTION_BYTES, probeSource } from "../../src/lib/transcription.js";
import { MediaTranscriptionQuerySchema, StartMediaTranscriptionRequestSchema } from "../../src/schemas.js";

// REELS-1124: a long recording is transcribed on our own server, charged $0.

const SIDECAR_RESULT = {
  language: "fr",
  languageProbability: 0.99,
  durationSeconds: 12.5,
  computeSeconds: 3.2,
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
    { start: 5, end: 9.75, text: "On commence.", words: [{ start: 5, end: 5.4, word: "On", probability: 0.9 }, { start: 5.4, end: 9.75, word: "commence.", probability: 0.8 }] },
    { start: 10, end: 12, text: "Merci.", words: [{ start: 10, end: 12, word: "Merci.", probability: 0.7 }] },
  ],
};

describe("flattenBoxResult", () => {
  it("turns the sidecar's nested segments into the two flat lists we store", () => {
    const flat = flattenBoxResult(SIDECAR_RESULT);
    expect(flat.segments).toEqual([
      { startSeconds: 0, endSeconds: 4.2, text: "Bonjour à tous." },
      { startSeconds: 5, endSeconds: 9.75, text: "On commence." },
      { startSeconds: 10, endSeconds: 12, text: "Merci." },
    ]);
    expect(flat.words).toHaveLength(6);
    expect(flat.words[0]).toEqual({ startSeconds: 0, endSeconds: 0.6, word: "Bonjour", probability: 0.98 });
    expect(flat.words[5]).toEqual({ startSeconds: 10, endSeconds: 12, word: "Merci.", probability: 0.7 });
  });

  it("keeps a segment that carries no words, and an empty recording", () => {
    expect(flattenBoxResult({ segments: [{ start: 1, end: 2, text: "Hm." }] })).toEqual({
      segments: [{ startSeconds: 1, endSeconds: 2, text: "Hm." }],
      words: [],
    });
    expect(flattenBoxResult({ segments: [] })).toEqual({ segments: [], words: [] });
  });

  it("fails loud on a result that is not a transcript, never an empty one", () => {
    expect(() => flattenBoxResult({})).toThrow(/no segments list/);
    expect(() => flattenBoxResult(null)).toThrow(/no segments list/);
    expect(() => flattenBoxResult({ segments: [{ start: 0, text: "x" }] })).toThrow(/segment 0/);
    expect(() => flattenBoxResult({ segments: [{ start: 0, end: 1, text: "x", words: [{ start: 0, word: "x" }] }] })).toThrow(/word/);
  });
});

describe("time range", () => {
  const { segments, words } = flattenBoxResult(SIDECAR_RESULT);

  it("serves the segments that OVERLAP the range, whole", () => {
    expect(segmentsInRange(segments, {})).toHaveLength(3);
    expect(segmentsInRange(segments, { fromSeconds: 4, toSeconds: 6 }).map((s) => s.text)).toEqual(["Bonjour à tous.", "On commence."]);
    expect(segmentsInRange(segments, { fromSeconds: 9.8 }).map((s) => s.text)).toEqual(["Merci."]);
    expect(segmentsInRange(segments, { toSeconds: 4.9 }).map((s) => s.text)).toEqual(["Bonjour à tous."]);
    // A segment that only touches a bound does not overlap it.
    expect(segmentsInRange(segments, { fromSeconds: 4.2, toSeconds: 5 })).toEqual([]);
    expect(segmentsInRange(segments, { fromSeconds: 100 })).toEqual([]);
  });

  it("serves the words that START in [from, to): consecutive ranges serve each word once", () => {
    expect(wordsInRange(words, {})).toHaveLength(6);
    expect(wordsInRange(words, { fromSeconds: 0.6, toSeconds: 5 }).map((w) => w.word)).toEqual(["à", "tous."]);
    expect(wordsInRange(words, { fromSeconds: 5 }).map((w) => w.word)).toEqual(["On", "commence.", "Merci."]);
    const cuts = [0, 0.6, 5, 5.4, 10, 13];
    const pieces = cuts.slice(0, -1).flatMap((from, i) => wordsInRange(words, { fromSeconds: from, toSeconds: cuts[i + 1] }));
    expect(pieces).toEqual(words);
  });

  it("reads include, and the schema refuses anything but segments / words", () => {
    expect([...parseInclude(undefined)]).toEqual([]);
    expect([...parseInclude("segments,words")]).toEqual(["segments", "words"]);
    expect([...parseInclude("words")]).toEqual(["words"]);
    expect(MediaTranscriptionQuerySchema.safeParse({ include: "segments,words", fromSeconds: "12.5", toSeconds: "30" }).success).toBe(true);
    expect(MediaTranscriptionQuerySchema.parse({ fromSeconds: "12.5" }).fromSeconds).toBe(12.5);
    expect(MediaTranscriptionQuerySchema.safeParse({ include: "segments,text" }).success).toBe(false);
    expect(MediaTranscriptionQuerySchema.safeParse({ fromSeconds: "30", toSeconds: "10" }).success).toBe(false);
    expect(MediaTranscriptionQuerySchema.safeParse({ fromSeconds: "-1" }).success).toBe(false);
  });
});

describe("request schema", () => {
  it("takes an https URL, a 2-letter language hint and an idempotency key", () => {
    expect(StartMediaTranscriptionRequestSchema.safeParse({ url: "https://b.test/a.mp4" }).success).toBe(true);
    expect(StartMediaTranscriptionRequestSchema.safeParse({ url: "https://b.test/a.mp4", language: "fr", idempotencyKey: "k" }).success).toBe(true);
    expect(StartMediaTranscriptionRequestSchema.safeParse({ url: "http://b.test/a.mp4" }).success).toBe(false);
    expect(StartMediaTranscriptionRequestSchema.safeParse({ url: "https://b.test/a.mp4", language: "french" }).success).toBe(false);
    expect(StartMediaTranscriptionRequestSchema.safeParse({ url: "https://b.test/a.mp4", idempotencyKey: "" }).success).toBe(false);
    expect(StartMediaTranscriptionRequestSchema.safeParse({ url: "https://b.test/a.mp4", idempotencyKey: "k".repeat(201) }).success).toBe(false);
  });
});

describe("served body", () => {
  const row: MediaTranscriptionSummary = {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "org-1",
    userId: "user-1",
    status: "transcribing",
    sourceUrl: "https://b.test/a.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1234,
    runId: "22222222-2222-4222-8222-222222222222",
    model: "nemo-parakeet-tdt-0.6b-v3",
    language: "fr",
    languageProbability: 0.99,
    durationSeconds: 3600,
    transcribedSeconds: 900,
    computeSeconds: 120,
    segmentCount: null,
    wordCount: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-11-24T10:00:00Z"),
    completedAt: null,
  };

  it("is the summary only by default: progress, usage, charged $0, no transcript", () => {
    const body = toMediaTranscriptionBody(row);
    expect(body).toEqual({
      id: row.id,
      status: "transcribing",
      source: { url: "https://b.test/a.mp4", mimeType: "video/mp4", sizeBytes: 1234 },
      model: "nemo-parakeet-tdt-0.6b-v3",
      language: "fr",
      languageProbability: 0.99,
      durationSeconds: 3600,
      progress: { transcribedSeconds: 900, durationSeconds: 3600, fraction: 0.25 },
      segmentCount: null,
      wordCount: null,
      usage: { audioSeconds: 3600, computeSeconds: 120 },
      charged: { usd: 0, reason: "Runs on our own server: no vendor is paid." },
      runId: row.runId,
      createdAt: "2026-11-24T10:00:00.000Z",
      completedAt: null,
    });
    expect(CHARGED_NOTHING.usd).toBe(0);
    expect("orgId" in body || "userId" in body).toBe(false);
  });

  it("adds the parts asked for, text with the segments, and the error only when failed", () => {
    const { segments, words } = flattenBoxResult(SIDECAR_RESULT);
    const done = toMediaTranscriptionBody({ ...row, status: "completed" }, { segments: segments.slice(0, 2), words });
    expect(done.text).toBe("Bonjour à tous.\nOn commence.");
    expect(done.words).toHaveLength(6);
    expect(done.progress.fraction).toBe(1);
    expect("error" in done).toBe(false);
    const wordsOnly = toMediaTranscriptionBody({ ...row, status: "completed" }, { words });
    expect("segments" in wordsOnly || "text" in wordsOnly).toBe(false);
    const failed = toMediaTranscriptionBody({ ...row, status: "failed", errorCode: "interrupted", errorMessage: "cut" });
    expect(failed.error).toEqual({ code: "interrupted", message: "cut" });
  });

  it("progress: 0 until something is transcribed, never above 1, 1 only once completed", () => {
    expect(progressFraction("downloading", null, null)).toBe(0);
    expect(progressFraction("transcribing", 0, 3600)).toBe(0);
    expect(progressFraction("transcribing", 1800, 3600)).toBe(0.5);
    expect(progressFraction("transcribing", 3590, 3600)).toBeLessThan(1);
    expect(progressFraction("transcribing", 4000, 3600)).toBe(1);
    expect(progressFraction("failed", 900, 3600)).toBe(0.25);
    expect(progressFraction("completed", 3400, 3600)).toBe(1);
  });
});

describe("configuration", () => {
  it("needs BOTH env vars: one alone is not a configured transcriber", () => {
    expect(boxTranscriberConfig({})).toBeNull();
    expect(boxTranscriberConfig({ TRANSCRIBER_SERVICE_URL: "http://transcriber:8080" })).toBeNull();
    expect(boxTranscriberConfig({ TRANSCRIBER_SERVICE_API_KEY: "k" })).toBeNull();
    expect(boxTranscriberConfig({ TRANSCRIBER_SERVICE_URL: " ", TRANSCRIBER_SERVICE_API_KEY: "k" })).toBeNull();
    expect(boxTranscriberConfig({ TRANSCRIBER_SERVICE_URL: "http://transcriber:8080/", TRANSCRIBER_SERVICE_API_KEY: "k" })).toEqual({ url: "http://transcriber:8080", apiKey: "k" });
  });
});

describe("source size limit", () => {
  it("is 4 GB on this route and stays 2 GB, same words, for the other callers", async () => {
    probe.sizeBytes = 3 * 1024 ** 3;
    await expect(probeSource("https://b.test/a.mp4")).rejects.toMatchObject({
      code: "file_too_large",
      httpStatus: 413,
      message: "The file is 3.00 GB; the limit is 2 GB.",
    });
    await expect(probeSource("https://b.test/a.mp4", { maxBytes: MAX_MEDIA_TRANSCRIPTION_BYTES })).resolves.toEqual({ mimeType: "video/mp4", sizeBytes: 3 * 1024 ** 3 });
    probe.sizeBytes = 4 * 1024 ** 3 + 1;
    await expect(probeSource("https://b.test/a.mp4", { maxBytes: MAX_MEDIA_TRANSCRIPTION_BYTES })).rejects.toMatchObject({
      code: "file_too_large",
      message: "The file is 4.00 GB; the limit is 4 GB.",
    });
    expect(MAX_TRANSCRIPTION_BYTES).toBe(2 * 1024 ** 3);
  });
});

describe("where each call family runs", () => {
  it("a long recording runs on our own server; only voice notes still run on a platform model", () => {
    expect(ON_OUR_SERVER_FAMILIES).toEqual([
      { family: "transcription of a long audio or video recording (/orgs/media-transcriptions)", reason: "an open speech model on our own server, charged $0." },
    ]);
    const onPlatform = NOT_LOCAL_FAMILIES.map((f) => f.family);
    expect(onPlatform).not.toContain("audio and video transcription");
    expect(onPlatform).toContain("voice notes sent to an assistant line (/orgs/transcriptions)");
    expect(onPlatform.some((f) => f.includes("/orgs/media-transcriptions"))).toBe(false);
    expect(LOCAL_FAMILIES.some((f) => f.includes("transcription"))).toBe(false);
  });
});

describe("no vendor, no key, no cost line", () => {
  // The route is $0 by carrying no cost line: this file must never learn to declare, hold or resolve one.
  const source = readFileSync(new URL("../../src/lib/media-transcription.ts", import.meta.url), "utf8");

  it("the lib names no cost, hold or key function", () => {
    for (const banned of ["addRunCosts", "addPlatformRunCosts", "updateRunCostStatus", "provisionAndAuthorize", "resolveKey", "resolvePlatformKey", "isLocalLlmOrg"]) {
      expect(source.includes(banned), banned).toBe(false);
    }
  });

  it("downloads the caller's URL through publicFetch only", () => {
    expect(source).toContain("await publicFetch(job.url");
    expect(/\bfetch\(job\.url/.test(source.replace(/publicFetch\(job\.url/g, ""))).toBe(false);
  });
});
