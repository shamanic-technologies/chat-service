/**
 * costs-service `GET /v1/platform-prices` token lines, read in PROD on 2026-11-08 (USD cents per token, standard list).
 * The out-of-credit detour ranks fallbacks by these (LLM-CREDIT-GENERIC-1108).
 */
export const LIST_PRICES_2026_11_08: Array<{ name: string; pricePerUnitInUsdCents: string }> = [
  ["anthropic-fable-5.1", "0.0010000000", "0.0050000000"],
  ["anthropic-fable-5.2", "0.0008000000", "0.0040000000"],
  ["anthropic-haiku-5.5", "0.0000100000", "0.0000500000"],
  ["anthropic-opus-5.5", "0.0004000000", "0.0020000000"],
  ["anthropic-sonnet-5.5", "0.0002000000", "0.0010000000"],
  ["deepseek-v4.1-flash-off-peak", "0.0000159000", "0.0000636000"],
  ["deepseek-v4.1-flash-peak", "0.0000318000", "0.0001272000"],
  ["google-argon-4", "0.0004000000", "0.0020000000"],
  ["google-flash-3.8", "0.0001500000", "0.0007500000"],
  ["google-flash-lite-3.5", "0.0000300000", "0.0002500000"],
  ["google-pro-3.1", "0.0002000000", "0.0012000000"],
  ["moonshot-kimi-k2.6", "0.0000950000", "0.0004000000"],
  ["moonshot-kimi-k3", "0.0003000000", "0.0015000000"],
  ["openai-gpt-6.1-sol", "0.0002000000", "0.0010000000"],
  ["openai-gpt-6.1-terra", "0.0001000000", "0.0005000000"],
  ["openai-gpt-6-astra", "0.0010000000", "0.0050000000"],
  ["zai-glm-5.3-flash", "0.0000150000", "0.0000500000"],
  ["zai-glm-5.3", "0.0001400000", "0.0004400000"],
].flatMap(([prefix, input, output]) => [
  { name: `${prefix}-tokens-input`, pricePerUnitInUsdCents: input },
  { name: `${prefix}-tokens-output`, pricePerUnitInUsdCents: output },
]);
