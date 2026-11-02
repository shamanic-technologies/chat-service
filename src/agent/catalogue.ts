// ---------------------------------------------------------------------------
// Sophie's capability catalogue = the gateway's served API document
// (SOPHIE-REFONTE-1102 P2, owner 2026-11-02: « ONE capability catalogue = the
// gateway's served openapi, like the MCP already does »).
//
// Ported from the distribute.you MCP (mcp/src/lib/gateway-catalog.ts): the
// same compile, intent search, path matching and schema resolution, so Sophie
// and an outside AI on the MCP find the same operations for the same words.
// What differs: Sophie reads the PUBLIC document (she acts for a client, never
// with staff powers), and calls go through chat-service's gateway client as
// the person (agent/catalogue-tools.ts).
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export interface CatalogParam {
  name: string;
  in: "path" | "query";
  required: boolean;
  description: string | null;
  type: string | null;
  enum?: unknown[];
}

export interface CatalogResponse {
  status: string;
  description: string | null;
  /** The media type of the answer when it is not JSON (a stream, a file); null for JSON. */
  contentType: string | null;
  /** The JSON answer's schema, refs unresolved; null when the document states none. */
  schema: unknown;
}

export interface CatalogOperation {
  operationId: string;
  method: HttpMethod;
  path: string;
  tag: string | null;
  summary: string;
  description: string;
  params: CatalogParam[];
  hasBody: boolean;
  bodySchema: unknown;
  /** What a successful call answers, per 2xx status, as the served document states it (empty: undocumented). */
  successResponses: CatalogResponse[];
  needsKey: boolean;
  deprecated: boolean;
  /** Served only to a staff user's key (`x-staff-only: true`). The gateway still decides on each call. */
  staffOnly: boolean;
  /** The operation's own `x-*` extensions, as served (the yes marker among them). */
  extensions: Record<string, unknown>;
}

/**
 * Gateway operations that expose OUR internals rather than the customer's
 * account: prompt templates and their assignments, and the internal service
 * registry. Never reachable through this server, whatever the gateway answers.
 * Matched on the path template, prefix-wise.
 */
export const PLATFORM_INTERNAL_PATHS: string[] = [
  "/v1/prompts",
  "/v1/content/platform-prompts",
  "/v1/content/prompt-assignments",
  "/v1/platform/",
];

/** The gateway's infrastructure endpoints: not account capabilities. */
const NOT_CAPABILITIES = new Set(["/", "/health", "/openapi.json"]);

export function isPlatformInternal(pathTemplate: string): boolean {
  return PLATFORM_INTERNAL_PATHS.some((p) => pathTemplate === p || pathTemplate.startsWith(p.endsWith("/") ? p : `${p}/`));
}

type Json = Record<string, unknown>;

interface Compiled {
  operations: CatalogOperation[];
  components: Json;
  loadedAt: number;
  /** The gateway's ETag for the document this copy was compiled from (null: none sent, never reused). */
  etag: string | null;
}

let held: Compiled | null = null;
let inflight: Promise<Compiled> | null = null;

/** Test seam: serve this document instead of the gateway's. */
export function loadCatalogFromDocument(doc: Json, now = Date.now()): Compiled {
  held = { ...compile(doc, now), etag: "pinned" };
  pinned = true;
  return held;
}
let pinned = false;

export function resetCatalog(): void {
  held = null;
  inflight = null;
  pinned = false;
}

const gatewayUrl = () => process.env.API_SERVICE_URL || "https://api.distribute.you";

/**
 * The gateway's PUBLIC document, the customer contract (what a client key is
 * served): staff-only operations are absent from it by construction. Reused
 * while the gateway's ETag is unchanged (a HEAD per call, like the MCP: a route
 * the gateway ships is usable at once).
 */
