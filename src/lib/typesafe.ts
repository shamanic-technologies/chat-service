// ---------------------------------------------------------------------------
// TypeSafe (typesafe.ai) — a TYPED-JUDGMENT vendor, not a text generator
//
// Every other provider this service reaches answers with prose that the caller
// parses and a token bill on both directions. TypeSafe answers with a typed
// object carrying the model's own PROBABILITY DISTRIBUTION — a yes-probability
// for a `noul`, a distribution plus a confidence for a `choice`, a weighted
// position on ordered levels for a `score` — and charges for INPUT TOKENS ONLY.
//
// Both halves are the reason this is its own surface rather than a model alias
// behind `/complete`: that route's contract is text out and a two-sided token
// bill, and serving this vendor through it would have to flatten the answer to
// its winning value (throwing away the confidence that is the whole point of
// adopting the vendor) and declare an output cost the invoice does not carry.
//
// So: separate client, separate route, one cost name. The retry schedule and
// the transport-failure predicate are SHARED with the OpenAI-compatible vendors
// deliberately — a 429 means the same thing at every vendor, and one schedule
// is one number to keep true instead of two.
// ---------------------------------------------------------------------------

import { isTransientConnectError, jittered, parseRetryAfterMs } from "./openai-compatible.js";

const TYPESAFE_API_URL = "https://api.typesafe.ai/v1/systemone";

/**
 * key-service provider slug for this vendor. The platform key is registered
 * under this identifier; nothing here ever reads a key from anywhere else.
 */
export const TYPESAFE_PROVIDER = "typesafe";

/**
 * Model values a CALLER may ask for: the vendor's two aliases and the release
 * they point at today.
 */
export const TYPESAFE_MODELS = ["jev-latest", "jev-preview", "jev-1.13.0"] as const;
export type TypeSafeModel = (typeof TYPESAFE_MODELS)[number];

/**
 * The id actually sent on the wire — always the pinned RELEASE, never an alias.
 *
 * costs-service keys the cost name on the release (`typesafe-jev-1.13-tokens-input`)
 * precisely because an alias moves to a new model without notice. If we forwarded
 * `jev-latest`, the day the alias moved we would bill a new model under the old
 * release's name and nothing would tell us: the vendor echoes the id it was asked
 * for, so the response would still read `jev-latest`. Sending the release removes
 * the ambiguity at the source — the vendor either serves that release or refuses
 * the request loudly, which is the cheap failure.
 *
 * A new Jev release is a deliberate edit here, after its own catalog row exists.
 */
export const TYPESAFE_API_MODEL_ID = "jev-1.13.0";

export const TYPESAFE_DEFAULT_MODEL: TypeSafeModel = "jev-latest";

/** Connect-phase retries: the request never reached the server, so replaying is safe. */
const CONNECT_RETRY_DELAYS_MS = [250, 500, 1000];
const MAX_CONNECT_RETRIES = CONNECT_RETRY_DELAYS_MS.length;

/**
 * Backoff for the two statuses the vendor itself tells us to back off on: 429
 * (rate limit) and 529 (overloaded). Both mean no model ran and nothing was
 * billed, while the run that made the call has already paid for its upstream
 * work — so dropping the judgment throws that spend away for a refusal that
 * usually clears in a second.
 *
 * Jittered ±25%: the requests that collide are the ones that started together,
 * so an unjittered schedule marches them back into the same contended slot.
 */
const BUSY_BACKOFF_MS = [500, 1500, 3500, 7500];
const MAX_BUSY_RETRIES = BUSY_BACKOFF_MS.length;

/** Vendor statuses that mean "not now" rather than "not ever". */
const RATE_LIMIT_STATUS = 429;
const OVERLOADED_STATUS = 529;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TypeSafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeSafeError";
  }
}

/**
 * The vendor refused the SHAPE of the request (422), or the request was
 * malformed enough to draw a 400.
 *
 * Separate class because the identical request will be refused forever: "try
 * again" is false advice, and a retry burns a hold for a certainty. Carries the
 * vendor's own words so the caller learns what to change.
 */
export class TypeSafeInvalidRequestError extends TypeSafeError {
  constructor(
    message: string,
    readonly status: number,
    readonly vendorMessage: string,
  ) {
    super(message);
    this.name = "TypeSafeInvalidRequestError";
  }
}

/**
 * The vendor kept refusing new work for the whole retry budget.
 *
 * Carries the attempt count and the wall-clock wait so a persistently saturated
 * vendor stays VISIBLE rather than being smoothed away by the retry in front of
 * it — the route answers 429 with these numbers rather than folding it into a
 * generic 502, because a rate limit is not an outage and the caller can retry.
 */
