// The background half of POST /internal/platform-transcriptions: one job =
// upload → wait → transcribe → declare cost → store. Every failure lands on the
// row with its code and reason, and on the platform run as `failed`.

import { and, eq, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema.js";
import { transcriptions, type Transcription } from "../db/schema.js";
import { resolvePlatformKey } from "./key-client.js";
import { addPlatformRunCosts, updatePlatformRunStatus, type CostItem } from "./runs-client.js";
import {
  TRANSCRIPTION_STALE_AFTER_MS,
  TranscriptionError,
  assertTranscriptComplete,
  deleteGeminiFile,
  parseGoogleDuration,
  parseTranscript,
  transcribeGeminiFile,
  uploadSourceToGemini,
  waitForGeminiFileActive,
  type SourceInfo,
} from "./transcription.js";

type Db = PostgresJsDatabase<typeof schema>;

const SERVICE = "chat-service";
const ROUTE = "/internal/platform-transcriptions";

export interface TranscriptionJobInput {
  id: string;
  runId: string;
  /** The FULL url (signature included): held in memory only, never stored. */
  url: string;
  model: string;
  source: SourceInfo;
}

export async function runTranscriptionJob(db: Db, job: TranscriptionJobInput): Promise<void> {
  let apiKey: string | null = null;
  let fileName: string | null = null;
  let failed = false;
  try {
    apiKey = (await resolvePlatformKey("google", { method: "POST", path: ROUTE })).key;
    const uploaded = await uploadSourceToGemini({ apiKey, url: job.url, source: job.source, displayName: `transcription-${job.id}` });
    fileName = uploaded.name;
    const file = await waitForGeminiFileActive(apiKey, uploaded);

    const result = await transcribeGeminiFile(apiKey, job.model, file);
    // The call spent: declare it BEFORE judging the answer, so a truncated or
    // unparseable transcript is still billed. Throws (job fails) if undeclarable.
    const costItems: CostItem[] = result.costLines.map((l) => ({ ...l, costSource: "platform" as const }));
    await addPlatformRunCosts(job.runId, SERVICE, costItems);

    assertTranscriptComplete(result);
    const parsed = parseTranscript(result.raw);

    await db
      .update(transcriptions)
      .set({
        status: "completed",
        languages: parsed.languages,
        segments: parsed.segments,
        durationSeconds: parseGoogleDuration(file.videoMetadata?.videoDuration),
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
        completedAt: new Date(),
      })
      .where(eq(transcriptions.id, job.id));
    console.log(
      `[transcription] ${job.id} completed | model=${job.model} | bytes=${job.source.sizeBytes}` +
        ` | segments=${parsed.segments.length} | languages=${parsed.languages.join(",")}` +
        ` | in=${result.tokensInput} | out=${result.tokensOutput}`,
    );
  } catch (err) {
    failed = true;
    const code = err instanceof TranscriptionError ? err.code : "provider_refused";
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[transcription] ${job.id} failed | code=${code} | ${message}`);
    await db
      .update(transcriptions)
      .set({ status: "failed", errorCode: code, errorMessage: message.slice(0, 2000), completedAt: new Date() })
      .where(eq(transcriptions.id, job.id))
      .catch((dbErr) => console.error(`[transcription] ${job.id} could not store its failure:`, dbErr));
  } finally {
    if (apiKey && fileName) await deleteGeminiFile(apiKey, fileName).catch((e) => console.warn(`[transcription] delete failed:`, e));
    await updatePlatformRunStatus(job.runId, SERVICE, failed ? "failed" : "completed").catch((e) =>
      console.error(`[transcription] ${job.id} could not finalize run ${job.runId}:`, e),
    );
  }
}

/**
 * A job still `processing` past the stale bound was cut off (container
 * restart mid-job): store it as failed so the caller starts it again rather
 * than waiting forever.
 */
export async function readTranscription(db: Db, id: string, now = new Date()): Promise<Transcription | null> {
  const [row] = await db.select().from(transcriptions).where(eq(transcriptions.id, id));
  if (!row) return null;
  if (row.status === "processing" && now.getTime() - row.createdAt.getTime() > TRANSCRIPTION_STALE_AFTER_MS) {
    const [updated] = await db
      .update(transcriptions)
      .set({
        status: "failed",
        errorCode: "interrupted",
        errorMessage: "The job was interrupted (service restart) before it finished. Start it again.",
        completedAt: now,
      })
      .where(and(eq(transcriptions.id, id), eq(transcriptions.status, "processing"), lt(transcriptions.createdAt, new Date(now.getTime() - TRANSCRIPTION_STALE_AFTER_MS))))
      .returning();
    return updated ?? row;
  }
  return row;
}

/** The served body of one job (GET and the 202 of POST). */
export function toTranscriptionBody(row: Transcription) {
  const segments = row.segments ?? null;
  return {
    id: row.id,
    status: row.status,
    model: row.model,
    source: { url: row.sourceUrl, mimeType: row.mimeType, sizeBytes: row.sizeBytes },
    ...(row.status === "completed"
      ? {
          languages: row.languages ?? [],
          durationSeconds: row.durationSeconds,
          segments: segments ?? [],
          text: (segments ?? []).map((s) => s.text).join("\n"),
          tokensInput: row.tokensInput,
          tokensOutput: row.tokensOutput,
        }
      : {}),
    ...(row.status === "failed" ? { error: { code: row.errorCode, message: row.errorMessage } } : {}),
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
