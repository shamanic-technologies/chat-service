// ---------------------------------------------------------------------------
// Speech transcription of a video/audio file behind a URL (platform callers).
//
// Shape: ASYNC. `POST /internal/platform-transcriptions` checks the source in
// the request (so a 404 / non-media URL / oversized file fails at once with a
// named code), stores a `processing` row and answers 202; the job then runs in
// the background and `GET /internal/platform-transcriptions/:id` reads it back.
// A 2 GB phone video does not fit in one HTTP request: download, upload to
// Google and transcription together take minutes.
//
// How the file reaches the model: streamed source GET → Gemini Files API
// resumable upload (2 GB per file, the provider's own limit), never buffered
// in memory or on disk. The uploaded file is deleted once the job ends (Google
// also expires it after 48 h).
//
// Cost: Gemini 3.8 Flash (`flash-pro` alias, the default) is priced by the
// existing `google-flash-3.8-tokens-*` catalog rows; `flash` (3.5 Flash-Lite,
// `google-flash-lite-3.5-tokens-*`) stays selectable. Video frames are
// irrelevant to a transcript, so they go at LOW media resolution (~86-91
// tokens per second of video in total, measured: 4 min = 20.4k input tokens
// ≈ $0.04 on Flash 3.8 with the answer).
// ---------------------------------------------------------------------------

import { buildThinkingConfig, geminiCostPrefix } from "./gemini.js";
import { readGeminiBilledTokens, type GeminiCostLine, type GeminiUsageMetadata } from "./gemini-usage.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta";

/** Gemini Files API per-file limit. */
export const MAX_TRANSCRIPTION_BYTES = 2 * 1024 * 1024 * 1024;

/** Aliases a caller may pick; the default is the one that keeps every word. */
export const TRANSCRIPTION_MODELS = {
  flash: "gemini-3.5-flash-lite",
  "flash-pro": "gemini-3.8-flash",
} as const;
export type TranscriptionModelAlias = keyof typeof TRANSCRIPTION_MODELS;
// Flash 3.8, NOT Flash-Lite. Do not move the default back to `flash` to save
// money: on a 238 s French phone video of slow speech with many pauses,
// Flash-Lite 3.5 dropped ~90 s of speech (288 words served of ~415) and
// stretched its timestamps so the transcript still reached the last second,
// i.e. the loss is invisible from the timestamps. Six re-runs 2026-10-18:
// Flash-Lite 367-409 words with 20-27 s holes, different on every run;
// Flash 3.8 408-419 words, no hole, timestamps on the real speech onsets.
// Normal-pace clips came out equal on both (94/96, 535/540, 139/141 words).
// Cost ≈ $0.01 per minute of video vs $0.002: the transcripts feed a corpus
// where a missing passage is the failure.
export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModelAlias = "flash-pro";

/** A job still `processing` after this long was cut off (restart): reported failed. */
export const TRANSCRIPTION_STALE_AFTER_MS = 60 * 60_000;

const SOURCE_PROBE_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 30 * 60_000;
const FILE_PROCESSING_TIMEOUT_MS = 15 * 60_000;
const FILE_POLL_INTERVAL_MS = 5_000;
const GENERATE_TIMEOUT_MS = 10 * 60_000;
const GENERATE_MAX_ATTEMPTS = 4;
const GENERATE_RETRYABLE = new Set([429, 500, 503, 504]);
const MAX_OUTPUT_TOKENS = 64_000;
// One frame per second, Google's default, stated explicitly. Do NOT lower it to
// save tokens: at 0.1 fps the model dropped the speech after the last sampled
// frame (the final 5-8 s of a 305 s video, both Flash-Lite 3.5 and Flash 3.8,
// probed 2026-10-18); at 1 fps it transcribed to the last word.
const VIDEO_FPS = 1;

export type TranscriptionErrorCode =
  | "source_unreachable"
  | "source_size_unknown"
  | "file_too_large"
  | "not_media"
  | "upload_failed"
  | "unreadable_media"
  | "provider_refused"
  | "transcript_truncated"
  | "unparseable_transcript"
  | "interrupted";

