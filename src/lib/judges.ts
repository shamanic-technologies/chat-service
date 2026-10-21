// ---------------------------------------------------------------------------
// The judges behind the judgments door. A caller NAMES one (`judge`), so
// lead-service can benchmark them on the same inputs; the default is Jev.
// There is no fallback from one judge to another: a judge that fails is a
// named error carrying that judge's name.
//
// Benchmark 2026-10-21 (33 roofer homepages, "Is there no clearly visible
// phone number in the header above the fold?", ground truth checked by eye):
// jev 31/31, clef 32/32, clef-flash 32/32, openai-luna 27/28. Per screenshot:
// jev ~3,900 tokens, luna ~1,540, clef ~1,180 (both sizes).
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
  CLEF_FLASH_TOKENS_INPUT_COST_NAME,
  CLEF_TOKENS_INPUT_COST_NAME,
  OPENAI_DECISIONS_LONG_CONTEXT_TOKENS_INPUT_COST_NAME,
  OPENAI_DECISIONS_TOKENS_INPUT_COST_NAME,
  TYPESAFE_INPUT_TOKENS_COST_NAME,
} from "./cost-names.js";
import type { PreparedJudgmentImage } from "./judgment-image.js";
import {
  CLOUDFLARE_WORKERS_AI_ACCOUNT_PROVIDER,
  CLOUDFLARE_WORKERS_AI_PROVIDER,
  ClefInvalidRequestError,
  ClefRateLimitError,
  judgeWithClef,
  type ClefModel,
} from "./cloudflare-clef.js";
import { resolvePlatformKey } from "./key-client.js";

export const JUDGES = ["jev", "openai-luna", "cloudflare-clef", "cloudflare-clef-flash"] as const;
export type Judge = (typeof JUDGES)[number];
export const DEFAULT_JUDGE: Judge = "jev";

/** Human name used in error bodies, so a failure says WHICH judge failed. */
export const JUDGE_LABELS: Record<Judge, string> = {
  jev: "TypeSafe",
  "openai-luna": "OpenAI Decisions",
  "cloudflare-clef": "Cloudflare Clef",
  "cloudflare-clef-flash": "Cloudflare Clef-flash",
};

const CLEF_MODEL_OF: Partial<Record<Judge, ClefModel>> = {
  "cloudflare-clef": "clef",
  "cloudflare-clef-flash": "clef-flash",
};

/** key-service provider slug per judge. */
export const JUDGE_PROVIDERS: Record<Judge, string> = {
  jev: TYPESAFE_PROVIDER,
  "openai-luna": OPENAI_DECISIONS_PROVIDER,
  "cloudflare-clef": CLOUDFLARE_WORKERS_AI_PROVIDER,
  "cloudflare-clef-flash": CLOUDFLARE_WORKERS_AI_PROVIDER,
};

/** Cost name the pre-call HOLD is provisioned under (the normal-rate row). */
export function judgeHoldCostName(judge: Judge): string {
  switch (judge) {
    case "jev":
      return TYPESAFE_INPUT_TOKENS_COST_NAME;
    case "openai-luna":
      return OPENAI_DECISIONS_TOKENS_INPUT_COST_NAME;
    case "cloudflare-clef":
      return CLEF_TOKENS_INPUT_COST_NAME;
    case "cloudflare-clef-flash":
      return CLEF_FLASH_TOKENS_INPUT_COST_NAME;
  }
}

/**
 * Cost name the ACTUAL is declared under, chosen from the vendor's own count.
 * Luna prices a prompt over 272K tokens at 2x for the whole request, so the
 * name follows the reported total; Jev has one rate.
 */
export function judgeActualCostName(judge: Judge, inputTokens: number): string {
  if (judge !== "openai-luna") return judgeHoldCostName(judge);
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
  if (judge === "openai-luna") return judgeWithOpenAiDecisions({ apiKey, state, questions, image });
  // The account id is a platform fact (which Cloudflare account runs the model), not a secret.
  const account = await resolvePlatformKey(CLOUDFLARE_WORKERS_AI_ACCOUNT_PROVIDER, {
    method: "POST",
    path: "/judgments",
  });
  return judgeWithClef({ apiKey, accountId: account.key, model: CLEF_MODEL_OF[judge]!, state, questions, image });
}

/**
 * HTTP answer for a judge failure: a refused SHAPE is 400 (refused forever, in
 * the vendor's words), a rate limit is 429 (clears, billed nothing), anything
 * else 502 naming the judge.
 */
export function judgeErrorResponse(judge: Judge, err: unknown): { status: number; body: Record<string, unknown> } {
  const label = JUDGE_LABELS[judge];
  if (
    err instanceof TypeSafeInvalidRequestError ||
    err instanceof OpenAiDecisionsInvalidRequestError ||
    err instanceof ClefInvalidRequestError
  ) {
    return {
      status: 400,
      body: { error: `${label} refused the request`, judge, detail: err.vendorMessage, retryable: false },
    };
  }
  if (err instanceof TypeSafeRateLimitError || err instanceof OpenAiDecisionsRateLimitError || err instanceof ClefRateLimitError) {
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
