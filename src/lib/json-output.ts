/**
 * Parse model JSON output for /complete surfaces.
 *
 * JSON mode / structured output asks the provider for one raw JSON value.
 * Accept only that contract plus surrounding whitespace. Markdown fences,
 * preambles, trailing prose, and malformed JSON are provider-contract
 * violations and must fail loudly.
 */
export function parseModelJsonOutput(content: string): unknown {
  const trimmed = content.trim();

  try {
    return JSON.parse(trimmed);
  } catch (err) {
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
