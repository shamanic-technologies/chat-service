/**
 * Diagnostic suffix helpers for JSON-repair log lines.
 *
 * Every `[chat-service] ... jsonrepair ...` warn line ends with the same
 * `provider=<...> model=<...> sample="<first N chars>"` suffix so production
 * logs can be grep'd to find which caller / model dominates the repair rate.
 */

export interface RepairLogContext {
  apiKey: string;
  model: string;
  isGemini: boolean;
}

/**
 * Truncate raw model output to `max` chars and escape it for safe single-line
 * log emission (backslash, quote, newline, carriage-return, tab).
 */
export function escapeSample(text: string, max = 80): string {
  return text
    .slice(0, max)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Build the ` provider=<...> model=<...> sample="<...>"` suffix appended to
 * every JSON-repair log line. Single source of truth so all repair warns are
 * grep-able with the same regex.
 */
export function repairLogSuffix(raw: string, ctx?: RepairLogContext): string {
  const provider = ctx ? (ctx.isGemini ? "google" : "anthropic") : "unknown";
  const model = ctx?.model ?? "unknown";
  return ` provider=${provider} model=${model} sample="${escapeSample(raw)}"`;
}