export async function getCatalog(): Promise<Compiled> {
  if (pinned && held) return held;
  const head = await fetch(`${gatewayUrl()}/openapi.json`, { method: "HEAD" });
  if (!head.ok) throw new Error(`[catalogue] the gateway's /openapi.json check answered HTTP ${head.status}`);
  const etag = head.headers.get("etag");
  if (held && etag && held.etag === etag) return held;
  inflight ??= fetch(`${gatewayUrl()}/openapi.json`, { headers: { Accept: "application/json" } })
    .then(async (res) => {
      if (!res.ok) throw new Error(`[catalogue] the gateway's /openapi.json answered HTTP ${res.status}`);
      held = { ...compile((await res.json()) as Json, Date.now()), etag: res.headers.get("etag") };
      return held;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function compile(doc: Json, now: number): Omit<Compiled, "etag"> {
  const paths = (doc.paths ?? {}) as Record<string, Json>;
  const operations: CatalogOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (NOT_CAPABILITIES.has(path) || isPlatformInternal(path)) continue;
    const shared = (item.parameters ?? []) as Json[];
    for (const method of METHODS) {
      const op = item[method.toLowerCase()] as Json | undefined;
      if (!op) continue;
      const rawParams = [...shared, ...((op.parameters ?? []) as Json[])];
      const params: CatalogParam[] = [];
      for (const p of rawParams) {
        if (p.in !== "path" && p.in !== "query") continue; // header params (x-org-id, x-request-id...) are the gateway's plumbing: orgId/brandId go in the query
        const schema = (p.schema ?? {}) as Json;
        params.push({
          name: String(p.name),
          in: p.in as "path" | "query",
          required: p.required === true || p.in === "path",
          description: (p.description as string) ?? (schema.description as string) ?? null,
          type: (schema.type as string) ?? null,
          ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
        });
      }
      const body = ((op.requestBody as Json | undefined)?.content as Json | undefined)?.["application/json"] as Json | undefined;
      operations.push({
        operationId: (op.operationId as string) || `${method} ${path}`,
        method,
        path,
        tag: Array.isArray(op.tags) && op.tags.length ? String(op.tags[0]) : null,
        summary: String(op.summary ?? ""),
        description: String(op.description ?? ""),
        params,
        hasBody: !!op.requestBody,
        bodySchema: body?.schema ?? null,
        successResponses: successResponses(op.responses),
        needsKey: Array.isArray(op.security) && op.security.length > 0,
        deprecated: op.deprecated === true,
        staffOnly: op["x-staff-only"] === true,
        extensions: Object.fromEntries(Object.entries(op).filter(([k]) => k.startsWith("x-"))),
      });
    }
  }
  return { operations, components: ((doc.components as Json)?.schemas ?? {}) as Json, loadedAt: now };
}

/** The 2xx answers an operation documents, in status order. A bare `{}` schema states nothing and reads as none. */
function successResponses(responses: unknown): CatalogResponse[] {
  if (!responses || typeof responses !== "object") return [];
  const out: CatalogResponse[] = [];
  for (const [status, raw] of Object.entries(responses as Record<string, Json>)) {
    if (!/^2\d\d$/.test(status) || !raw || typeof raw !== "object") continue;
    const content = (raw.content ?? {}) as Record<string, Json>;
    const json = content["application/json"];
    const schema = json?.schema && typeof json.schema === "object" && Object.keys(json.schema as Json).length ? json.schema : null;
    const other = json ? null : (Object.keys(content)[0] ?? null);
    out.push({ status, description: typeof raw.description === "string" ? raw.description : null, contentType: other, schema });
  }
  return out.sort((a, b) => a.status.localeCompare(b.status));
}

// ── Search by intent ─────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  "a an the of for to in on my our me i we you your with and or by from at is are be all every each list get show give read see find what which who how do does did done was were has have had when where can please that this it its".split(" "),
);

/** Words people use for a capability, mapped onto the words the gateway uses. */
const SYNONYMS: Record<string, string[]> = {
  prospect: ["lead"],
  contact: ["lead", "crm"],
  person: ["lead", "people"],
  people: ["lead"],
  mail: ["email"],
  message: ["email", "conversation"],
  reply: ["conversation", "message"],
  replied: ["conversation"],
  wrote: ["conversation"],
  said: ["conversation"],
  thread: ["conversation"],
  inbox: ["conversation"],
  unibox: ["conversation"],
  company: ["brand"],
  website: ["brand"],
  site: ["brand"],
  balance: ["billing", "account"],
  credit: ["billing"],
  money: ["billing", "revenue"],
  invoice: ["billing", "payment"],
  spend: ["cost", "billing"],
  // A campaign IS a sales funnel campaign, and its money is its caps (a max budget and/or a max
  // volume per period): today's words for it land on the funnel and its caps.
  campaign: ["funnel"],
  budget: ["budget", "cap"],
  max: ["cap"],
  cap: ["max"],
  volume: ["cap", "max"],
  limit: ["cap", "max"],
  catalog: ["catalogue", "price"],
  catalogue: ["price"],
  price: ["catalogue", "cost"],
  priced: ["price", "catalogue"],
  cost: ["price"],
  // The gateway states a cap rather than setting it.
  set: ["state"],
  change: ["state", "update"],
  day: ["daily"],
  week: ["weekly"],
  month: ["monthly"],
  performance: ["stat"],
  result: ["stat"],
  metric: ["stat"],
  sequence: ["email", "followup"],
  "follow-up": ["followup"],
  followup: ["followup", "email"],
  org: ["organization"],
  organization: ["org"],
  client: ["organization", "org"],
  customer: ["organization", "org"],
  account: ["organization"],
  invite: ["invitation", "member"],
  invitation: ["invite", "member"],
  teammate: ["member", "invite"],
  colleague: ["member", "invite"],
  member: ["invite", "invitation"],
  grant: ["credit", "free"],
  free: ["credit", "grant"],
  gift: ["credit", "grant"],
  answer: ["reply", "conversation"],
};

/** Crude stem: lowercase, strip plural / -ing / -ed, so "emails" finds "email". */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 3 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("es") && !w.endsWith("ses")) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

function tokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .flatMap((t) => (t.includes("-") ? [t, ...t.split("-")] : [t]))
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

const VERB_METHOD: Record<string, HttpMethod> = {
  list: "GET", get: "GET", show: "GET", read: "GET", see: "GET", find: "GET", fetch: "GET",
  create: "POST", add: "POST", start: "POST", send: "POST", launch: "POST",
  update: "PATCH", change: "PATCH", set: "PUT", edit: "PATCH",
  delete: "DELETE", remove: "DELETE", revoke: "DELETE", cancel: "DELETE",
  grant: "POST", invite: "POST", open: "POST",
  cap: "PUT", limit: "PUT",
};

/**
 * Verbs that only say what to DO when they open the ask: "reply to Ann" is a
 * write, "what did Ann reply" is a read.
 */
const LEADING_VERB_METHOD: Record<string, HttpMethod> = {
  reply: "POST", answer: "POST",
  // A question asks to read.
  what: "GET", who: "GET", did: "GET", has: "GET", have: "GET", how: "GET", when: "GET", which: "GET", is: "GET", are: "GET",
};

export interface SearchHit {
  operationId: string;
  method: HttpMethod;
  path: string;
  tag: string | null;
  summary: string;
  required: string[];
  /** Present (true) only on an operation the gateway serves to a staff user's key alone. */
  staffOnly?: true;
  score: number;
}

