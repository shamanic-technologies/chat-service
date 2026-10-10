// ---------------------------------------------------------------------------
// Infra discovery by DEPTH (owner 2026-10-10, "chat first"). The Copilot
// explores our services the way a developer would, one small page at a time:
//   discover_services            -> every service, one line each
//   discover_service_endpoints   -> one service's endpoints with avg cost,
//                                   duration and success rate (fleet runs)
//   discover_endpoint            -> one endpoint's full doc + run stats
//   test_endpoint                -> a READ-ONLY test run, as the chat's org
// Owner: api-registry-service (`/discover/*`, `/call/:service`), called
// directly with its service key. A test run goes out with the chat's own
// identity (x-org-id, x-user-id, x-run-id), so any cost lands on that org.
//
// test_endpoint is GET-only and never reaches an `/internal`, admin or staff
// route: `/call` injects the target's SERVICE key, so an unscoped call would
// act across orgs (the reason the old `call_api` tool was removed). A write
// the user needs is a feature request, never a test run.
// ---------------------------------------------------------------------------

export interface DiscoveryIdentity {
  orgId: string;
  userId: string;
  runId: string;
  trackingHeaders?: Record<string, string>;
}

export class DiscoveryError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`[discovery] ${operation} refused by api-registry (${status}): ${body}`);
    this.name = "DiscoveryError";
  }
}

export class TestRunRefusedError extends Error {
  constructor(message: string) {
    super(`[discovery] test_endpoint refused: ${message}`);
    this.name = "TestRunRefusedError";
  }
}

/** A test result larger than this is cut (the context window stays small). */
export const TEST_RESULT_MAX_CHARS = 6000;

const enc = encodeURIComponent;

function registry(): { url: string; key: string } {
  const url = process.env.API_REGISTRY_SERVICE_URL;
  const key = process.env.API_REGISTRY_SERVICE_API_KEY;
  if (!url || !key) throw new Error("API_REGISTRY_SERVICE_URL / API_REGISTRY_SERVICE_API_KEY not configured");
  return { url, key };
}

async function get(operation: string, path: string): Promise<unknown> {
  const { url, key } = registry();
  const res = await fetch(`${url}${path}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(30_000) });
  const raw = await res.text();
  if (!res.ok) throw new DiscoveryError(operation, res.status, raw || "no body");
  return raw ? (JSON.parse(raw) as unknown) : {};
}

function str(name: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`[discovery] ${name} is required`);
  return v.trim();
}

function opt(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function query(params: Record<string, string | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${enc(v as string)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

function optLimit(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("[discovery] limit must be a whole number from 1 to 50");
  return String(n);
}

export const discoverServices = (a: Record<string, unknown>) =>
  get("discover_services", `/discover/services${query({ q: opt(a.q), limit: optLimit(a.limit) })}`);

export const discoverServiceEndpoints = (a: Record<string, unknown>) =>
  get(
    "discover_service_endpoints",
    `/discover/services/${enc(str("service", a.service))}/endpoints${query({
      q: opt(a.q),
      method: opt(a.method)?.toUpperCase() ?? null,
      limit: optLimit(a.limit),
    })}`,
  );

export const discoverEndpoint = (a: Record<string, unknown>) =>
  get(
    "discover_endpoint",
    `/discover/services/${enc(str("service", a.service))}/endpoint${query({
      method: str("method", a.method).toUpperCase(),
      path: str("path", a.path),
    })}`,
  );

/** Path prefixes a test run may reach: tenant-scoped (`/orgs`), public reads, the customer gateway. */
const TESTABLE_PREFIXES = ["/orgs/", "/public/", "/v1/"];
const FORBIDDEN_SEGMENT = /\/(internal|admin|staff|platform-[a-z-]+)(\/|$|\?)/i;

/** Validate a test-run target; returns the path to call (query string folded in). */
export function testRunPath(a: Record<string, unknown>): string {
  const method = (opt(a.method) ?? "GET").toUpperCase();
  if (method !== "GET") {
    throw new TestRunRefusedError(
      `only GET can be test-run from the chat (got ${method}). A write the user needs is a feature request (request_staff), never a test run.`,
    );
  }
  const path = str("path", a.path);
  if (!path.startsWith("/") || path.includes("..") || /^\/\//.test(path)) throw new TestRunRefusedError(`path must be an absolute route path, got ${path}`);
  if (!TESTABLE_PREFIXES.some((p) => path.startsWith(p))) {
    throw new TestRunRefusedError(`only ${TESTABLE_PREFIXES.join(", ")} routes can be test-run (they act for this org only), got ${path}`);
  }
  if (FORBIDDEN_SEGMENT.test(path)) throw new TestRunRefusedError(`internal, admin, staff and platform routes are never test-run, got ${path}`);
  const q = a.query;
  if (q === undefined || q === null || (typeof q === "string" && q.trim() === "")) return path;
  if (typeof q !== "string") throw new TestRunRefusedError("query must be a query string, e.g. \"limit=5&status=active\"");
  // Re-encode each pair so the model cannot smuggle a path or a fragment through the query.
  const pairs = q
    .trim()
    .replace(/^\?/, "")
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      const k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
      const v = i < 0 ? "" : decodeURIComponent(pair.slice(i + 1));
      return `${enc(k)}=${enc(v)}`;
    });
  if (pairs.length === 0) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${pairs.join("&")}`;
}

/** Cut a large body so one test run never floods the context. */
export function compactTestResult(status: number, ok: boolean, data: unknown) {
  const raw = typeof data === "string" ? data : JSON.stringify(data);
  if (raw === undefined || raw.length <= TEST_RESULT_MAX_CHARS) return { status, ok, data };
  return {
    status,
    ok,
    truncated: true,
    totalChars: raw.length,
    dataPreview: raw.slice(0, TEST_RESULT_MAX_CHARS),
    note: `Body cut at ${TEST_RESULT_MAX_CHARS} of ${raw.length} characters to keep the chat small. Narrow the call (query filters, a limit) to read the rest.`,
  };
}

/** POST /call/:service — a read-only test run with the chat's own identity. */
export async function testEndpoint(a: Record<string, unknown>, id: DiscoveryIdentity) {
  const service = str("service", a.service);
  const path = testRunPath(a);
  const { url, key } = registry();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": key,
    "x-org-id": id.orgId,
    "x-user-id": id.userId,
  };
  for (const [k, v] of Object.entries(id.trackingHeaders ?? {})) if (v) headers[k] = v;
  const res = await fetch(`${url}/call/${enc(service)}`, {
    method: "POST",
    headers,
    // The registry forwards x-org-id / x-user-id itself; the run id rides in `headers`
    // so the target links its run (and any cost) under this chat's run.
    body: JSON.stringify({ method: "GET", path, headers: { "x-run-id": id.runId } }),
    signal: AbortSignal.timeout(35_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new DiscoveryError("test_endpoint", res.status, raw || "no body");
  const out = JSON.parse(raw) as { status: number; ok: boolean; data: unknown };
  return { service, method: "GET", path, ...compactTestResult(out.status, out.ok, out.data) };
}

export const DISCOVERY_READ_TOOLS: Record<string, (a: Record<string, unknown>) => Promise<unknown>> = {
  discover_services: discoverServices,
  discover_service_endpoints: discoverServiceEndpoints,
  discover_endpoint: discoverEndpoint,
};
