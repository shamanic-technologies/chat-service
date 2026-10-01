/**
 * Gemini `usageMetadata` → the token counts Google BILLS.
 *
 * Google reports the model's thinking separately from the visible answer:
 * `candidatesTokenCount` is the visible output only, `thoughtsTokenCount` is
 * the thinking, and Google bills BOTH at the output rate. Reading
 * `candidatesTokenCount` alone under-declared ~75% of Gemini 3 Pro output in
 * September 2026 (billing export 15.04M output tokens vs 3.67M declared).
 *
 * Probed live 2026-10-01 on gemini-3.1-pro-preview, gemini-3.8-flash,
 * gemini-3.x-flash-lite and gemini-3.1-flash-image (generateContent and
 * streamGenerateContent, with googleSearch, with a functionCall, with an
 * implicit cache hit): every response satisfied
 *   totalTokenCount = promptTokenCount + toolUsePromptTokenCount
 *                   + candidatesTokenCount + thoughtsTokenCount
 * `cachedContentTokenCount` is a SUBSET of `promptTokenCount`, not an extra.
 *
 * Billed input  = promptTokenCount + toolUsePromptTokenCount
 * Billed output = candidatesTokenCount + thoughtsTokenCount
 *
 * If Google ever reports a token class this sum does not cover (the total
 * exceeds the parts), we cannot price it: throw rather than under-declare.
 */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiBilledTokens {
  tokensInput: number;
  tokensOutput: number;
}

export function readGeminiBilledTokens(
  usage: GeminiUsageMetadata | undefined,
  model: string,
): GeminiBilledTokens {
  if (!usage) return { tokensInput: 0, tokensOutput: 0 };

  const tokensInput = (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0);
  const tokensOutput = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);

  if (usage.totalTokenCount !== undefined && usage.totalTokenCount !== tokensInput + tokensOutput) {
    throw new Error(
      `[gemini] usageMetadata reports tokens no known class accounts for | model=${model}` +
        ` | totalTokenCount=${usage.totalTokenCount} | billedInput=${tokensInput} | billedOutput=${tokensOutput}` +
        ` | usageMetadata=${JSON.stringify(usage)}`,
    );
  }

  // One line per Gemini call (per turn on /chat): the raw usageMetadata beside
  // what we declare, so a cost row can be audited against Google's billing.
  console.log(
    `[gemini] billed usage | model=${model} | in=${tokensInput} | out=${tokensOutput}` +
      ` | usageMetadata=${JSON.stringify(usage)}`,
  );
  return { tokensInput, tokensOutput };
}