export function searchOperations(ops: CatalogOperation[], query: string, limit = 10, tag?: string): SearchHit[] {
  const words = [...new Set(tokens(query))];
  // Each word of the ask, with the gateway words it may appear as.
  const asked = words.map((w) => ({
    forms: [[w, 1] as [string, number], ...(SYNONYMS[w] ?? []).map((s) => [stem(s), 0.8] as [string, number]).filter(([s]) => s !== w)],
  }));
  const rawWords = query.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const wantMethod = LEADING_VERB_METHOD[rawWords[0] ?? ""] ?? rawWords.map((w) => VERB_METHOD[w]).find(Boolean);

  const hits: SearchHit[] = [];
  for (const op of ops) {
    if (tag && (op.tag ?? "").toLowerCase() !== tag.toLowerCase()) continue;
    const fields: Array<[Set<string>, number]> = [
      [new Set(tokens(op.summary)), 3],
      [new Set(tokens(op.path.replace(/\{[^}]+\}/g, " "))), 2.5],
      [new Set(tokens(op.tag ?? "")), 2],
      [new Set(tokens(op.operationId)), 1],
      [new Set(tokens(op.description.slice(0, 600))), 1],
    ];
    let score = 0;
    let matched = 0;
    for (const { forms } of asked) {
      let best = 0;
      for (const [tok, mult] of forms) for (const [set, weight] of fields) if (set.has(tok)) best = Math.max(best, weight * mult);
      if (best > 0) matched += 1;
      score += best;
    }
    if (score === 0) continue;
    // Every word of the ask found somewhere beats a few found strongly.
    score += words.length ? (matched / words.length) * 3 : 0;
    if (wantMethod && op.method === wantMethod) score += 1.5;
    if (op.deprecated) score -= 2;
    hits.push({
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      tag: op.tag,
      summary: op.summary,
      required: op.params.filter((p) => p.required).map((p) => `${p.name} (${p.in})`),
      ...(op.staffOnly ? { staffOnly: true as const } : {}),
      score: Math.round(score * 10) / 10,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return hits.slice(0, limit);
}

// ── Lookup and path matching ────────────────────────────────────────────────

export function findOperation(
  ops: CatalogOperation[],
  ref: { operationId?: string; method?: string; path?: string },
): CatalogOperation | null {
  if (ref.operationId) {
    const byId = ops.find((o) => o.operationId === ref.operationId);
    if (byId) return byId;
  }
  if (ref.method && ref.path) {
    const m = ref.method.toUpperCase();
    return ops.find((o) => o.method === m && o.path === ref.path) ?? matchPath(ops, m, ref.path)?.operation ?? null;
  }
  return null;
}

function templateRegex(template: string): RegExp {
  const src = template
    .split("/")
    .map((seg) => (/^\{[^}]+\}$/.test(seg) ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${src}$`);
}

const literalSegments = (template: string) => template.split("/").filter((s) => s && !s.startsWith("{")).length;

/**
 * The operation a concrete path (`/v1/leads/abc`) is an instance of. When
 * several templates fit (`/v1/leads/stats` and `/v1/leads/{id}`), the one with
 * the most literal segments wins, which is how the gateway's router reads it.
 * Returns the templates that fit the path under ANY method when none fits this one.
 */
export function matchPath(
  ops: CatalogOperation[],
  method: string,
  path: string,
): { operation: CatalogOperation | null; otherMethods: HttpMethod[] } | null {
  const fitting = ops.filter((o) => templateRegex(o.path).test(path));
  if (fitting.length === 0) return null;
  const sameMethod = fitting.filter((o) => o.method === method.toUpperCase());
  sameMethod.sort((a, b) => literalSegments(b.path) - literalSegments(a.path));
  return {
    operation: sameMethod[0] ?? null,
    otherMethods: [...new Set(fitting.map((o) => o.method))],
  };
}

/**
 * A JSON schema with its `$ref`s inlined, depth-limited, so an assistant reads a
 * request body's shape in one call. A ref deeper than `depth` is left as its name.
 */
export function resolveSchema(schema: unknown, components: Json, depth = 4): unknown {
  if (Array.isArray(schema)) return schema.map((s) => resolveSchema(s, components, depth));
  if (!schema || typeof schema !== "object") return schema;
  const obj = schema as Json;
  if (typeof obj.$ref === "string") {
    const name = obj.$ref.split("/").pop() as string;
    if (depth <= 0 || !(name in components)) return { $ref: name };
    return resolveSchema(components[name], components, depth - 1);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveSchema(v, components, depth)]));
}
