// ---------------------------------------------------------------------------
// Postgres refuses the NUL character in text AND in jsonb ("unsupported Unicode
// escape sequence"). A tool result can carry one (an email body read from a
// mailbox), and the whole assistant turn then failed to save: the user saw the
// answer, then "An unexpected error occurred" (prod 2026-10-10). Every value
// persisted on a message goes through this: NUL characters are removed, nothing
// else changes.
// ---------------------------------------------------------------------------

const NUL = /\u0000/g;

export function stripNul<T>(value: T): T {
  if (typeof value === "string") return value.replace(NUL, "") as T;
  if (Array.isArray(value)) return value.map((v) => stripNul(v)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k.replace(NUL, "")] = stripNul(v);
    return out as T;
  }
  return value;
}
