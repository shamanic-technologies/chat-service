/**
 * Parse model JSON output for /complete surfaces.
 *
 * JSON mode / structured output asks the provider for one raw JSON value. The
 * clean contract is exactly that value plus surrounding whitespace, and the
 * fast path enforces it verbatim.
 *
 * Reality check: Gemini 3 thinking models (google/flash-pro) intermittently
 * emit a COMPLETE valid JSON value FOLLOWED BY trailing non-JSON content
 * (thinking-leak prose, a stray closing fence) even in JSON mode — despite the
 * responseMimeType/responseSchema enforcement metadata. They also sometimes
 * wrap the value in a markdown ```json fence. So we recover the FIRST complete
 * JSON value in those two cases (fence + trailing prose) instead of 502-ing.
 *
 * Recovery is a balanced-delimiter, string-aware SCAN only — no jsonrepair, no
 * LLM-repair round (that pipeline was removed in #155 and must not return).
 * We still fail loud on genuinely broken output: empty responses, LEADING
 * non-fence prose (a prose sentence with a stray brace risks mis-extraction),
 * and truncated/unbalanced JSON. This is exactly the behavior index.ts's
 * handler comment already promised.
 *
 * NOTE to a future "strictly validate JSON completions" hotfix: do NOT revert
 * this to a rigid `JSON.parse(content.trim())`. The premise "provider-side
 * enforcement guarantees valid JSON" is empirically FALSE for Gemini 3
 * thinking (the position-N trailing leak) — that reversion re-introduces the
 * ~2/8-segments 502 drop in apollo-service /audiences/suggest-from-segment.
 */
export function parseModelJsonOutput(content: string): unknown {
  const trimmed = content.trim();

  // Fast path: clean, single JSON value (zero-risk for the compliant case).
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    const parseMessage = err instanceof Error ? err.message : String(err);
    return recoverJsonValue(trimmed, parseMessage);
  }
}

/**
 * Recover the first complete JSON value from a fenced or trailing-prose
 * payload. Only two shapes are eligible for recovery:
 *   1. A leading markdown fence (```/```json) wrapping the value.
 *   2. A payload that STARTS with a JSON structural char ({ or [) but has
 *      trailing content after the first complete value.
 * Anything else (empty, leading non-fence prose, unbalanced/truncated) throws
 * with the existing classification.
 */
function recoverJsonValue(trimmed: string, parseMessage: string): unknown {
  const scanFrom = trimmed.startsWith("```") ? stripLeadingFence(trimmed) : trimmed;

  const start = scanFrom.search(/[{[]/);
  // Recovery is only attempted when the (post-fence) payload begins with a JSON
  // structural char — a fence was stripped, or the raw value already led with
  // { / [. Leading non-fence prose keeps the first structural char buried after
  // text, so `start > 0` there and we reject rather than risk mis-extraction.
  if (start === 0) {
    const candidate = extractBalancedJson(scanFrom, start);
    if (candidate !== null) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Fall through to the classified throw below.
      }
    }
  }

  throw new ModelJsonOutputError(formatJsonOutputError(trimmed, parseMessage));
}

/**
 * Strip a leading ``` or ```json fence line so the balanced scan can start on
 * the JSON value. The closing fence (if any) is ignored by the balanced scan.
 */
function stripLeadingFence(value: string): string {
  const firstNewline = value.indexOf("\n");
  if (firstNewline === -1) {
    return "";
  }
  return value.slice(firstNewline + 1).trimStart();
}

/**
 * String-aware, balanced-delimiter scan from `start` (a `{` or `[`) to its
 * matching close. Respects double-quoted strings and backslash escapes so
 * braces/brackets inside string values do not miscount. Returns the substring
 * of the first complete value, or null if it never balances (truncated).
 */
function extractBalancedJson(value: string, start: number): string | null {
  const open = value[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < value.length; i++) {
    const ch = value[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, i + 1);
      }
    }
  }

  return null;
}

export class ModelJsonOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelJsonOutputError";
  }
}

function formatJsonOutputError(value: string, parseMessage: string): string {
  const reason = classifyJsonOutputError(value, parseMessage);
  return `${reason} Expected exactly one raw JSON value with optional surrounding whitespace. JSON.parse: ${parseMessage}`;
}

function classifyJsonOutputError(value: string, parseMessage: string): string {
  if (value.length === 0) {
    return "Model returned an empty JSON-mode response.";
  }

  if (value.startsWith("```")) {
    return "Model returned markdown-fenced JSON in JSON mode.";
  }

  if (parseMessage.includes("Unexpected non-whitespace character after JSON")) {
    return "Model returned trailing non-JSON content after a JSON value.";
  }

  if (!/^[{\["0-9tfn-]/.test(value)) {
    return "Model returned a non-JSON prefix before the JSON value.";
  }

  return "Model returned malformed or truncated JSON.";
}
