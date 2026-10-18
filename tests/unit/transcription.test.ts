import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TRANSCRIPTION_BYTES,
  TranscriptionError,
  assertTranscriptComplete,
  buildTranscriptionRequestBody,
  parseGoogleDuration,
  parseTranscript,
  probeSource,
  redactSourceUrl,
  resolveMediaMimeType,
  waitForGeminiFileActive,
} from "../../src/lib/transcription.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(typeof input === "string" ? input : input.toString(), init),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TranscriptionError);
    return (err as TranscriptionError).code;
  }
  throw new Error("expected a TranscriptionError");
}

describe("parseTranscript", () => {
  it("keeps mixed English/French lines verbatim with their start times", () => {
    const parsed = parseTranscript(
      "LANGUAGES: en, fr\n[00:00] Hello everyone, um, welcome back.\n[00:16] Bon, je passe en français.\n[1:02:05] And back to English.",
    );
    expect(parsed.languages).toEqual(["en", "fr"]);
    expect(parsed.segments).toEqual([
      { startSeconds: 0, start: "00:00", text: "Hello everyone, um, welcome back." },
      { startSeconds: 16, start: "00:16", text: "Bon, je passe en français." },
      { startSeconds: 3725, start: "1:02:05", text: "And back to English." },
    ]);
  });

  it("joins a wrapped line onto the previous segment", () => {
    const parsed = parseTranscript("LANGUAGES: en\n[00:05] First part\nof the same sentence.");
    expect(parsed.segments).toEqual([{ startSeconds: 5, start: "00:05", text: "First part of the same sentence." }]);
  });

  it("answers no segments for a silent recording", () => {
    expect(parseTranscript("LANGUAGES: none\nNO SPEECH")).toEqual({ languages: [], segments: [] });
  });

  it("refuses text that is not a timed transcript", () => {
    expect(() => parseTranscript("Here is a summary of the video: he talks about breathing.")).toThrow(
      expect.objectContaining({ code: "unparseable_transcript" }),
    );
    expect(() => parseTranscript("LANGUAGES: en")).toThrow(expect.objectContaining({ code: "unparseable_transcript" }));
  });
});

describe("resolveMediaMimeType", () => {
  it("takes the server's video/audio type", () => {
    expect(resolveMediaMimeType("video/mp4; charset=binary", "https://x.test/a")).toBe("video/mp4");
    expect(resolveMediaMimeType("audio/mpeg", "https://x.test/a")).toBe("audio/mpeg");
  });

  it("resolves a generic bucket type from the extension", () => {
    expect(resolveMediaMimeType("application/octet-stream", "https://x.test/v/take.MP4?X-Amz-Signature=abc")).toBe("video/mp4");
    expect(resolveMediaMimeType(null, "https://x.test/v/take.mov")).toBe("video/quicktime");
  });

  it("refuses anything else as not_media", () => {
    expect(() => resolveMediaMimeType("text/html", "https://x.test/page.mp4")).toThrow(expect.objectContaining({ code: "not_media" }));
    expect(() => resolveMediaMimeType("application/octet-stream", "https://x.test/blob")).toThrow(
      expect.objectContaining({ code: "not_media" }),
    );
  });
});

