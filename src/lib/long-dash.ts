// ---------------------------------------------------------------------------
// No long dash (— or –) in text a person reads (owner rule: ban it in the
// prompt AND strip it before send). The prompts already ban it; this is the
// deterministic cleanup after the writer, never a check or a rewrite.
// Prod 2026-11-01: Sonnet 5.5 wrote one in 1 of 257 Copilot answers over 7
// days, DeepSeek V4.1 Flash in its very first (CHAT-DEEPSEEK-FLASH-1101).
// ---------------------------------------------------------------------------

/** "10–20" → "10-20", a line opening on a dash → "- ", any other → ", ". */
export function stripLongDashes(text: string): string {
  if (!/[–—]/.test(text)) return text;
  return text
    .replace(/(\d)[ \t]*[–—][ \t]*(\d)/g, "$1-$2")
    .replace(/(^|\n)([ \t]*)[–—][ \t]*/g, "$1$2- ")
    .replace(/[ \t]*[–—]+[ \t]*/g, ", ");
}
