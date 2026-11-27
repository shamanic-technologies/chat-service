/**
 * SSRF-1127: a route path a model or a customer had a hand in is checked HERE
 * before it reaches a service with a service key (api-registry `/call`, the
 * gateway with the admin key).
 *
 * `fetch` (WHATWG URL) normalises dot-segments, including `%2e` spellings and
 * `\` as a separator, so `/v1/x/%2e%2e/%2e%2e/internal/y` passed a literal
 * `..` check and landed on `/internal/y` with the target's own key. A path is
 * refused when its fully decoded form (up to 3 rounds: double encoding) holds
 * a dot-segment, a backslash, an empty segment, or a control character. The
 * query string is data, not a location: only the path part is checked.
 *
 * Mirrors api-service `downstreamUrl` (`src/lib/service-client.ts`), stricter:
 * it also refuses double-encoded spellings and returns the decoded path so a
 * caller checks its allowed scope on what the server will actually route.
 */
export class UnsafeRoutePathError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "UnsafeRoutePathError";
  }
}

const MAX_DECODE_ROUNDS = 3;

/** The path part (before `?`/`#`), fully percent-decoded; throws when it cannot be decoded. */
function decodedPathOf(pathOnly: string): string {
  let current = pathOnly;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      throw new UnsafeRoutePathError(`route path is not valid percent-encoding: ${pathOnly}`);
    }
    if (next === current) return current;
    current = next;
  }
  if (/%[0-9a-f]{2}/i.test(current)) {
    throw new UnsafeRoutePathError(`route path is encoded more than ${MAX_DECODE_ROUNDS} times: ${pathOnly}`);
  }
  return current;
}

/**
 * Refuse a path that can leave the route it names. Returns the decoded path
 * part (no query) so the caller can check its allowed prefixes on it.
 */
export function assertSafeRoutePath(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new UnsafeRoutePathError(`route path must start with "/", got ${String(path)}`);
  }
  const pathOnly = path.split(/[?#]/, 1)[0]!;
  const decoded = decodedPathOf(pathOnly);
  for (const form of [pathOnly, decoded]) {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(form)) throw new UnsafeRoutePathError("route path holds a control character");
    if (form.includes("\\")) throw new UnsafeRoutePathError(`route path holds a backslash: ${pathOnly}`);
    if (/[?#]/.test(form)) throw new UnsafeRoutePathError(`route path hides a query or fragment in its encoding: ${pathOnly}`);
    const segments = form.split("/").slice(1);
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]!.toLowerCase().replace(/%2e/g, ".");
      if (s === "." || s === "..") throw new UnsafeRoutePathError(`route path holds a dot-segment: ${pathOnly}`);
      if (s === "" && i < segments.length - 1) throw new UnsafeRoutePathError(`route path holds an empty segment: ${pathOnly}`);
    }
  }
  return decoded;
}
