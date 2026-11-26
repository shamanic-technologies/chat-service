/**
 * Every string inside a value, made well-formed UTF-16 (JEV-INVALID-UNICODE-1126).
 *
 * A caller that cuts a text by UTF-16 length (`text.slice(0, N)`) can split an
 * emoji and leave half of it, a lone surrogate. JSON.stringify writes it as a
 * bare `\ud83d` escape, and Jev refuses the WHOLE request: 400 "Request
 * contains invalid Unicode text." (probed live 2026-11-26: a lone high or low
 * surrogate is refused, NUL and U+FFFE pass). Each half becomes U+FFFD, the
 * standard replacement character: one unreadable character in place of a
 * character nobody could read, never a lost judgment. Keys are fixed too.
 * Applied once, at the judgment door every caller goes through, never per caller.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `String.prototype.toWellFormed` (ES2024, not in this repo's ES2022 lib), same result. */
export function toWellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, "\uFFFD");
}

export function toWellFormedDeep<T>(value: T): T {
  return fix(value) as T;
}

function fix(value: unknown): unknown {
  if (typeof value === "string") return toWellFormed(value);
  if (Array.isArray(value)) return value.map(fix);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[toWellFormed(k)] = fix(v);
    return out;
  }
  return value;
}