/** A failure with a code the consumer can act on, and the reason in words. */
export class TranscriptionError extends Error {
  constructor(
    public readonly code: TranscriptionErrorCode,
    message: string,
    public readonly httpStatus: number = 422,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export interface TranscriptSegment {
  /** Where this passage starts in the recording, in seconds. */
  startSeconds: number;
  /** The same position as the model wrote it: `MM:SS` or `H:MM:SS`. */
  start: string;
  text: string;
}

export interface ParsedTranscript {
  /**
   * ISO 639-1 codes spoken, in order of appearance; empty when nothing is
   * spoken; null when the model did not state them (seen in prod: it skipped
   * the line on a mixed recording). Never guessed from the text.
   */
  languages: string[] | null;
  segments: TranscriptSegment[];
}

// --- Source probe ----------------------------------------------------------

const EXTENSION_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  "3gp": "video/3gpp",
  avi: "video/x-msvideo",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
};

/** Content types a storage bucket answers when it was never told the real one. */
const GENERIC_CONTENT_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/**
 * The media type to hand Google. The server's own `video/*` / `audio/*` wins;
 * a GENERIC type (bucket upload without one) is resolved from the file
 * extension; anything else is not media and is refused.
 */
export function resolveMediaMimeType(contentType: string | null, url: string): string {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("video/") || type.startsWith("audio/")) return type;
  if (GENERIC_CONTENT_TYPES.has(type)) {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
    const byExt = EXTENSION_MIME[ext];
    if (byExt) return byExt;
  }
  throw new TranscriptionError(
    "not_media",
    `The URL does not point to a video or audio file (server content type "${type || "none"}"${
      GENERIC_CONTENT_TYPES.has(type) ? ", and no known media extension in the path" : ""
    }).`,
  );
}

export interface SourceInfo {
  mimeType: string;
  sizeBytes: number;
}

/** Total size from `Content-Range: bytes 0-0/12345`, else `Content-Length` of a full answer. */
function readSourceSize(res: Response): number | null {
  const range = res.headers.get("content-range");
  if (res.status === 206 && range) {
    const total = range.split("/")[1];
    if (total && total !== "*" && /^\d+$/.test(total)) return Number(total);
    return null;
  }
  const length = res.headers.get("content-length");
  return length && /^\d+$/.test(length) ? Number(length) : null;
}

/**
 * Ask the source for its first byte only (a presigned GET URL is signed for
 * GET, so no HEAD): reachability, size and type without downloading the file.
 */
export async function probeSource(url: string): Promise<SourceInfo> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new TranscriptionError(
      "source_unreachable",
      `Could not reach the file URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Release the socket: we only wanted the headers.
  await res.body?.cancel().catch(() => undefined);

  if (!res.ok) {
    throw new TranscriptionError(
      "source_unreachable",
      `The file URL answered HTTP ${res.status}${res.status === 403 ? " (expired or invalid signature?)" : ""}.`,
    );
  }
  const mimeType = resolveMediaMimeType(res.headers.get("content-type"), url);
  const sizeBytes = readSourceSize(res);
  if (sizeBytes === null) {
    throw new TranscriptionError(
      "source_size_unknown",
      "The file URL reports no size (neither Content-Range nor Content-Length); the upload needs it.",
    );
  }
  if (sizeBytes === 0) {
    throw new TranscriptionError("not_media", "The file at the URL is empty.");
  }
  if (sizeBytes > MAX_TRANSCRIPTION_BYTES) {
    throw new TranscriptionError(
      "file_too_large",
      `The file is ${(sizeBytes / 1024 ** 3).toFixed(2)} GB; the limit is 2 GB.`,
      413,
    );
  }
  return { mimeType, sizeBytes };
}

/** The URL without its query string: a presigned signature is never stored. */
export function redactSourceUrl(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

// --- Prompt + parsing ------------------------------------------------------

export const TRANSCRIPTION_PROMPT = [
  "Transcribe every word spoken in this recording, verbatim, in the language it is spoken.",
  "Do not translate, summarize, correct or clean up: keep filler words, repetitions, false starts and the grammar exactly as spoken.",
  "If the speaker switches language, write each part in the language it was spoken in.",
  "Start a new line at each sentence or short group of sentences, prefixed with the time it starts in the recording as [MM:SS] (or [H:MM:SS] past one hour).",
  "The very first line, with no time marker, is: LANGUAGES: followed by the ISO 639-1 codes of the languages spoken, comma separated, in order of first appearance.",
  "If nothing is spoken, answer exactly two lines: LANGUAGES: none, then NO SPEECH.",
  "Write nothing else: no title, no notes, no speaker labels, no descriptions of sounds.",
].join("\n");

const TIMESTAMP_LINE = /^\s*\[(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?\]\s*(.*)$/;

/**
 * Turn the model's `[MM:SS] words` lines into segments. A line without a
 * timestamp continues the previous segment (the model wrapped a paragraph).
 * The LANGUAGES / NO SPEECH answer lines are recognised with OR without a
 * time marker in front: the model wrote `[00:00] LANGUAGES: fr` on a real
 * 1-min French phone video (prod 2026-10-18), which was served as speech.
 * Fails loud on output that is neither a transcript nor the NO SPEECH answer.
 */
export function parseTranscript(raw: string): ParsedTranscript {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  let languages: string[] | null = null;
  const segments: TranscriptSegment[] = [];
  let noSpeech = false;

  for (const line of lines) {
    const ts = TIMESTAMP_LINE.exec(line);
    const body = ts ? ts[4].trim() : line;
    const lang = /^LANGUAGES?\s*:\s*(.*)$/i.exec(body);
    if (lang && languages === null) {
      const value = lang[1].trim().toLowerCase();
      languages = value === "none" || value === "" ? [] : value.split(/[,\s]+/).filter(Boolean);
      continue;
    }
    if (/^NO SPEECH\.?$/i.test(body) && segments.length === 0) {
      noSpeech = true;
      continue;
    }
    if (ts) {
      const hours = ts[1] ? Number(ts[1]) : 0;
      const minutes = Number(ts[2]);
      const seconds = Number(ts[3]);
      const start = hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ts[3]}` : `${String(minutes).padStart(2, "0")}:${ts[3]}`;
      segments.push({ startSeconds: hours * 3600 + minutes * 60 + seconds, start, text: body });
      continue;
    }
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      last.text = last.text ? `${last.text} ${line}` : line;
      continue;
    }
    throw new TranscriptionError(
      "unparseable_transcript",
      `The model answered text that is not a timed transcript (first line: "${line.slice(0, 120)}").`,
      502,
    );
  }

  const kept = segments.filter((s) => s.text.length > 0);
  if (kept.length === 0 && !noSpeech) {
    throw new TranscriptionError("unparseable_transcript", "The model answered no timed transcript lines.", 502);
  }
  return { languages, segments: kept };
}

