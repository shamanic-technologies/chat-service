// ---------------------------------------------------------------------------
// OpenAI Decisions API (gpt-6-luna) — a second TYPED-JUDGMENT vendor
//
// Same job as TypeSafe's Jev (typesafe.ts): typed questions in, probabilities
// out, billed on INPUT TOKENS ONLY ("Input costs $0.10 per 1M tokens. There are
// no cache-read, cache-write, or output-token charges", Decisions guide, read
// 2026-10-21). It exists here so a caller can name it on the judgments door and
// benchmark it against Jev on the same inputs; it is never a fallback for Jev.
//
// The judgments door speaks TypeSafe's dialect (noul / choice / score, answers
// keyed by the caller's question key). This file translates both ways and
// refuses what it cannot translate WITHOUT inventing meaning:
//   - noul  -> `predicate`, answer `probability` -> `noul`.
//   - choice -> `choice` with `choices[{value, description}]`, answer
//     probabilities array -> the map our callers already read.
//   - score: refused (400). Luna's `score` field is not documented as the same
//     probability-weighted position Jev serves, and a number that LOOKS like
//     Jev's but means something else is worse than a named refusal.
//   - a noul's `criteria` and a choice option's `examples`: refused (400);
//     Luna has no field for them and folding them into the instructions would
//     rewrite the caller's question.
// Retries: connect phase and a 429 that is not an empty balance, same schedule
// as every other vendor here. Never a retry of a completed 4xx/5xx.
// ---------------------------------------------------------------------------

import { isTransientConnectError, jittered, parseRetryAfterMs } from "./openai-compatible.js";
import type { PreparedJudgmentImage } from "./judgment-image.js";
import type { TypeSafeAnswer, TypeSafeQuestion } from "./typesafe.js";

const DECISIONS_API_URL = "https://api.openai.com/v1/decisions";

/** key-service provider slug — the same platform OpenAI key `/complete` uses. */
export const OPENAI_DECISIONS_PROVIDER = "openai";

/** The only Decisions model OpenAI serves today; pinned, so the cost name always describes it. */
export const OPENAI_DECISIONS_MODEL = "gpt-6-luna";

/**
 * "Prompts with more than 272K input tokens are priced at 2x input and cache
 * rates ... for the full request" (gpt-6-luna model page, read 2026-10-21).
 */
export const OPENAI_DECISIONS_LONG_CONTEXT_THRESHOLD = 272_000;

const CONNECT_RETRY_DELAYS_MS = [250, 500, 1000];
const BUSY_BACKOFF_MS = [500, 1500, 3500, 7500];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenAiDecisionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiDecisionsError";
  }
}

/** A request shape OpenAI (or our translation) refuses forever: 400, never a retry. */
export class OpenAiDecisionsInvalidRequestError extends OpenAiDecisionsError {
  constructor(
    message: string,
    readonly status: number,
    readonly vendorMessage: string,
  ) {
    super(message);
    this.name = "OpenAiDecisionsInvalidRequestError";
  }
}

export class OpenAiDecisionsRateLimitError extends OpenAiDecisionsError {
  constructor(
    message: string,
    readonly attempts: number,
    readonly waitedMs: number,
    readonly vendorMessage: string,
  ) {
    super(message);
    this.name = "OpenAiDecisionsRateLimitError";
  }
}

export interface OpenAiDecisionsOptions {
  apiKey: string;
  state?: unknown;
  questions: Record<string, TypeSafeQuestion>;
  image?: PreparedJudgmentImage;
}

export interface OpenAiDecisionsResult {
  model: string;
  answers: Record<string, TypeSafeAnswer>;
  /** The only billable quantity, as reported by the vendor. */
  inputTokens: number;
  outputTokens: number;
}

/** Translate our questions to Luna's array. Throws a 400-class error on anything untranslatable. */
export function toDecisionsQuestions(questions: Record<string, TypeSafeQuestion>): unknown[] {
  return Object.entries(questions).map(([name, q]) => {
    const refuse = (why: string) =>
      new OpenAiDecisionsInvalidRequestError(
        `[openai-decisions] question "${name}": ${why}`,
        400,
        `question "${name}": ${why}`,
      );
    switch (q.type) {
      case "noul":
        if (q.criteria) throw refuse("judge openai-luna does not support criteria on a noul question");
        return { type: "predicate", name, instructions: q.instructions };
      case "choice":
        return {
          type: "choice",
          name,
          instructions: q.instructions,
          choices: Object.entries(q.criteria).map(([value, c]) => {
            if (typeof c === "string") return { value, description: c };
            if (c.examples && c.examples.length > 0) {
              throw refuse("judge openai-luna does not support examples on a choice option");
            }
            return { value, description: c.what };
          }),
        };
      case "score":
        throw refuse("judge openai-luna does not support score questions (use judge jev)");
    }
  });
}

/** Luna's input: the caller's state as text (JSON when structured), then the image. */
export function toDecisionsInput(state: unknown, image?: PreparedJudgmentImage): unknown {
  const content: unknown[] = [];
  if (state !== undefined) {
    content.push({ type: "input_text", text: typeof state === "string" ? state : JSON.stringify(state) });
  }
  if (image) {
    content.push({ type: "input_image", image_url: `data:image/${image.format};base64,${image.base64}` });
  }
  return [{ role: "user", content }];
}

