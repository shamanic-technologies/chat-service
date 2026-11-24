// ---------------------------------------------------------------------------
// Transcription of a long audio/video recording on OUR OWN server (REELS-1124).
//
// A 1-2 h, 1-2 GB interview is transcribed with WORD-level timestamps by an
// open speech model (onnx-asr) running in the `transcriber/` sidecar, on
// our CPU. No vendor, no key, no cost line, no hold: the run carries $0 by
// having no cost line. chat-service owns the contract, the job row
// (`media_transcriptions`) and the run; the sidecar only receives bytes.
//
// Flow: POST /orgs/media-transcriptions checks the source, opens an org run,
// stores a `downloading` row and answers 202. In the background the source is
// streamed (through `publicFetch`: the URL is a caller's) straight into the
// sidecar's `PUT /jobs/{id}/media`, never buffered. The row is then
// `transcribing`; an in-process tick reads the sidecar's progress and, once it
// is done, stores the transcript and closes the run.
//
// Restart: a download lives in this process's memory, so a `downloading` row
// no process holds is `interrupted`. A `transcribing` row needs nothing from
// this process: the tick picks it up again, and the sidecar restarts its own
// queue from its job files.
// ---------------------------------------------------------------------------

import { and, asc, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema.js";
import { mediaTranscriptions, type MediaTranscriptSegment, type MediaTranscriptWord } from "../db/schema.js";
import { updateRunStatus } from "./runs-client.js";
import { PUBLIC_ONLY_MESSAGE, PublicUrlRefusedError, publicFetch } from "./safe-fetch.js";
import { stripNul } from "./strip-nul.js";
import type { SourceInfo } from "./transcription.js";

type Db = PostgresJsDatabase<typeof schema>;

/** The largest recording this route takes (a 2 h phone video is 1-2 GB). */
export const MAX_MEDIA_TRANSCRIPTION_BYTES = 4 * 1024 * 1024 * 1024;

export const MEDIA_TRANSCRIPTION_STATUSES = ["downloading", "transcribing", "completed", "failed"] as const;
export type MediaTranscriptionStatus = (typeof MEDIA_TRANSCRIPTION_STATUSES)[number];

/** Why a started job failed (stored on the row, served in `error.code`). */
export const MEDIA_TRANSCRIPTION_JOB_ERROR_CODES = [
  "source_unreachable",
  "box_transcriber_unreachable",
  "transcription_failed",
  "interrupted",
] as const;
export type MediaTranscriptionJobErrorCode = (typeof MEDIA_TRANSCRIPTION_JOB_ERROR_CODES)[number];

export const CHARGED_NOTHING = { usd: 0, reason: "Runs on our own server: no vendor is paid." } as const;

export const INTERRUPTED_DOWNLOAD_MESSAGE = "The download was cut by a service restart. Start it again with a new idempotencyKey.";
export const LOST_ON_BOX_MESSAGE = "Our transcriber no longer holds this job (its files were lost). Start it again with a new idempotencyKey.";

/** A `downloading` row no process holds, older than this, was cut by a restart. */
export const ORPHAN_DOWNLOAD_AFTER_MS = 2 * 60_000;
/** A row being transcribed that our transcriber has not answered about for this long is failed: never "transcribing" forever. */
export const BOX_SILENT_FAIL_AFTER_MS = 30 * 60_000;
export const BOX_SILENT_MESSAGE = "Our transcriber has not answered for 30 minutes. Start it again with a new idempotencyKey.";
export const TICK_INTERVAL_MS = 15_000;
export const FIRST_TICK_AFTER_MS = 60_000;

const DOWNLOAD_TIMEOUT_MS = 90 * 60_000;
const SIDECAR_TIMEOUT_MS = 30_000;
const SIDECAR_RESULT_TIMEOUT_MS = 120_000;
const SERVICE = "chat-service";

// --- Config ----------------------------------------------------------------

export interface BoxTranscriberConfig {
  url: string;
  apiKey: string;
}

/** Both env vars or nothing: unset = the route answers 503, never a silent other path. */
export function boxTranscriberConfig(env: NodeJS.ProcessEnv = process.env): BoxTranscriberConfig | null {
  const url = env.TRANSCRIBER_SERVICE_URL?.trim();
  const apiKey = env.TRANSCRIBER_SERVICE_API_KEY?.trim();
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ""), apiKey };
}