export class TypeSafeRateLimitError extends TypeSafeError {
  constructor(
    message: string,
    readonly attempts: number,
    readonly waitedMs: number,
    readonly vendorMessage: string,
  ) {
    super(message);
    this.name = "TypeSafeRateLimitError";
  }
}

/**
 * The vendor answered with a model other than the pinned release we sent.
 *
 * Deliberately fatal: a different model is a different price under a cost name
 * that no longer describes it, and a loud outage on a vendor-side rename is far
 * cheaper than a quiet mis-declared cost nobody reconciles.
 */
export class TypeSafeModelMismatchError extends TypeSafeError {
  constructor(
    readonly requested: string,
    readonly served: string,
  ) {
    super(
      `[typesafe] requested model "${requested}" but the response was served by "${served}", ` +
        `which this service does not price. Refusing the answer rather than billing it under ` +
        `a cost name that no longer describes the model.`,
    );
    this.name = "TypeSafeModelMismatchError";
  }
}

// --- Wire types -------------------------------------------------------------
//
// Named exactly as the vendor names them. The answer objects are served to our
// own callers VERBATIM: `confidence` and `probabilities` are the reason this
// vendor exists for us, so nothing in this file reduces an answer to its
// winning value.

/** A caller's criterion: a plain description, or the vendor's structured form. */
export type TypeSafeCriterion = string | { what: string; examples?: string[] };

export interface TypeSafeNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface TypeSafeChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, TypeSafeCriterion>;
}

export interface TypeSafeScoreQuestion {
  type: "score";
  instructions: string;
  criteria: TypeSafeCriterion[];
}

export type TypeSafeQuestion =
  | TypeSafeNoulQuestion
  | TypeSafeChoiceQuestion
  | TypeSafeScoreQuestion;

/** Probability that the answer is yes. No separate confidence — the value IS the confidence. */
export interface TypeSafeNoulAnswer {
  type: "noul";
  noul: number;
}

export interface TypeSafeChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface TypeSafeScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend: Record<string, string>;
}

export type TypeSafeAnswer = TypeSafeNoulAnswer | TypeSafeChoiceAnswer | TypeSafeScoreAnswer;

export interface TypeSafeJudgeOptions {
  apiKey: string;
  /** The caller's choice. Resolved to `TYPESAFE_API_MODEL_ID` on the wire. */
  model: TypeSafeModel;
  /** Text, JSON object, or array of text — whatever the caller is judging. */
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
}

export interface TypeSafeJudgeResult {
  /** The release the vendor says served the request — always the pinned id. */
  model: string;
  answers: Record<string, TypeSafeAnswer>;
  /**
   * The ONLY billable quantity at this vendor, and it is exact — the vendor
   * reports the count it charged, so the declared cost is never an estimate.
   */
  inputTokens: number;
  /** Reported by the vendor and FREE. Carried for logs, never priced. */
  outputTokens: number;
}

interface TypeSafeResponseBody {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | string;
}

/** Best-effort extraction of the vendor's own message from an error body. */
function vendorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as TypeSafeResponseBody;
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Not JSON — the raw body is the most honest thing we have.
  }
  return raw.slice(0, 500);
}

/**
 * Validate one answer without weakening it.
 *
 * The point is to fail LOUD when the vendor's shape changes: a `confidence`
 * that silently arrived `undefined` would flow all the way to a consumer that
 * uses it to decide whether to act, and read there as "not confident" — or
 * worse, as absent. So an answer missing the fields its own type promises is an
 * error here, not a degraded object served onward. Unknown EXTRA fields are
 * preserved: the vendor is free to add to its answers.
 */
