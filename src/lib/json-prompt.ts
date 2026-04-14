/**
 * System prompt suffix appended when responseFormat is "json".
 * Instructs the LLM to return a plain JSON object — never an array.
 */
export const JSON_RESPONSE_SYSTEM_SUFFIX =
  `\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, no extra text — just a single JSON object. Never wrap the result in an array.`;