// --- Pure logic ------------------------------------------------------------

export interface SidecarWord {
  start: number;
  end: number;
  word: string;
  probability: number;
}

export interface SidecarSegment {
  start: number;
  end: number;
  text: string;
  words: SidecarWord[];
}

export interface SidecarResult {
  language: string | null;
  languageProbability: number | null;
  durationSeconds: number | null;
  computeSeconds: number | null;
  model: string | null;
  segments: SidecarSegment[];
}

export interface SidecarJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  model: string | null;
  language: string | null;
  languageProbability: number | null;
  durationSeconds: number | null;
  transcribedSeconds: number | null;
  computeSeconds: number | null;
  error: string | null;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The sidecar's nested result (segments each holding their words) as the two
 * flat lists we store. Throws on a shape that is not a transcript: a result we
 * cannot read is a failure, never an empty transcript.
 */
export function flattenBoxResult(result: unknown): { segments: MediaTranscriptSegment[]; words: MediaTranscriptWord[] } {
  const raw = (result as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(raw)) throw new Error("the transcriber's result carries no segments list");
  const segments: MediaTranscriptSegment[] = [];
  const words: MediaTranscriptWord[] = [];
  raw.forEach((s: Partial<SidecarSegment> | null, i) => {
    if (!s || !isNumber(s.start) || !isNumber(s.end) || typeof s.text !== "string") {
      throw new Error(`the transcriber's segment ${i} has no start, end or text`);
    }
    segments.push({ startSeconds: s.start, endSeconds: s.end, text: s.text });
    for (const w of Array.isArray(s.words) ? s.words : []) {
      if (!w || !isNumber(w.start) || !isNumber(w.end) || typeof w.word !== "string") {
        throw new Error(`a word of the transcriber's segment ${i} has no start, end or text`);
      }
      words.push({ startSeconds: w.start, endSeconds: w.end, word: w.word, probability: isNumber(w.probability) ? w.probability : 0 });
    }
  });
  return { segments, words };
}

export interface SecondsRange {
  fromSeconds?: number;
  toSeconds?: number;
}

/** The segments that OVERLAP the range (a segment cut by a bound is served whole). */
export function segmentsInRange(segments: MediaTranscriptSegment[], range: SecondsRange): MediaTranscriptSegment[] {
  const from = range.fromSeconds ?? Number.NEGATIVE_INFINITY;
  const to = range.toSeconds ?? Number.POSITIVE_INFINITY;
  return segments.filter((s) => s.endSeconds > from && s.startSeconds < to);
}

/** The words that START in `[from, to)`: consecutive ranges serve every word exactly once. */
export function wordsInRange(words: MediaTranscriptWord[], range: SecondsRange): MediaTranscriptWord[] {
  const from = range.fromSeconds ?? Number.NEGATIVE_INFINITY;
  const to = range.toSeconds ?? Number.POSITIVE_INFINITY;
  return words.filter((w) => w.startSeconds >= from && w.startSeconds < to);
}

export type MediaTranscriptionInclude = "segments" | "words";

/** `"segments,words"` → the set asked for. The schema already refused any other value. */
export function parseInclude(include: string | undefined): Set<MediaTranscriptionInclude> {
  const out = new Set<MediaTranscriptionInclude>();
  for (const part of (include ?? "").split(",")) {
    if (part === "segments" || part === "words") out.add(part);
  }
  return out;
}

/**
 * How much of the recording's audio is transcribed, 0..1. The download does
 * not count; 1 only once completed (trailing silence is never "transcribed").
 */