// --- Gemini Files API + generateContent ------------------------------------

interface GeminiFile {
  name: string;
  uri: string;
  mimeType: string;
  state?: "PROCESSING" | "ACTIVE" | "FAILED" | "STATE_UNSPECIFIED";
  error?: { message?: string };
  videoMetadata?: { videoDuration?: string };
}

async function readBody(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 2000);
}

/** Stream the source straight into a Gemini Files resumable upload. */
export async function uploadSourceToGemini(params: {
  apiKey: string;
  url: string;
  source: SourceInfo;
  displayName: string;
}): Promise<GeminiFile> {
  const { apiKey, url, source, displayName } = params;
  const signal = AbortSignal.timeout(TRANSFER_TIMEOUT_MS);

  const start = await fetch(`${GEMINI_UPLOAD_BASE}/files?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(source.sizeBytes),
      "X-Goog-Upload-Header-Content-Type": source.mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
    signal,
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) {
    throw new TranscriptionError(
      start.status === 400 ? "provider_refused" : "upload_failed",
      `Google refused to start the file upload (HTTP ${start.status}): ${await readBody(start)}`,
      502,
    );
  }

  const download = await fetch(url, { method: "GET", signal });
  if (!download.ok || !download.body) {
    throw new TranscriptionError(
      "source_unreachable",
      `The file URL answered HTTP ${download.status} when downloading it (was ${source.sizeBytes} bytes at the check).`,
    );
  }
  const length = download.headers.get("content-length");
  if (length !== null && Number(length) !== source.sizeBytes) {
    await download.body.cancel().catch(() => undefined);
    throw new TranscriptionError(
      "source_unreachable",
      `The file changed between the check and the download (${source.sizeBytes} then ${length} bytes).`,
    );
  }

  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(source.sizeBytes),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: download.body,
    // Node fetch needs half-duplex to send a streamed body.
    duplex: "half",
    signal,
  } as RequestInit & { duplex: "half" });
  if (!upload.ok) {
    throw new TranscriptionError(
      upload.status === 400 ? "provider_refused" : "upload_failed",
      `Google refused the file upload (HTTP ${upload.status}): ${await readBody(upload)}`,
      502,
    );
  }
  const body = (await upload.json()) as { file?: GeminiFile };
  if (!body.file?.name || !body.file.uri) {
    throw new TranscriptionError("upload_failed", `Google's upload answer named no file: ${JSON.stringify(body).slice(0, 500)}`, 502);
  }
  return body.file;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until Google has decoded the file; FAILED means it is not readable media. */
export async function waitForGeminiFileActive(
  apiKey: string,
  file: GeminiFile,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<GeminiFile> {
  const pollMs = opts.pollMs ?? FILE_POLL_INTERVAL_MS;
  const deadline = Date.now() + (opts.timeoutMs ?? FILE_PROCESSING_TIMEOUT_MS);
  let current = file;
  while (current.state !== "ACTIVE") {
    if (current.state === "FAILED") {
      throw new TranscriptionError(
        "unreadable_media",
        `Google could not read the file as ${current.mimeType}${current.error?.message ? `: ${current.error.message}` : ""}.`,
      );
    }
    if (Date.now() > deadline) {
      throw new TranscriptionError("upload_failed", "Google was still processing the file after 15 minutes.", 502);
    }
    await sleep(pollMs);
    const res = await fetch(`${GEMINI_API_BASE}/${current.name}?key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) {
      throw new TranscriptionError("upload_failed", `Reading the uploaded file's state failed (HTTP ${res.status}): ${await readBody(res)}`, 502);
    }
    current = (await res.json()) as GeminiFile;
  }
  return current;
}

export async function deleteGeminiFile(apiKey: string, name: string): Promise<void> {
  const res = await fetch(`${GEMINI_API_BASE}/${name}?key=${encodeURIComponent(apiKey)}`, { method: "DELETE" });
  if (!res.ok) {
    console.warn(`[transcription] deleting Gemini file ${name} failed (HTTP ${res.status}); Google expires it after 48 h`);
  }
}

/** `"123.4s"` → 123.4 */
export function parseGoogleDuration(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value);
  return m ? Number(m[1]) : null;
}

export interface TranscribeResult {
  model: string;
  raw: string;
  tokensInput: number;
  tokensOutput: number;
  costLines: GeminiCostLine[];
  finishReason: string | undefined;
}

export function buildTranscriptionRequestBody(model: string, file: GeminiFile): Record<string, unknown> {
  const isVideo = file.mimeType.startsWith("video/");
  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            fileData: { mimeType: file.mimeType, fileUri: file.uri },
            ...(isVideo ? { videoMetadata: { fps: VIDEO_FPS } } : {}),
          },
          { text: TRANSCRIPTION_PROMPT },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      mediaResolution: "MEDIA_RESOLUTION_LOW",
      thinkingConfig: buildThinkingConfig(model, true),
    },
  };
}