const isProbability = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Translate Luna's answers back to our dialect, failing loud on anything missing. */
export function fromDecisionsAnswers(
  questions: Record<string, TypeSafeQuestion>,
  raw: unknown,
): Record<string, TypeSafeAnswer> {
  if (!Array.isArray(raw)) throw new OpenAiDecisionsError("[openai-decisions] response carries no answers array");
  const byName = new Map<string, Record<string, unknown>>();
  for (const a of raw) {
    if (a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string") {
      byName.set((a as { name: string }).name, a as Record<string, unknown>);
    }
  }
  const answers: Record<string, TypeSafeAnswer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const a = byName.get(key);
    if (!a) throw new OpenAiDecisionsError(`[openai-decisions] response is missing an answer for question "${key}"`);
    if (a.type === "refusal") {
      throw new OpenAiDecisionsError(`[openai-decisions] the model refused to answer question "${key}"`);
    }
    if (q.type === "noul") {
      if (a.type !== "predicate" || !isProbability(a.probability)) {
        throw new OpenAiDecisionsError(`[openai-decisions] answer "${key}" carries no predicate probability in 0..1`);
      }
      answers[key] = { type: "noul", noul: a.probability };
    } else if (q.type === "choice") {
      const probs = a.probabilities;
      if (a.type !== "choice" || typeof a.choice !== "string" || !isProbability(a.confidence) || !Array.isArray(probs)) {
        throw new OpenAiDecisionsError(`[openai-decisions] choice answer "${key}" is missing choice / confidence / probabilities`);
      }
      const map: Record<string, number> = {};
      for (const p of probs as Array<{ value?: unknown; probability?: unknown }>) {
        if (typeof p.value !== "string" || !isProbability(p.probability)) {
          throw new OpenAiDecisionsError(`[openai-decisions] choice answer "${key}" has a malformed probability entry`);
        }
        map[p.value] = p.probability;
      }
      answers[key] = { type: "choice", choice: a.choice, confidence: a.confidence, probabilities: map };
    }
  }
  return answers;
}

function vendorMessage(raw: string): { message: string; code?: string } {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; code?: string; type?: string } };
    if (parsed.error?.message) {
      return { message: parsed.error.message, code: parsed.error.code ?? parsed.error.type };
    }
  } catch {
    // Not JSON: the raw body is the most honest thing we have.
  }
  return { message: raw.slice(0, 500) };
}

/** A served model must be the pinned one (a dated build of it is accepted). */
function isPinnedModel(served: unknown): served is string {
  return (
    typeof served === "string" &&
    (served === OPENAI_DECISIONS_MODEL || /^gpt-6-luna-\d{4}-\d{2}-\d{2}$/.test(served))
  );
}

export async function judgeWithOpenAiDecisions(
  options: OpenAiDecisionsOptions,
): Promise<OpenAiDecisionsResult> {
  const { apiKey, state, questions, image } = options;
  const body = JSON.stringify({
    model: OPENAI_DECISIONS_MODEL,
    input: toDecisionsInput(state, image),
    questions: toDecisionsQuestions(questions),
  });

  let connectAttempt = 0;
  let busyAttempt = 0;
  let busyWaitedMs = 0;

  for (;;) {
    let res: Response;
    try {
      res = await fetch(DECISIONS_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
      const raw = await res.text().catch(() => "");
      const { message, code } = vendorMessage(raw);
      // An empty balance does not clear by waiting: no retry, a plain 502.
      if (res.status === 429 && code !== "insufficient_quota") {
        if (busyAttempt < BUSY_BACKOFF_MS.length) {
          const waitMs =
            parseRetryAfterMs(res.headers.get("retry-after")) ?? jittered(BUSY_BACKOFF_MS[busyAttempt] ?? 7500);
          busyWaitedMs += waitMs;
          busyAttempt += 1;
          await sleep(waitMs);
          continue;
        }
        throw new OpenAiDecisionsRateLimitError(
          `[openai-decisions] rate limited after ${busyAttempt + 1} attempts over ${Math.round(busyWaitedMs)}ms: ${message}`,
          busyAttempt + 1,
          Math.round(busyWaitedMs),
          message,
        );
      }
      if (res.status === 400 || res.status === 422) {
        throw new OpenAiDecisionsInvalidRequestError(
          `[openai-decisions] refused the request (${res.status}): ${message}`,
          res.status,
          message,
        );
      }
      throw new OpenAiDecisionsError(`[openai-decisions] POST /v1/decisions returned ${res.status}: ${message}`);
    }

    const parsed = (await res.json()) as {
      model?: unknown;
      answers?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    if (!isPinnedModel(parsed.model)) {
      throw new OpenAiDecisionsError(
        `[openai-decisions] requested model "${OPENAI_DECISIONS_MODEL}" but the response was served by ` +
          `"${String(parsed.model)}", which this service does not price`,
      );
    }
    const answers = fromDecisionsAnswers(questions, parsed.answers);
    const inputTokens = parsed.usage?.input_tokens;
    if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens < 0) {
      throw new OpenAiDecisionsError(
        `[openai-decisions] response carries no usable usage.input_tokens (got ${JSON.stringify(inputTokens)})`,
      );
    }
    const outputTokens = typeof parsed.usage?.output_tokens === "number" ? parsed.usage.output_tokens : 0;
    return { model: parsed.model, answers, inputTokens, outputTokens };
  }
}