export function progressFraction(status: MediaTranscriptionStatus, transcribedSeconds: number | null, durationSeconds: number | null): number {
  if (status === "completed") return 1;
  if (!durationSeconds || durationSeconds <= 0 || !transcribedSeconds) return 0;
  return Math.min(1, Math.max(0, Math.floor((transcribedSeconds / durationSeconds) * 1000) / 1000));
}

// --- Rows ------------------------------------------------------------------

/** Every column but the transcript itself: a status poll never loads the 1.5 MB of words. */
const SUMMARY_COLUMNS = {
  id: mediaTranscriptions.id,
  orgId: mediaTranscriptions.orgId,
  userId: mediaTranscriptions.userId,
  status: mediaTranscriptions.status,
  sourceUrl: mediaTranscriptions.sourceUrl,
  mimeType: mediaTranscriptions.mimeType,
  sizeBytes: mediaTranscriptions.sizeBytes,
  runId: mediaTranscriptions.runId,
  model: mediaTranscriptions.model,
  language: mediaTranscriptions.language,
  languageProbability: mediaTranscriptions.languageProbability,
  durationSeconds: mediaTranscriptions.durationSeconds,
  transcribedSeconds: mediaTranscriptions.transcribedSeconds,
  computeSeconds: mediaTranscriptions.computeSeconds,
  segmentCount: mediaTranscriptions.segmentCount,
  wordCount: mediaTranscriptions.wordCount,
  errorCode: mediaTranscriptions.errorCode,
  errorMessage: mediaTranscriptions.errorMessage,
  createdAt: mediaTranscriptions.createdAt,
  completedAt: mediaTranscriptions.completedAt,
} as const;