/** One generateContent call on the uploaded file; retries only a 429/5xx/timeout. */
export async function transcribeGeminiFile(apiKey: string, model: string, file: GeminiFile): Promise<TranscribeResult> {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify(buildTranscriptionRequestBody(model, file));
  let lastError = "";
  for (let attempt = 1; attempt <= GENERATE_MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        lastError = `timed out after ${GENERATE_TIMEOUT_MS / 1000}s`;
        continue;
      }
      throw err;
    }
    if (!res.ok) {
      const text = await readBody(res);
      if (GENERATE_RETRYABLE.has(res.status) && attempt < GENERATE_MAX_ATTEMPTS) {
        lastError = `HTTP ${res.status}: ${text}`;
        await sleep(1_000 * 2 ** attempt);
        continue;
      }
      throw new TranscriptionError("provider_refused", `Gemini refused the transcription (HTTP ${res.status}): ${text}`, 502);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
      usageMetadata?: GeminiUsageMetadata;
    };
    const billed = readGeminiBilledTokens(data.usageMetadata, model, geminiCostPrefix(model));
    const candidate = data.candidates?.[0];
    const raw = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("");
    if (!candidate && data.promptFeedback?.blockReason) {
      return { model, raw: "", ...billed, finishReason: `BLOCKED:${data.promptFeedback.blockReason}` };
    }
    return { model, raw, ...billed, finishReason: candidate?.finishReason };
  }
  throw new TranscriptionError("provider_refused", `Gemini kept failing after ${GENERATE_MAX_ATTEMPTS} attempts (${lastError}).`, 502);
}

/** Refuse an answer that stopped before the end of the recording. */
export function assertTranscriptComplete(result: TranscribeResult): void {
  const reason = result.finishReason;
  if (reason === "MAX_TOKENS") {
    throw new TranscriptionError(
      "transcript_truncated",
      `The transcript hit the ${MAX_OUTPUT_TOKENS}-token output limit before the end of the recording.`,
      502,
    );
  }
  if (reason && reason !== "STOP") {
    throw new TranscriptionError("provider_refused", `Gemini stopped the transcript early (finishReason ${reason}).`, 502);
  }
}
