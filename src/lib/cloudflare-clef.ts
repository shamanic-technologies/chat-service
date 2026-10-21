// ---------------------------------------------------------------------------
// Cloudflare Clef / Clef-flash (Workers AI) — a third TYPED-JUDGMENT vendor
//
// Clef speaks TypeSafe's System One dialect byte for byte (noul / choice /
// score questions keyed by the caller, answers with their distribution), so
// questions and answers pass through unchanged and are validated by the same
// rules as Jev's. What differs is the transport: Workers AI's `/ai/run` on our
// Cloudflare account, the result wrapped in `{ success, result }`, images as
// an `images` array of base64 (max 4, 4 MiB each), never remote URLs.
//
// Billing (account model catalog, read 2026-10-21): input tokens only —
// clef $0.24/M, clef-flash $0.038/M, output $0. Each model has its own cost
// name; the model id is pinned and the served `model` must echo it.
// Never a fallback to another judge: a failure here is named "Cloudflare Clef".
// ---------------------------------------------------------------------------

import { isTransientConnectError, jittered, parseRetryAfterMs } from "./openai-compatible.js";
import type { PreparedJudgmentImage } from "./judgment-image.js";
import { parseTypeSafeAnswers, type TypeSafeAnswer, type TypeSafeQuestion } from "./typesafe.js";

/** key-service platform providers: the Workers AI token and the account it runs on. */
export const CLOUDFLARE_WORKERS_AI_PROVIDER = "cloudflare-workers-ai";
export const CLOUDFLARE_WORKERS_AI_ACCOUNT_PROVIDER = "cloudflare-workers-ai-account-id";

export const CLEF_MODELS = ["clef", "clef-flash"] as const;
export type ClefModel = (typeof CLEF_MODELS)[number];

/** Clef refuses an image over 4 MiB decoded (model schema, read 2026-10-21). */
export const CLEF_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

const CONNECT_RETRY_DELAYS_MS = [250, 500, 1000];
const BUSY_BACKOFF_MS = [500, 1500, 3500, 7500];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ClefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClefError";
  }
}

export class ClefInvalidRequestError extends ClefError {
  constructor(
    message: string,
    readonly status: number,
    readonly vendorMessage: string,
  ) {
    super(message);
    this.name = "ClefInvalidRequestError";
  }
}

export class ClefRateLimitError extends ClefError {
  constructor(
    message: string,
    readonly attempts: number,
    readonly waitedMs: number,
    readonly vendorMessage: string,
  ) {
    super(message);
    this.name = "ClefRateLimitError";
  }
}

export interface ClefJudgeOptions {
  apiKey: string;
  accountId: string;
  model: ClefModel;
  state?: unknown;
  questions: Record<string, TypeSafeQuestion>;
  image?: PreparedJudgmentImage;
}

export interface ClefJudgeResult {
  model: string;
  answers: Record<string, TypeSafeAnswer>;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The wire body. Clef REQUIRES a state; an image-only request sends an empty
 * one rather than words of ours (probed 2026-10-21: `""` is accepted, an
 * absent state is a 400).
 */
export function buildClefBody(options: Pick<ClefJudgeOptions, "model" | "state" | "questions" | "image">) {
  const { model, state, questions, image } = options;
  if (image && Buffer.byteLength(image.base64, "base64") > CLEF_IMAGE_MAX_BYTES) {
    throw new ClefInvalidRequestError(
      `[clef] image is over Clef's ${CLEF_IMAGE_MAX_BYTES}-byte limit after preparation`,
      400,
      "image over 4 MiB after preparation",
    );
  }
  return {
    model,
    state: state ?? "",
    questions,
    ...(image ? { images: [{ content_type: `image/${image.format}`, base64: image.base64 }] } : {}),
  };
}

function vendorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { errors?: Array<{ message?: string }> };
    const msg = parsed.errors?.map((e) => e.message).filter(Boolean).join("; ");
    if (msg) return msg;
  } catch {
    // Not JSON: the raw body is the most honest thing we have.
  }
  return raw.slice(0, 500);
}

export async function judgeWithClef(options: ClefJudgeOptions): Promise<ClefJudgeResult> {
  const { apiKey, accountId, model, questions } = options;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${model}`;
  const body = JSON.stringify(buildClefBody(options));

  let connectAttempt = 0;
  let busyAttempt = 0;
  let busyWaitedMs = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        // Cloudflare edge-bans requests with no recognisable user agent (error 1010).
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "chat-service/1.0" },
        body,
      });
    } catch (err) {
      if (isTransientConnectError(err) && connectAttempt < CONNECT_RETRY_DELAYS_MS.length) {
        await sleep(CONNECT_RETRY_DELAYS_MS[connectAttempt] ?? 1000);
        connectAttempt += 1;
        continue;
      }
      throw err;
    }

    if (!res.ok) {
      const message = vendorMessage(await res.text().catch(() => ""));
      if (res.status === 429) {
        if (busyAttempt < BUSY_BACKOFF_MS.length) {
          const waitMs = parseRetryAfterMs(res.headers.get("retry-after")) ?? jittered(BUSY_BACKOFF_MS[busyAttempt] ?? 7500);
          busyWaitedMs += waitMs;
          busyAttempt += 1;
          await sleep(waitMs);
          continue;
        }
        throw new ClefRateLimitError(
          `[clef] rate limited after ${busyAttempt + 1} attempts over ${Math.round(busyWaitedMs)}ms: ${message}`,
          busyAttempt + 1,
          Math.round(busyWaitedMs),
          message,
        );
      }
      if (res.status === 400 || res.status === 413 || res.status === 422) {
        throw new ClefInvalidRequestError(`[clef] refused the request (${res.status}): ${message}`, res.status, message);
      }
      throw new ClefError(`[clef] POST /ai/run/@cf/cloudflare/${model} returned ${res.status}: ${message}`);
    }

    const parsed = (await res.json()) as {
      result?: { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
    };
    const result = parsed.result;
    if (!result) throw new ClefError("[clef] response carries no result");
    if (result.model !== model) {
      throw new ClefError(
        `[clef] requested model "${model}" but the response was served by "${String(result.model)}", which this service does not price`,
      );
    }
    const answers = parseTypeSafeAnswers(questions, result.answers, "clef");
    const inputTokens = result.usage?.input_tokens;
    if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens < 0) {
      throw new ClefError(`[clef] response carries no usable usage.input_tokens (got ${JSON.stringify(inputTokens)})`);
    }
    const outputTokens = typeof result.usage?.output_tokens === "number" ? result.usage.output_tokens : 0;
    return { model, answers, inputTokens, outputTokens };
  }
}
