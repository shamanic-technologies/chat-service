/**
 * Parse model JSON output for /complete surfaces.
 *
 * JSON mode / structured output asks the provider for one raw JSON value.
 * The happy path is a bare JSON value with optional surrounding whitespace.
 *
 * BUT provider-side enforcement (responseMimeType/responseSchema) is not a hard
 * guarantee: Gemini 3 thinking models intermittently emit a COMPLETE, valid JSON
 * value FOLLOWED BY trailing non-JSON content (thinking-leak prose, a stray
 * fence) even in JSON mode. So we recover the FIRST complete JSON value before
 * failing:
 *   1. Fast path — JSON.parse(trimmed). Zero-risk for the clean contract.
 *   2. Recovery — strip a leading ```/```json markdown fence, then string-aware
 *      balanced-delimiter scan from the leading `{`/`[` to its matching close;
 *      parse that substring and ignore anything after the first complete value.
 *
 * Recovery scope is deliberately narrow: a markdown fence OR trailing prose after
 * a value that STARTS the output. LEADING non-fence prose (e.g. "Here is:\n{...}")
 * stays a hard failure — a prose sentence with a stray brace risks mis-extraction.
 * Empty / non-JSON-prefix / truncated-unbalanced / malformed output still fails
 * loud with the classified detail below. No jsonrepair, no LLM-repair round —
 * balanced-scan extraction only.
 *
 * DO NOT "strictly validate" this back to a rigid JSON.parse(trimmed): that
 * re-breaks every Gemini-3 trailing-leak completion with a 502 (masked only
 * because callers use Promise.allSettled, so segments silently drop).
 */
export function parseModelJsonOutput(content: string): unknown {
  const trimmed = content.trim();

  try {
    return JSON.parse(trimmed);
  } catch (err) {
    const recovered = tryRecoverFirstJsonValue(trimmed);
    if (recovered !== NO_RECOVERY) {
      return recovered;
    }
    const parseMessage = err instanceof Error ? err.message : String(err);
    throw new ModelJsonOutputError(formatJsonOutputError(trimmed, parseMessage));
  }
}

export class ModelJsonOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelJsonOutputError";
  }
}

/** Sentinel distinct from any JSON value (including null/undefined). */
const NO_RECOVERY = Symbol("no-recovery");

/**
 * Recover the first complete JSON value from output that either wraps it in a
 * markdown fence or appends trailing content. Returns NO_RECOVERY when no
 * complete balanced value is extractable from the START of the output.
 */
function tryRecoverFirstJsonValue(trimmed: string): unknown {
  const candidate = trimmed.startsWith("```") ? stripLeadingFence(trimmed) : trimmed;
  const balanced = extractLeadingBalancedJson(candidate);
  if (balanced === null) {
    return NO_RECOVERY;
  }
  try {
    return JSON.parse(balanced);
  } catch {
    return NO_RECOVERY;
  }
}

/** Drop a leading ```/```json fence line so the JSON value starts the string. */
function stripLeadingFence(value: string): string {
  const newline = value.indexOf("\n");
  if (newline === -1) {
    return value;
  }
  return value.slice(newline + 1).trimStart();
}

/**
 * String-aware balanced scan. If `value` starts with `{` or `[`, return the
 * substring up to (and including) the matching close delimiter; else null.
 * Quotes and backslash escapes are respected so delimiters inside strings do
 * not miscount. Only the root object/array delimiter is tracked — in valid JSON
 * braces and brackets each balance independently, so tracking the root type is
 * sufficient and nested containers of the other type never interfere.
 */
function extractLeadingBalancedJson(value: string): string | null {
  const open = value[0];
  if (open !== "{" && open !== "[") {
    return null;
  }
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < value.length; i++) {
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
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return value.slice(0, i + 1);
      }
    }
  }

  return null;
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
