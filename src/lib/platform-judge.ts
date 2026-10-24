import { TYPESAFE_INPUT_TOKENS_COST_NAME } from "./cost-names.js";
import { resolvePlatformKey } from "./key-client.js";
import type { RunSupport } from "./support-marks.js";
import { addPlatformRunCosts, createPlatformRun, updatePlatformRunStatus } from "./runs-client.js";
import {
  judgeWithTypeSafe,
  TYPESAFE_DEFAULT_MODEL,
  TYPESAFE_PROVIDER,
  type TypeSafeAnswer,
  type TypeSafeQuestion,
} from "./typesafe.js";

/**
 * A Jev judgment chat-service asks for ITSELF (no caller org): same path as
 * `/internal/platform-judgments`, platform key, platform run, input tokens
 * declared. Fails loud: an undeclarable spend or a refused judgment throws.
 */
export async function judgeOnPlatform(
  taskName: string,
  state: unknown,
  questions: Record<string, TypeSafeQuestion>,
  support: RunSupport,
): Promise<Record<string, TypeSafeAnswer>> {
  const { key } = await resolvePlatformKey(TYPESAFE_PROVIDER, { method: "POST", path: `/internal/${taskName}` });
  const run = await createPlatformRun({ serviceName: "chat-service", taskName, support });
  let failed = true;
  try {
    const result = await judgeWithTypeSafe({ apiKey: key, model: TYPESAFE_DEFAULT_MODEL, state, questions });
    await addPlatformRunCosts(run.id, "chat-service", [
      { costName: TYPESAFE_INPUT_TOKENS_COST_NAME, quantity: result.inputTokens, costSource: "platform" as const },
    ]);
    failed = false;
    return result.answers;
  } finally {
    await updatePlatformRunStatus(run.id, "chat-service", failed ? "failed" : "completed").catch((e) =>
      console.error(`[platform-judge] could not close platform run ${run.id}:`, e),
    );
  }
}