describe("probeSource", () => {
  it("reads the total size from a 206 Content-Range with a 1-byte range request", async () => {
    const fn = stubFetch(
      () => new Response("x", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/117380299" } }),
    );
    await expect(probeSource("https://bucket.test/v.mp4?sig=1")).resolves.toEqual({ mimeType: "video/mp4", sizeBytes: 117380299 });
    expect((fn.mock.calls[0][1]?.headers as Record<string, string>).Range).toBe("bytes=0-0");
  });

  it("falls to Content-Length when the server ignores the range", async () => {
    stubFetch(() => new Response("abc", { status: 200, headers: { "content-type": "audio/mp4", "content-length": "3" } }));
    await expect(probeSource("https://bucket.test/a.m4a")).resolves.toEqual({ mimeType: "audio/mp4", sizeBytes: 3 });
  });

  it("names a 404 source_unreachable", async () => {
    stubFetch(() => new Response("nope", { status: 404 }));
    expect(await codeOf(probeSource("https://bucket.test/gone.mp4"))).toBe("source_unreachable");
  });

  it("names a file over 2 GB file_too_large (413)", async () => {
    stubFetch(
      () =>
        new Response("x", {
          status: 206,
          headers: { "content-type": "video/mp4", "content-range": `bytes 0-0/${MAX_TRANSCRIPTION_BYTES + 1}` },
        }),
    );
    const err = await probeSource("https://bucket.test/huge.mp4").catch((e) => e);
    expect(err).toMatchObject({ code: "file_too_large", httpStatus: 413 });
  });

  it("names an HTML page not_media and an unsized file source_size_unknown", async () => {
    stubFetch(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(await codeOf(probeSource("https://bucket.test/page"))).toBe("not_media");
    stubFetch(() => new Response("x", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/*" } }));
    expect(await codeOf(probeSource("https://bucket.test/v.mp4"))).toBe("source_size_unknown");
  });
});

describe("waitForGeminiFileActive", () => {
  it("names a file Google could not decode unreadable_media", async () => {
    stubFetch(() => Response.json({ name: "files/a", uri: "u", mimeType: "video/mp4", state: "FAILED" }));
    const code = await codeOf(
      waitForGeminiFileActive("k", { name: "files/a", uri: "u", mimeType: "video/mp4", state: "PROCESSING" }, { pollMs: 1 }),
    );
    expect(code).toBe("unreadable_media");
  });

  it("returns once the file is ACTIVE", async () => {
    stubFetch(() => Response.json({ name: "files/a", uri: "u", mimeType: "video/mp4", state: "ACTIVE", videoMetadata: { videoDuration: "305s" } }));
    const file = await waitForGeminiFileActive("k", { name: "files/a", uri: "u", mimeType: "video/mp4", state: "PROCESSING" }, { pollMs: 1 });
    expect(parseGoogleDuration(file.videoMetadata?.videoDuration)).toBe(305);
  });
});

describe("buildTranscriptionRequestBody", () => {
  it("sends video at 1 fps (0.1 fps dropped the final seconds of speech) and LOW resolution, thinking at the floor", () => {
    const body = buildTranscriptionRequestBody("gemini-3.5-flash-lite", { name: "files/a", uri: "https://g/files/a", mimeType: "video/mp4" }) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
      generationConfig: Record<string, unknown>;
    };
    expect(body.contents[0].parts[0]).toEqual({
      fileData: { mimeType: "video/mp4", fileUri: "https://g/files/a" },
      videoMetadata: { fps: 1 },
    });
    expect(body.generationConfig).toMatchObject({
      temperature: 0,
      mediaResolution: "MEDIA_RESOLUTION_LOW",
      thinkingConfig: { thinkingLevel: "minimal" },
    });
  });

  it("sends audio without video metadata", () => {
    const body = buildTranscriptionRequestBody("gemini-3.5-flash-lite", { name: "files/a", uri: "u", mimeType: "audio/mpeg" }) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(body.contents[0].parts[0]).not.toHaveProperty("videoMetadata");
  });
});

describe("assertTranscriptComplete", () => {
  const base = { model: "m", raw: "", tokensInput: 1, tokensOutput: 1, costLines: [] };
  it("refuses a transcript cut by the output limit", () => {
    expect(() => assertTranscriptComplete({ ...base, finishReason: "MAX_TOKENS" })).toThrow(
      expect.objectContaining({ code: "transcript_truncated" }),
    );
    expect(() => assertTranscriptComplete({ ...base, finishReason: "SAFETY" })).toThrow(expect.objectContaining({ code: "provider_refused" }));
    expect(() => assertTranscriptComplete({ ...base, finishReason: "STOP" })).not.toThrow();
  });
});

describe("redactSourceUrl", () => {
  it("drops the presigned signature", () => {
    expect(redactSourceUrl("https://b.r2.test/videos/take-1.mp4?X-Amz-Signature=secret&X-Amz-Expires=3600")).toBe(
      "https://b.r2.test/videos/take-1.mp4",
    );
  });
});
