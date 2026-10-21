// ---------------------------------------------------------------------------
// The judges behind the judgments door. A caller NAMES one (`judge`), so
// lead-service can benchmark them on the same inputs; the default is Jev.
// There is no fallback from one judge to another: a judge that fails is a
// named error carrying that judge's name.
//
// Not here: Cloudflare Clef / Clef-flash (Workers AI). Checked 2026-10-21: our
// Cloudflare account exposes R2 storage keys only, no Workers AI API token, so
// Clef is not reachable from this service. Adding it = a Workers AI token in
// key-service, its cost rows in costs-service, then a JUDGES entry here.
// ---------------------------------------------------------------------------

import {
  OPENAI_DECISIONS_LONG_CONTEXT_THRESHOLD,
  OPENAI_DECISIONS_PROVIDER,
  OpenAiDecisionsInvalidRequestError,
  OpenAiDecisionsRateLimitError,
  judgeWithOpenAiDecisions,
} from "./openai-decisions.js";
import {
  TYPESAFE_PROVIDER,
  TypeSafeInvalidRequestError,
  TypeSafeRateLimitError,
  judgeWithTypeSafe,
  type TypeSafeAnswer,
  type TypeSafeModel,
  type TypeSafeQuestion,
} from "./typesafe.js";
import {
  OPENAI_DECISIONS_LONG_CONTEXT_TOKENS_INPUT_COST_NAME,
  OPENAI_DECISIONS_TOKENS_INPUT_COST_NAME,
  TYPESAFE_INPUT_TOKENS_COST_NAME,
} from "./cost-names.js";
import type { PreparedJudgmentImage } from "./judgment-image.js";

export const JUDGES = ["jev", "openai-luna"] as const;
export type Judge = (typeof JUDGES)[number];
export const DEFAULT_JUDGE: Judge = "jev";

/** Human name used in error bodies, so a failure says WHICH judge failed. */
export const JUDGE_LABELS: Record<Judge, string> = {
  jev: "TypeSafe",
  "openai-luna": "OpenAI Decisions",
};

/** key-service provider slug per judge. */
export const JUDGE_PROVIDERS: Record<Judge, string> = {
  jev: TYPESAFE_PROVIDER,
  "openai-luna": OPENAI_DECISIONS_PROVIDER,
};

/** Cost name the pre-call HOLD is provisioned under (the normal-rate row). */
export function judgeHoldCostName(judge: Judge): string {
  return judge === "jev" ? TYPESAFE_INPUT_TOKENS_COST_NAME : OPENAI_DECISIONS_TOKENS_INPUT_COST_NAME;
}

/**
 * Cost name the ACTUAL is declared under, chosen from the vendor's own count.
 * Luna prices a prompt over 272K tokens at 2x for the whole request, so the
 * name follows the reported total; Jev has one rate.
 */
export function judgeActualCostName(judge: Judge, inputTokens: number): string {
  if (judge === "jev") return TYPESAFE_INPUT_TOKENS_COST_NAME;
  return inputTokens > OPENAI_DECISIONS_LONG_CONTEXT_THRESHOLD
    ? OPENAI_DECISIONS_LONG_CONTEXT_TOKENS_INPUT_COST_NAME
    : OPENAI_DECISIONS_TOKENS_INPUT_COST_NAME;
}

export interface JudgeResult {
  model: string;
  answers: Record<string, TypeSafeAnswer>;
  inputTokens: number;
  outputTokens: number;
}

export async function runJudge(args: {
  judge: Judge;
  apiKey: string;
  model: TypeSafeModel;
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
  image?: PreparedJudgmentImage;
}): Promise<JudgeResult> {
  const { judge, apiKey, model, state, questions, image } = args;
  if (judge === "jev") return judgeWithTypeSafe({ apiKey, model, state, questions, image });
  return judgeWithOpenAiDecisions({ apiKey, state, questions, image });
}

/**
 * HTTP answer for a judge failure: a refused SHAPE is 400 (refused forever, in
 * the vendor's words), a rate limit is 429 (clears, billed nothing), anything
 * else 502 naming the judge.
 */
export function judgeErrorResponse(judge: Judge, err: unknown): { status: number; body: Record<string, unknown> } {
  const label = JUDGE_LABELS[judge];
  if (err instanceof TypeSafeInvalidRequestError || err instanceof OpenAiDecisionsInvalidRequestError) {
    return {
      status: 400,
      body: { error: `${label} refused the request`, judge, detail: err.vendorMessage, retryable: false },
    };
  }
  if (err instanceof TypeSafeRateLimitError || err instanceof OpenAiDecisionsRateLimitError) {
    return {
      status: 429,
      body: {
        error: `${label} rate limit`,
        judge,
        detail: err.vendorMessage,
        attempts: err.attempts,
        waitedMs: err.waitedMs,
        retryable: true,
      },
    };
  }
  return {
    status: 502,
    body: {
      error: judge === "jev" ? "Judgment failed. Please try again." : `Judgment failed (${label}). Please try again.`,
      judge,
    },
  };
}
