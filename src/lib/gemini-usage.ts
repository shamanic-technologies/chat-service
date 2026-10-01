/**
 * Gemini `usageMetadata` → the token counts Google BILLS, and the catalog lines
 * they bill under.
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
 *
 * Google prices one request along three more dimensions, each its own catalog
 * name (costs-service seed, https://ai.google.dev/gemini-api/docs/pricing):
 * - a CACHE HIT (implicit caching is on by default and Google passes the
 *   saving on automatically) bills at 0.1x input → `-tokens-cached-input`;
 * - a Pro prompt over 200k tokens bills EVERY token of that request at a
 *   higher rate → `<prefix>-long-context-tokens-*`;
 * - Flash Image bills text/thinking output at $3/1M and image output at
 *   $60/1M → `-tokens-text-output` beside `-tokens-output`.
 */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
  candidatesTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

export interface GeminiCostLine {
  costName: string;
  quantity: number;
}

export interface GeminiBilledTokens {
  tokensInput: number;
  tokensOutput: number;
  /** The catalog lines this ONE request bills under (zero quantities omitted). */
  costLines: GeminiCostLine[];
}

/** Pro models whose prompts over this many tokens bill at the long-context rate. */
export const GEMINI_LONG_CONTEXT_THRESHOLD = 200_000;
const LONG_CONTEXT_PREFIXES = new Set(["google-pro-3.1", "google-pro-2.5"]);

/** Image models: output split by modality; no cache rate published. */
const IMAGE_OUTPUT_PREFIXES = new Set(["google-flash-image-3.1"]);

export function readGeminiBilledTokens(
  usage: GeminiUsageMetadata | undefined,
  model: string,
  costPrefix: string,
): GeminiBilledTokens {
  if (!usage) return { tokensInput: 0, tokensOutput: 0, costLines: [] };

  const prompt = usage.promptTokenCount ?? 0;
  const tokensInput = prompt + (usage.toolUsePromptTokenCount ?? 0);
  const tokensOutput = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);

  if (usage.totalTokenCount !== undefined && usage.totalTokenCount !== tokensInput + tokensOutput) {
    throw new Error(
      `[gemini] usageMetadata reports tokens no known class accounts for | model=${model}` +
        ` | totalTokenCount=${usage.totalTokenCount} | billedInput=${tokensInput} | billedOutput=${tokensOutput}` +
        ` | usageMetadata=${JSON.stringify(usage)}`,
    );
  }

  const cached = usage.cachedContentTokenCount ?? 0;
  if (cached > prompt) {
    throw new Error(
      `[gemini] cachedContentTokenCount exceeds promptTokenCount | model=${model}` +
        ` | usageMetadata=${JSON.stringify(usage)}`,
    );
  }

  const isImage = IMAGE_OUTPUT_PREFIXES.has(costPrefix);
  if (isImage && cached > 0) {
    throw new Error(
      `[gemini] ${model} reported ${cached} cached prompt tokens but Google publishes no cache rate ` +
        `for it, so they cannot be priced | usageMetadata=${JSON.stringify(usage)}`,
    );
  }

  const longContext = LONG_CONTEXT_PREFIXES.has(costPrefix) && prompt > GEMINI_LONG_CONTEXT_THRESHOLD;
  const base = longContext ? `${costPrefix}-long-context` : costPrefix;

  const lines: GeminiCostLine[] = [
    { costName: `${base}-tokens-input`, quantity: tokensInput - cached },
    { costName: `${base}-tokens-cached-input`, quantity: cached },
  ];
  if (isImage) {
    const imageOutput = (usage.candidatesTokensDetails ?? [])
      .filter((d) => d.modality === "IMAGE")
      .reduce((sum, d) => sum + (d.tokenCount ?? 0), 0);
    lines.push(
      { costName: `${base}-tokens-output`, quantity: imageOutput },
      { costName: `${base}-tokens-text-output`, quantity: tokensOutput - imageOutput },
    );
  } else {
    lines.push({ costName: `${base}-tokens-output`, quantity: tokensOutput });
  }
  const costLines = lines.filter((l) => l.quantity > 0);

  // One line per Gemini call (per turn on /chat): the raw usageMetadata beside
  // what we declare, so a cost row can be audited against Google's billing.
  console.log(
    `[gemini] billed usage | model=${model} | in=${tokensInput} | out=${tokensOutput}` +
      ` | lines=${costLines.map((l) => `${l.costName}:${l.quantity}`).join(",")}` +
      ` | usageMetadata=${JSON.stringify(usage)}`,
  );
  return { tokensInput, tokensOutput, costLines };
}

/** Sum cost lines by name (a /chat tool loop bills one request per turn). */
export function mergeGeminiCostLines(a: GeminiCostLine[], b: GeminiCostLine[]): GeminiCostLine[] {
  const byName = new Map<string, number>();
  for (const l of [...a, ...b]) byName.set(l.costName, (byName.get(l.costName) ?? 0) + l.quantity);
  return [...byName].map(([costName, quantity]) => ({ costName, quantity }));
}