export interface MediaTranscriptionSummary {
  id: string;
  orgId: string;
  userId: string;
  status: MediaTranscriptionStatus;
  sourceUrl: string;
  mimeType: string | null;
  sizeBytes: number | null;
  runId: string | null;
  model: string | null;
  language: string | null;
  languageProbability: number | null;
  durationSeconds: number | null;
  transcribedSeconds: number | null;
  computeSeconds: number | null;
  segmentCount: number | null;
  wordCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface MediaTranscriptParts {
  segments?: MediaTranscriptSegment[];
  words?: MediaTranscriptWord[];
}

/** The served body: the summary, plus the transcript parts a caller asked for. */
export function toMediaTranscriptionBody(row: MediaTranscriptionSummary, parts: MediaTranscriptParts = {}) {
  return {
    id: row.id,
    status: row.status,
    source: { url: row.sourceUrl, mimeType: row.mimeType, sizeBytes: row.sizeBytes },
    model: row.model,
    language: row.language,
    languageProbability: row.languageProbability,
    durationSeconds: row.durationSeconds,
    progress: {
      transcribedSeconds: row.transcribedSeconds ?? 0,
      durationSeconds: row.durationSeconds,
      fraction: progressFraction(row.status, row.transcribedSeconds, row.durationSeconds),
    },
    segmentCount: row.segmentCount,
    wordCount: row.wordCount,
    usage: { audioSeconds: row.durationSeconds, computeSeconds: row.computeSeconds },
    charged: CHARGED_NOTHING,
    ...(row.status === "failed" ? { error: { code: row.errorCode, message: row.errorMessage } } : {}),
    ...(parts.segments ? { segments: parts.segments, text: parts.segments.map((s) => s.text).join("\n") } : {}),
    ...(parts.words ? { words: parts.words } : {}),
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

export async function findMediaTranscriptionByKey(db: Db, orgId: string, idempotencyKey: string): Promise<MediaTranscriptionSummary | null> {
  const [row] = await db
    .select(SUMMARY_COLUMNS)
    .from(mediaTranscriptions)
    .where(and(eq(mediaTranscriptions.orgId, orgId), eq(mediaTranscriptions.idempotencyKey, idempotencyKey)));
  return row ?? null;
}

export interface NewMediaTranscription {
  id: string;
  orgId: string;
  userId: string;
  idempotencyKey: string | null;
  sourceUrl: string;
  source: SourceInfo;
  languageHint: string | null;
}

/**
 * Store the `downloading` row. Null when the same org + idempotencyKey won a
 * race a moment earlier (the partial unique index): the caller answers that row.
 */
export async function insertMediaTranscription(db: Db, input: NewMediaTranscription): Promise<MediaTranscriptionSummary | null> {
  const [row] = await db
    .insert(mediaTranscriptions)
    .values({
      id: input.id,
      orgId: input.orgId,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      status: "downloading",
      sourceUrl: input.sourceUrl,
      mimeType: input.source.mimeType,
      sizeBytes: input.source.sizeBytes,
      languageHint: input.languageHint,
    })
    .onConflictDoNothing()
    .returning(SUMMARY_COLUMNS);
  return row ?? null;
}

/** The run opened for the row. Returns the row as it now reads. */
export async function attachRun(db: Db, id: string, runId: string): Promise<MediaTranscriptionSummary> {
  const [row] = await db
    .update(mediaTranscriptions)
    .set({ runId, updatedAt: new Date() })
    .where(eq(mediaTranscriptions.id, id))
    .returning(SUMMARY_COLUMNS);
  if (!row) throw new Error(`[media-transcription] row ${id} vanished before its run was attached`);
  return row;
}

/** Nothing was started for this row (its run could not be opened): it never existed. */
export async function discardMediaTranscription(db: Db, id: string): Promise<void> {
  await db.delete(mediaTranscriptions).where(and(eq(mediaTranscriptions.id, id), eq(mediaTranscriptions.status, "downloading")));
}

export interface MediaTranscriptionRead extends SecondsRange {
  include: Set<MediaTranscriptionInclude>;
}

/**
 * One org's transcription, as served. Null for an unknown id AND for another
 * org's row (the same answer). The transcript columns are selected only when
 * asked for and the row is completed.
 */
export async function readMediaTranscriptionBody(
  db: Db,
  orgId: string,
  id: string,
  read: MediaTranscriptionRead,
): Promise<ReturnType<typeof toMediaTranscriptionBody> | null> {
  const where = and(eq(mediaTranscriptions.id, id), eq(mediaTranscriptions.orgId, orgId));
  const [row] = await db.select(SUMMARY_COLUMNS).from(mediaTranscriptions).where(where);
  if (!row) return null;
  if (row.status !== "completed" || read.include.size === 0) return toMediaTranscriptionBody(row);

  const parts: MediaTranscriptParts = {};
  if (read.include.has("segments")) {
    const [t] = await db.select({ segments: mediaTranscriptions.segments }).from(mediaTranscriptions).where(where);
    parts.segments = segmentsInRange(t?.segments ?? [], read);
  }
  if (read.include.has("words")) {
    const [t] = await db.select({ words: mediaTranscriptions.words }).from(mediaTranscriptions).where(where);
    parts.words = wordsInRange(t?.words ?? [], read);
  }
  return toMediaTranscriptionBody(row, parts);
}

// --- Sidecar client --------------------------------------------------------

/** The sidecar did not answer, or answered something that is not its contract. */
export class BoxTranscriberUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoxTranscriberUnreachableError";
  }
}

// The sidecar's URL comes from OUR env, never from a caller: the global fetch
// is right here (publicFetch would refuse our own internal address).
async function sidecarFetch(config: BoxTranscriberConfig, method: string, path: string, timeoutMs = SIDECAR_TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(`${config.url}${path}`, {
      method,
      headers: { "x-api-key": config.apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new BoxTranscriberUnreachableError(`${method} ${path} did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The sidecar's job; null when it holds none under this id (404). */
export async function readSidecarJob(config: BoxTranscriberConfig, id: string): Promise<SidecarJob | null> {
  const res = await sidecarFetch(config, "GET", `/jobs/${id}`);
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new BoxTranscriberUnreachableError(`GET /jobs/${id} answered HTTP ${res.status}`);
  }
  const job = (await res.json().catch(() => null)) as SidecarJob | null;
  if (!job || !["queued", "running", "completed", "failed"].includes(job.status)) {
    throw new BoxTranscriberUnreachableError(`GET /jobs/${id} answered no job status`);
  }
  return job;
}

export async function readSidecarResult(config: BoxTranscriberConfig, id: string): Promise<SidecarResult> {
  const res = await sidecarFetch(config, "GET", `/jobs/${id}/result`, SIDECAR_RESULT_TIMEOUT_MS);
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new BoxTranscriberUnreachableError(`GET /jobs/${id}/result answered HTTP ${res.status}`);
  }
  try {
    return (await res.json()) as SidecarResult;
  } catch (err) {
    throw new BoxTranscriberUnreachableError(`GET /jobs/${id}/result was cut: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Free the sidecar's files. Best effort: it purges its own after 48 h. */
export async function deleteSidecarJob(config: BoxTranscriberConfig, id: string): Promise<void> {
  try {
    const res = await sidecarFetch(config, "DELETE", `/jobs/${id}`);
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) console.warn(`[media-transcription] ${id} sidecar delete answered HTTP ${res.status} (purged there after 48 h)`);
  } catch (err) {
    console.warn(`[media-transcription] ${id} sidecar delete failed (purged there after 48 h): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Job: source → sidecar -------------------------------------------------

/** Rows whose download runs in THIS process. Anything else `downloading` was cut by a restart. */
const activeDownloads = new Set<string>();

export function holdDownload(id: string): void {
  activeDownloads.add(id);
}
export function releaseDownload(id: string): void {
  activeDownloads.delete(id);
}
export function isDownloadHeldHere(id: string): boolean {
  return activeDownloads.has(id);
}

class JobFailure extends Error {
  constructor(
    public readonly code: MediaTranscriptionJobErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface RowIdentity {
  id: string;
  orgId: string;
  userId: string;
  runId: string | null;
}

async function finalizeRun(row: RowIdentity, status: "completed" | "failed"): Promise<void> {
  if (!row.runId) return;
  // The run's own identity, rebuilt from the row: the request that opened it is long gone.
  await updateRunStatus(row.runId, status, { orgId: row.orgId, userId: row.userId, runId: row.runId }).catch((err) =>
    console.error(`[media-transcription] ${row.id} could not finalize run ${row.runId} as ${status}:`, err),
  );
}

/** Mark the row failed (only from the status it was read in) and close its run. */
async function failRow(
  db: Db,
  row: RowIdentity,
  from: "downloading" | "transcribing",
  code: MediaTranscriptionJobErrorCode,
  message: string,
): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(mediaTranscriptions)
    .set({ status: "failed", errorCode: code, errorMessage: stripNul(message).slice(0, 2000), updatedAt: now, completedAt: now })
    .where(and(eq(mediaTranscriptions.id, row.id), eq(mediaTranscriptions.status, from)))
    .returning({ id: mediaTranscriptions.id });
  if (updated.length === 0) return false;
  console.error(`[media-transcription] ${row.id} failed | code=${code} | ${message}`);
  await finalizeRun(row, "failed");
  return true;
}

export interface MediaDownloadJob extends RowIdentity {
  runId: string;
  /** The FULL url (signature included): held in memory only, never stored. */
  url: string;
  source: SourceInfo;
  languageHint: string | null;
}

/**
 * The source's bytes, counted, with a failure of the SOURCE told apart from a
 * failure of the sidecar: both surface as one rejected PUT otherwise.
 */
function countedSourceStream(body: ReadableStream<Uint8Array>, expectedBytes: number, state: { sourceError: string | null }): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        state.sourceError = `The file URL stopped answering after ${received} of ${expectedBytes} bytes: ${err instanceof Error ? err.message : String(err)}`;
        controller.error(new Error(state.sourceError));
        return;
      }
      if (chunk.done) {
        if (received !== expectedBytes) {
          state.sourceError = `The file URL sent ${received} bytes, ${expectedBytes} were announced.`;
          controller.error(new Error(state.sourceError));
          return;
        }
        controller.close();
        return;
      }
      received += chunk.value.byteLength;
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

async function streamSourceToSidecar(config: BoxTranscriberConfig, job: MediaDownloadJob): Promise<void> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let download: Response;
  try {
    // A caller's URL: public internet only, every redirect re-checked (SEC-MCP-SSRF-1120).
    // Checked again here: the name may point elsewhere since the probe.
    download = await publicFetch(job.url, { method: "GET", signal });
  } catch (err) {
    if (err instanceof PublicUrlRefusedError) throw new JobFailure("source_unreachable", `Could not reach the file URL: ${PUBLIC_ONLY_MESSAGE}.`);
    throw new JobFailure("source_unreachable", `Could not reach the file URL: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!download.ok || !download.body) {
    await download.body?.cancel().catch(() => undefined);
    throw new JobFailure(
      "source_unreachable",
      `The file URL answered HTTP ${download.status} when downloading it (was ${job.source.sizeBytes} bytes at the check).`,
    );
  }
  const length = download.headers.get("content-length");
  if (length !== null && Number(length) !== job.source.sizeBytes) {
    await download.body.cancel().catch(() => undefined);
    throw new JobFailure("source_unreachable", `The file changed between the check and the download (${job.source.sizeBytes} then ${length} bytes).`);
  }

  const state: { sourceError: string | null } = { sourceError: null };
  const query = job.languageHint ? `?language=${encodeURIComponent(job.languageHint)}` : "";
  let put: Response;
  try {
    put = await fetch(`${config.url}/jobs/${job.id}/media${query}`, {
      method: "PUT",
      headers: {
        "x-api-key": config.apiKey,
        "Content-Type": job.source.mimeType,
        "Content-Length": String(job.source.sizeBytes),
      },
      body: countedSourceStream(download.body, job.source.sizeBytes, state),
      // Node fetch needs half-duplex to send a streamed body: never buffered.
      duplex: "half",
      signal,
    } as RequestInit & { duplex: "half" });
  } catch (err) {
    if (state.sourceError) throw new JobFailure("source_unreachable", state.sourceError);
    throw new JobFailure("box_transcriber_unreachable", `Our transcriber did not take the file: ${err instanceof Error ? err.message : String(err)}`);
  }
  await put.body?.cancel().catch(() => undefined);
  if (put.ok) return;
  if (state.sourceError) throw new JobFailure("source_unreachable", state.sourceError);
  if (put.status === 400) throw new JobFailure("source_unreachable", "The file did not arrive whole from its URL.");
  throw new JobFailure("box_transcriber_unreachable", `Our transcriber refused the file (HTTP ${put.status}).`);
}

/**
 * The background half of POST: source → sidecar, then the row is
 * `transcribing` (the tick takes over). Every failure lands on the row with its
 * code and on the run as `failed`. The caller holds the download
 * (`holdDownload`) before the row exists; it is released here.
 */
export async function runMediaDownload(db: Db, config: BoxTranscriberConfig, job: MediaDownloadJob): Promise<void> {
  try {
    await streamSourceToSidecar(config, job);
    const moved = await db
      .update(mediaTranscriptions)
      .set({ status: "transcribing", updatedAt: new Date() })
      .where(and(eq(mediaTranscriptions.id, job.id), eq(mediaTranscriptions.status, "downloading")))
      .returning({ id: mediaTranscriptions.id });
    if (moved.length === 0) {
      // The row was failed meanwhile: nobody will read this job, free the sidecar.
      await deleteSidecarJob(config, job.id);
      return;
    }
    console.log(`[media-transcription] ${job.id} handed to our transcriber | bytes=${job.source.sizeBytes} | run=${job.runId}`);
  } catch (err) {
    const code = err instanceof JobFailure ? err.code : "box_transcriber_unreachable";
    const message = err instanceof Error ? err.message : String(err);
    await failRow(db, job, "downloading", code, message).catch((dbErr) =>
      console.error(`[media-transcription] ${job.id} could not store its failure:`, dbErr),
    );
  } finally {
    releaseDownload(job.id);
  }
}

// --- Tick ------------------------------------------------------------------

export interface TickOutcome {
  skipped?: true;
  completed: string[];
  failed: string[];
  progressed: string[];
  boxUnreachable: boolean;
}

let ticking = false;

/**
 * One pass over the rows still in flight. Never throws for one row's sake; a
 * sidecar that cannot be reached leaves every row as it is (logged once).
 */
export async function tickMediaTranscriptions(
  db: Db,
  opts: { now?: Date; config?: BoxTranscriberConfig | null } = {},
): Promise<TickOutcome> {
  const outcome: TickOutcome = { completed: [], failed: [], progressed: [], boxUnreachable: false };
  if (ticking) return { ...outcome, skipped: true };
  ticking = true;
  try {
    const now = opts.now ?? new Date();
    const config = opts.config === undefined ? boxTranscriberConfig() : opts.config;
    const rows = await db
      .select({
        id: mediaTranscriptions.id,
        orgId: mediaTranscriptions.orgId,
        userId: mediaTranscriptions.userId,
        runId: mediaTranscriptions.runId,
        status: mediaTranscriptions.status,
        createdAt: mediaTranscriptions.createdAt,
        updatedAt: mediaTranscriptions.updatedAt,
      })
      .from(mediaTranscriptions)
      .where(inArray(mediaTranscriptions.status, ["downloading", "transcribing"]))
      .orderBy(asc(mediaTranscriptions.createdAt));

    // Every answered pass refreshes `updatedAt`: a row our transcriber has been silent
    // about for 30 minutes is failed, so a caller never polls a dead job forever.
    const failIfBoxSilent = async (row: (typeof rows)[number]): Promise<void> => {
      if (now.getTime() - row.updatedAt.getTime() <= BOX_SILENT_FAIL_AFTER_MS) return;
      if (await failRow(db, row, "transcribing", "box_transcriber_unreachable", BOX_SILENT_MESSAGE)) outcome.failed.push(row.id);
    };

    for (const row of rows) {
      try {
        if (row.status === "downloading") {
          if (isDownloadHeldHere(row.id) || now.getTime() - row.createdAt.getTime() <= ORPHAN_DOWNLOAD_AFTER_MS) continue;
          if (await failRow(db, row, "downloading", "interrupted", INTERRUPTED_DOWNLOAD_MESSAGE)) outcome.failed.push(row.id);
          // The cut process may have delivered part or all of the file: nobody will read it.
          if (config && !outcome.boxUnreachable) await deleteSidecarJob(config, row.id);
          continue;
        }
        if (!config || outcome.boxUnreachable) {
          if (!config && !outcome.boxUnreachable) {
            console.error("[media-transcription] TRANSCRIBER_SERVICE_URL / TRANSCRIBER_SERVICE_API_KEY not set: rows being transcribed are left as they are");
            outcome.boxUnreachable = true;
          }
          await failIfBoxSilent(row);
          continue;
        }
        await advanceTranscribingRow(db, config, row, outcome);
      } catch (err) {
        if (err instanceof BoxTranscriberUnreachableError) {
          outcome.boxUnreachable = true;
          console.error(`[media-transcription] our transcriber cannot be reached, rows left as they are: ${err.message}`);
          await failIfBoxSilent(row).catch((dbErr) => console.error(`[media-transcription] ${row.id} could not store its failure:`, dbErr));
        } else {
          console.error(`[media-transcription] ${row.id} tick failed:`, err);
        }
      }
    }
    return outcome;
  } finally {
    ticking = false;
  }
}

async function advanceTranscribingRow(db: Db, config: BoxTranscriberConfig, row: RowIdentity, outcome: TickOutcome): Promise<void> {
  const job = await readSidecarJob(config, row.id);
  if (job === null) {
    if (await failRow(db, row, "transcribing", "interrupted", LOST_ON_BOX_MESSAGE)) outcome.failed.push(row.id);
    return;
  }
  if (job.status === "failed") {
    const reason = job.error ? `The recording could not be transcribed: ${job.error}` : "The recording could not be transcribed.";
    if (await failRow(db, row, "transcribing", "transcription_failed", reason)) outcome.failed.push(row.id);
    await deleteSidecarJob(config, row.id);
    return;
  }
  if (job.status !== "completed") {
    await db
      .update(mediaTranscriptions)
      .set({
        model: job.model,
        language: job.language,
        languageProbability: job.languageProbability,
        durationSeconds: job.durationSeconds,
        transcribedSeconds: job.transcribedSeconds ?? 0,
        computeSeconds: job.computeSeconds,
        updatedAt: new Date(),
      })
      .where(and(eq(mediaTranscriptions.id, row.id), eq(mediaTranscriptions.status, "transcribing")));
    outcome.progressed.push(row.id);
    return;
  }

  const result = await readSidecarResult(config, row.id);
  let flat: ReturnType<typeof flattenBoxResult>;
  try {
    // Postgres refuses NUL in jsonb: one such character would fail the whole save.
    flat = stripNul(flattenBoxResult(result));
  } catch (err) {
    const reason = `The transcript could not be read: ${err instanceof Error ? err.message : String(err)}`;
    if (await failRow(db, row, "transcribing", "transcription_failed", reason)) outcome.failed.push(row.id);
    await deleteSidecarJob(config, row.id);
    return;
  }
  const now = new Date();
  const stored = await db
    .update(mediaTranscriptions)
    .set({
      status: "completed",
      model: result.model ?? job.model,
      language: result.language ?? job.language,
      languageProbability: result.languageProbability ?? job.languageProbability,
      durationSeconds: result.durationSeconds ?? job.durationSeconds,
      transcribedSeconds: job.transcribedSeconds ?? 0,
      computeSeconds: result.computeSeconds ?? job.computeSeconds,
      segments: flat.segments,
      words: flat.words,
      segmentCount: flat.segments.length,
      wordCount: flat.words.length,
      updatedAt: now,
      completedAt: now,
    })
    .where(and(eq(mediaTranscriptions.id, row.id), eq(mediaTranscriptions.status, "transcribing")))
    .returning({ id: mediaTranscriptions.id });
  if (stored.length > 0) {
    outcome.completed.push(row.id);
    console.log(
      `[media-transcription] ${row.id} completed | model=${result.model} | language=${result.language}` +
        ` | audio=${result.durationSeconds}s | compute=${result.computeSeconds}s | segments=${flat.segments.length} | words=${flat.words.length}`,
    );
    await finalizeRun(row, "completed");
  }
  // Only once the transcript is stored: the sidecar's copy was the only one until now.
  await deleteSidecarJob(config, row.id);
}

/**
 * The in-process tick (a deploy recreates the container more often than a cron
 * fires): first pass ~60 s after boot, then every 15 s, one pass at a time.
 * Returns its stop function.
 */
export function startMediaTranscriptionTick(db: Db): () => void {
  const pass = () => {
    tickMediaTranscriptions(db).catch((err) => console.error("[media-transcription] tick failed:", err));
  };
  let interval: NodeJS.Timeout | null = null;
  const first = setTimeout(() => {
    pass();
    interval = setInterval(pass, TICK_INTERVAL_MS);
    interval.unref();
  }, FIRST_TICK_AFTER_MS);
  first.unref();
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