function parseAnswer(key: string, value: unknown): TypeSafeAnswer {
  if (!value || typeof value !== "object") {
    throw new TypeSafeError(`[typesafe] answer "${key}" is not an object`);
  }
  const a = value as Record<string, unknown>;
  const isProbability = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  const isDistribution = (v: unknown): v is Record<string, number> =>
    !!v && typeof v === "object" && Object.values(v as object).every((p) => typeof p === "number");

  switch (a.type) {
    case "noul":
      if (!isProbability(a.noul)) {
        throw new TypeSafeError(
          `[typesafe] noul answer "${key}" carries no probability in 0..1 (got ${JSON.stringify(a.noul)})`,
        );
      }
      return a as unknown as TypeSafeNoulAnswer;
    case "choice":
      if (typeof a.choice !== "string" || !isProbability(a.confidence) || !isDistribution(a.probabilities)) {
        throw new TypeSafeError(
          `[typesafe] choice answer "${key}" is missing choice / confidence / probabilities`,
        );
      }
      return a as unknown as TypeSafeChoiceAnswer;
    case "score":
      if (
        typeof a.score !== "number" ||
        !isProbability(a.confidence) ||
        !isDistribution(a.probabilities) ||
        !a.legend ||
        typeof a.legend !== "object"
      ) {
        throw new TypeSafeError(
          `[typesafe] score answer "${key}" is missing score / confidence / probabilities / legend`,
        );
      }
      return a as unknown as TypeSafeScoreAnswer;
    default:
      throw new TypeSafeError(
        `[typesafe] answer "${key}" has unknown type ${JSON.stringify(a.type)}`,
      );
  }
}

/**
 * Ask TypeSafe one or more typed questions about a piece of state.
 *
 * Retries the connect phase and the two "not now" statuses, nothing else. A
 * completed 4xx is a permanent refusal and a completed 5xx is a real answer
 * from the vendor — replaying either buys nothing.
 */
export async function judgeWithTypeSafe(
  options: TypeSafeJudgeOptions,
): Promise<TypeSafeJudgeResult> {
  const { apiKey, model, state, questions } = options;
  const body = JSON.stringify({ state, model: TYPESAFE_API_MODEL_ID, questions });

  let connectAttempt = 0;
  let busyAttempt = 0;
  let busyWaitedMs = 0;

  for (;;) {
    let res: Response;
    try {
      res = await fetch(TYPESAFE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (err) {
      if (isTransientConnectError(err) && connectAttempt < MAX_CONNECT_RETRIES) {
        await sleep(CONNECT_RETRY_DELAYS_MS[connectAttempt] ?? 1000);
        connectAttempt += 1;
        continue;
      }
      throw err;
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      const message = vendorMessage(raw);

      if (res.status === RATE_LIMIT_STATUS || res.status === OVERLOADED_STATUS) {
        if (busyAttempt < MAX_BUSY_RETRIES) {
          const retryAfter = parseRetryAfterMs(res.headers.get("retry-after"));
          const waitMs = retryAfter ?? jittered(BUSY_BACKOFF_MS[busyAttempt] ?? 7500);
          busyWaitedMs += waitMs;
          busyAttempt += 1;
          await sleep(waitMs);
          continue;
        }
        if (res.status === RATE_LIMIT_STATUS) {
          throw new TypeSafeRateLimitError(
            `[typesafe] rate limited after ${busyAttempt + 1} attempts over ${Math.round(busyWaitedMs)}ms: ${message}`,
            busyAttempt + 1,
            Math.round(busyWaitedMs),
            message,
          );
        }
        throw new TypeSafeError(
          `[typesafe] overloaded (529) after ${busyAttempt + 1} attempts over ${Math.round(busyWaitedMs)}ms: ${message}`,
        );
      }

      if (res.status === 400 || res.status === 422) {
        throw new TypeSafeInvalidRequestError(
          `[typesafe] refused the request (${res.status}): ${message}`,
          res.status,
          message,
        );
      }

      throw new TypeSafeError(`[typesafe] POST /v1/systemone returned ${res.status}: ${message}`);
    }

    const parsed = (await res.json()) as TypeSafeResponseBody;

    const served = parsed.model;
    if (served !== TYPESAFE_API_MODEL_ID) {
      throw new TypeSafeModelMismatchError(TYPESAFE_API_MODEL_ID, String(served));
    }

    if (!parsed.answers || typeof parsed.answers !== "object") {
      throw new TypeSafeError("[typesafe] response carries no answers");
    }

    const answers: Record<string, TypeSafeAnswer> = {};
    for (const key of Object.keys(questions)) {
      const value = parsed.answers[key];
      if (value === undefined) {
        throw new TypeSafeError(`[typesafe] response is missing an answer for question "${key}"`);
      }
      answers[key] = parseAnswer(key, value);
    }

    const inputTokens = parsed.usage?.input_tokens;
    if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens < 0) {
      // The billable quantity IS this number. Without it we would have to guess
      // what to charge the org, and a guessed cost is a wrong cost.
      throw new TypeSafeError(
        `[typesafe] response carries no usable usage.input_tokens (got ${JSON.stringify(inputTokens)})`,
      );
    }

    return {
      model: served,
      answers,
      inputTokens,
      outputTokens: parsed.usage?.output_tokens ?? 0,
    };
  }
}
