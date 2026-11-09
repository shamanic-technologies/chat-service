// ---------------------------------------------------------------------------
// A brand's own MCP servers, as tools of our conversation AI (BRAND-MCP-1109,
// owner Kevin 2026-11-09: « passer d'une AI sans tools à une AI avec tools »).
//
// Each brand plugs, in its Integrations, the MCP server(s) it gives to the AI
// that writes to its leads and clients. Every turn that carries a brand (a
// Lead event turn, a /complete that opts in) loads that brand's servers' tools,
// each namespaced by its server so two servers never collide, and the model
// calls them like any other tool. Generic: no per-brand, per-channel or
// per-tool code; every tool a server lists is offered, read AND write
// (owner: « go wild pour now »).
//
//  - The Authorization value is a key-service BRAND key (`mcp-server-<id>`),
//    read only to call the server: never stored here, never returned.
//  - A server down or slow never blocks a turn: its tools are absent (listing
//    failed) or its call answers an error result the model reads; both are
//    logged loud and stored on the run as events.
//  - Each call is one run event (`brand-mcp-tool-call`): server, tool,
//    duration, ok/error, argument and result sizes; never the secret, never
//    the content.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import { brandMcpServers, type BrandMcpServer } from "../db/schema.js";
import type { WorkflowTrackingHeaders } from "../middleware/auth.js";
import type { ToolDefinition } from "./gemini-chat.js";
import { McpError, McpSession, type McpCallResult, type McpTool } from "./mcp-client.js";
import { traceEvent } from "./trace-event.js";

/** Run event of one brand tool call. */
export const BRAND_MCP_TOOL_EVENT = "brand-mcp-tool-call";
/** Run event of a server whose tools could not be listed at turn start. */
export const BRAND_MCP_UNAVAILABLE_EVENT = "brand-mcp-server-unavailable";

/** Listing a server's tools at turn start: past this, the turn goes on without it. */
export const LIST_TIMEOUT_MS = 10_000;
/** One tool call: past this, the model reads a timeout error and the turn goes on. */
export const CALL_TIMEOUT_MS = 30_000;
/** What a tool result may put in front of the model (characters). */
export const MAX_RESULT_CHARS = 20_000;
/** Servers a brand may plug. */
export const MAX_SERVERS_PER_BRAND = 10;

/** The one line every writer reads when the brand's own tools are there (strategy, never cases). */
export const BRAND_TOOLS_LINE =
  "The brand's own tools are below (names ending in its system's tools). Before you write, look up with them what this person already has with the brand. " +
  "When the brand's team asks you to act on a lead or a client (remove, disqualify, update), act through them, then say in a few words what you did.";

// ---------------------------------------------------------------------------
// Secrets (key-service brand keys)
// ---------------------------------------------------------------------------

const CALLER_SERVICE = "chat";

export function secretProviderName(serverId: string): string {
  return `mcp-server-${serverId}`;
}

export interface KeyCaller {
  orgId: string;
  userId: string;
  runId?: string | null;
}

function keyServiceEnv(): { url: string; key: string } {
  const url = process.env.KEY_SERVICE_URL || "https://key.mcpfactory.org";
  const key = process.env.KEY_SERVICE_API_KEY;
  if (!key) throw new Error("[brand-mcp] KEY_SERVICE_API_KEY is required");
  return { url, key };
}

function keyHeaders(caller: KeyCaller, method: string, path: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": keyServiceEnv().key,
    "x-org-id": caller.orgId,
    "x-user-id": caller.userId,
    ...(caller.runId ? { "x-run-id": caller.runId } : {}),
    "X-Caller-Service": CALLER_SERVICE,
    "X-Caller-Method": method,
    "X-Caller-Path": path,
  };
}

export interface SecretStore {
  save(caller: KeyCaller, brandId: string, serverId: string, authorization: string): Promise<void>;
  read(caller: KeyCaller, brandId: string, serverId: string): Promise<string>;
  remove(caller: KeyCaller, brandId: string, serverId: string): Promise<void>;
}

export const keyServiceSecrets: SecretStore = {
  async save(caller, brandId, serverId, authorization) {
    const { url } = keyServiceEnv();
    const res = await fetch(`${url}/keys/brands/${encodeURIComponent(brandId)}`, {
      method: "POST",
      headers: keyHeaders(caller, "POST", "/orgs/brands/:brandId/mcp-servers"),
      body: JSON.stringify({ provider: secretProviderName(serverId), apiKey: authorization }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`[brand-mcp] key-service POST /keys/brands/${brandId} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  },
  async read(caller, brandId, serverId) {
    const { url } = keyServiceEnv();
    const provider = secretProviderName(serverId);
    const res = await fetch(`${url}/keys/brands/${encodeURIComponent(brandId)}/${encodeURIComponent(provider)}/decrypt`, {
      headers: keyHeaders(caller, "POST", "/brand-mcp/call"),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`[brand-mcp] key-service decrypt ${provider} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const body = (await res.json()) as { key?: unknown };
    if (typeof body.key !== "string" || !body.key) throw new Error(`[brand-mcp] key-service decrypt ${provider} answered no key`);
    return body.key;
  },
  async remove(caller, brandId, serverId) {
    const { url } = keyServiceEnv();
    const provider = secretProviderName(serverId);
    const res = await fetch(`${url}/keys/brands/${encodeURIComponent(brandId)}/${encodeURIComponent(provider)}`, {
      method: "DELETE",
      headers: keyHeaders(caller, "DELETE", "/orgs/brands/:brandId/mcp-servers/:serverId"),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`[brand-mcp] key-service DELETE ${provider} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  },
};

// ---------------------------------------------------------------------------
// URL guard: a brand's server is a public HTTPS endpoint
// ---------------------------------------------------------------------------

/** Plain-words reason the URL cannot be a brand's MCP server, or null when it can. */
export function mcpUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "This is not a valid URL.";
  }
  if (u.protocol !== "https:") return "The server URL must start with https://.";
  if (u.username || u.password) return "Put credentials in the Authorization field, never in the URL.";
  const host = u.hostname.toLowerCase();
  // Our own network is never a brand's server: no bare hostname (a container
  // name), no IP literal, no localhost.
  if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return "The server must be reachable on the public internet (a full domain name).";
  }
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return "Use the server's domain name, not an IP address.";
  return null;
}

// ---------------------------------------------------------------------------
// Connect check (create, re-check, turn start)
// ---------------------------------------------------------------------------

export interface CheckResult {
  status: "connected" | "error";
  error: string | null;
  tools: McpTool[];
}

export type McpSessionLike = Pick<McpSession, "listTools" | "callTool">;
export type SessionFactory = (opts: { url: string; authorization: string | null; timeoutMs: number }) => McpSessionLike;

export const defaultSessionFactory: SessionFactory = (opts) => new McpSession(opts);

/** Connects and lists the tools; a failure is the reason in plain words. */
export async function checkServer(
  url: string,
  authorization: string | null,
  sessionFactory: SessionFactory = defaultSessionFactory,
): Promise<CheckResult & { session: McpSessionLike | null }> {
  // The session's own timeout is a call's; listing is bounded tighter.
  const session = sessionFactory({ url, authorization, timeoutMs: CALL_TIMEOUT_MS });
  try {
    const tools = await session.listTools(LIST_TIMEOUT_MS);
    return { status: "connected", error: null, tools, session };
  } catch (err) {
    const msg = err instanceof McpError ? err.message : err instanceof Error ? err.message : String(err);
    return { status: "error", error: `Could not connect: ${msg}.`, tools: [], session: null };
  }
}

/** What the list read and the routes answer: never the secret. */
export function serverView(row: BrandMcpServer) {
  return {
    id: row.id,
    brandId: row.brandId,
    name: row.name,
    url: row.url,
    hasAuthorization: row.hasAuth,
    status: row.status,
    error: row.error,
    toolCount: row.toolNames.length,
    toolNames: row.toolNames,
    checkedAt: row.checkedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listServers(database: typeof Db, orgId: string, brandId: string): Promise<BrandMcpServer[]> {
  return database
    .select()
    .from(brandMcpServers)
    .where(and(eq(brandMcpServers.orgId, orgId), eq(brandMcpServers.brandId, brandId)))
    .orderBy(asc(brandMcpServers.createdAt));
}

async function storeCheck(database: typeof Db, id: string, check: CheckResult): Promise<BrandMcpServer> {
  const [row] = await database
    .update(brandMcpServers)
    .set({ status: check.status, error: check.error, toolNames: check.tools.map((t) => t.name), checkedAt: new Date(), updatedAt: new Date() })
    .where(eq(brandMcpServers.id, id))
    .returning();
  return row;
}

export class BrandMcpInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export interface CreateServerInput {
  name: string;
  url: string;
  authorization?: string | null;
}

/** Stores a brand's server (its secret in key-service), connects, stores what the check found. */
export async function createServer(
  deps: { db: typeof Db; secrets?: SecretStore; sessionFactory?: SessionFactory },
  caller: KeyCaller,
  brandId: string,
  input: CreateServerInput,
): Promise<BrandMcpServer> {
  const secrets = deps.secrets ?? keyServiceSecrets;
  const url = input.url.trim();
  const problem = mcpUrlProblem(url);
  if (problem) throw new BrandMcpInputError(problem, 400);
  const existing = await listServers(deps.db, caller.orgId, brandId);
  if (existing.some((s) => s.url === url)) throw new BrandMcpInputError("This server is already plugged for this brand: re-check it or delete it first.", 409);
  if (existing.length >= MAX_SERVERS_PER_BRAND) throw new BrandMcpInputError(`A brand can plug at most ${MAX_SERVERS_PER_BRAND} MCP servers.`, 400);
  const authorization = input.authorization?.trim() || null;
  const id = crypto.randomUUID();
  // The secret first: a row that says "has authorization" always has one.
  if (authorization) await secrets.save(caller, brandId, id, authorization);
  const check = await checkServer(url, authorization, deps.sessionFactory);
  const [row] = await deps.db
    .insert(brandMcpServers)
    .values({
      id,
      orgId: caller.orgId,
      brandId,
      name: input.name.trim(),
      url,
      hasAuth: authorization !== null,
      createdByUserId: caller.userId,
      status: check.status,
      error: check.error,
      toolNames: check.tools.map((t) => t.name),
    })
    .returning();
  if (check.status === "error") console.warn(`[chat-service] brand MCP server ${id} (org ${caller.orgId}, brand ${brandId}) plugged but not connected: ${check.error}`);
  return row;
}

async function getServer(database: typeof Db, orgId: string, brandId: string, serverId: string): Promise<BrandMcpServer> {
  const [row] = await database
    .select()
    .from(brandMcpServers)
    .where(and(eq(brandMcpServers.id, serverId), eq(brandMcpServers.orgId, orgId), eq(brandMcpServers.brandId, brandId)));
  if (!row) throw new BrandMcpInputError("No such MCP server for this brand.", 404);
  return row;
}

/** Connects again and stores what it found. */
export async function recheckServer(
  deps: { db: typeof Db; secrets?: SecretStore; sessionFactory?: SessionFactory },
  caller: KeyCaller,
  brandId: string,
  serverId: string,
): Promise<BrandMcpServer> {
  const row = await getServer(deps.db, caller.orgId, brandId, serverId);
  const authorization = row.hasAuth ? await (deps.secrets ?? keyServiceSecrets).read({ ...caller, userId: row.createdByUserId }, brandId, row.id) : null;
  return storeCheck(deps.db, row.id, await checkServer(row.url, authorization, deps.sessionFactory));
}

export async function deleteServer(
  deps: { db: typeof Db; secrets?: SecretStore },
  caller: KeyCaller,
  brandId: string,
  serverId: string,
): Promise<void> {
  const row = await getServer(deps.db, caller.orgId, brandId, serverId);
  if (row.hasAuth) await (deps.secrets ?? keyServiceSecrets).remove(caller, brandId, row.id);
  await deps.db.delete(brandMcpServers).where(eq(brandMcpServers.id, row.id));
}

// ---------------------------------------------------------------------------
// The tools of one turn
// ---------------------------------------------------------------------------

const TOOL_NAME_MAX = 64;

/** A server's prefix: its name as `a-z0-9_`, at most 24 characters. */
export function serverPrefix(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24)
    .replace(/_+$/g, "");
  return slug || "mcp";
}

/** `<server>__<tool>`, valid for every provider (`^[a-zA-Z0-9_-]{1,64}$`). */
export function namespacedToolName(prefix: string, tool: string): string {
  const clean = tool.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const full = `${prefix}__${clean}`;
  if (full.length <= TOOL_NAME_MAX) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 8);
  return `${full.slice(0, TOOL_NAME_MAX - 9)}_${hash}`;
}

/** One server's prefix per server, unique within the brand (`_2`, `_3` on a clash). */
export function serverPrefixes(names: readonly string[]): string[] {
  const used = new Map<string, number>();
  return names.map((n) => {
    const base = serverPrefix(n);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

/** A server's tool as the model sees it (Anthropic shape, the three loops convert it). */
export function toToolDefinition(serverName: string, exposedName: string, tool: McpTool): ToolDefinition {
  const schema = (tool.inputSchema ?? {}) as { properties?: unknown; required?: unknown };
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) ? (schema.properties as Record<string, unknown>) : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string" && r in properties) : [];
  const description = (tool.description ?? "").trim().slice(0, 1_500);
  return {
    name: exposedName,
    description: `${serverName}, the brand's own system: its tool "${tool.name}".${description ? ` ${description}` : ""}`,
    input_schema: { type: "object", properties, ...(required.length ? { required } : {}) },
  };
}

/** What a call answers the model: the server's text (bounded), its error flag, its structured output when small. */
export function resultForModel(result: McpCallResult): Record<string, unknown> {
  const parts = (result.content ?? []).map((c) => {
    if (c.type === "text" && typeof c.text === "string") return c.text;
    if (c.type === "resource" && c.resource && typeof (c.resource as { text?: unknown }).text === "string") return String((c.resource as { text: string }).text);
    return `[${String(c.type ?? "content")} not shown]`;
  });
  let text = parts.join("\n");
  const truncated = text.length > MAX_RESULT_CHARS;
  if (truncated) text = `${text.slice(0, MAX_RESULT_CHARS)}\n[cut: ${text.length - MAX_RESULT_CHARS} more characters]`;
  const structured = result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : "";
  return {
    ok: result.isError !== true,
    ...(text ? { content: text } : {}),
    ...(!text && structured && structured.length <= MAX_RESULT_CHARS ? { structuredContent: result.structuredContent } : {}),
  };
}

export interface TurnScope {
  orgId: string;
  brandId: string;
  /** The turn's run: every call is an event on it. */
  runId: string;
  /** Identity the run's events are written under. */
  eventIdentity: { orgId: string; userId: string };
  tracking: WorkflowTrackingHeaders;
}

export interface BrandToolset {
  tools: ToolDefinition[];
  has(name: string): boolean;
  /** Runs a tool; a failure is an error RESULT (the turn goes on), never a throw. */
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Servers whose tools are offered, for logs. */
  servers: Array<{ id: string; name: string; tools: number }>;
}

export interface ToolsetDeps {
  db: typeof Db;
  secrets?: SecretStore;
  sessionFactory?: SessionFactory;
  /** Run events (traceEvent by default). */
  trace?: typeof traceEvent;
  now?: () => number;
}

/**
 * The brand's tools for one turn: every plugged server listed live (in
 * parallel, bounded), its tools namespaced. Null when the brand plugged none
 * (the turn is then exactly what it was before). A server that cannot be
 * listed is left out, logged loud and stored on the run; its stored check
 * says why for the brand's Integrations page.
 */
export async function loadBrandToolset(deps: ToolsetDeps, scope: TurnScope): Promise<BrandToolset | null> {
  const rows = await listServers(deps.db, scope.orgId, scope.brandId);
  if (rows.length === 0) return null;
  const trace = deps.trace ?? traceEvent;
  const now = deps.now ?? Date.now;
  const prefixes = serverPrefixes(rows.map((r) => r.name));
  const loaded = await Promise.all(
    rows.map(async (row, i) => {
      let check: Awaited<ReturnType<typeof checkServer>>;
      try {
        const authorization = row.hasAuth
          ? await (deps.secrets ?? keyServiceSecrets).read({ orgId: row.orgId, userId: row.createdByUserId, runId: scope.runId }, row.brandId, row.id)
          : null;
        check = await checkServer(row.url, authorization, deps.sessionFactory);
      } catch (err) {
        check = { status: "error", error: `Could not read its Authorization: ${err instanceof Error ? err.message : String(err)}`, tools: [], session: null };
      }
      await storeCheck(deps.db, row.id, check).catch((err) => console.error(`[chat-service] brand MCP server ${row.id}: storing its check failed:`, err));
      if (check.status === "error" || !check.session) {
        console.error(`[chat-service] brand MCP server ${row.id} "${row.name}" (org ${row.orgId}, brand ${row.brandId}) unavailable this turn: ${check.error}`);
        trace(scope.runId, BRAND_MCP_UNAVAILABLE_EVENT, scope.eventIdentity, scope.tracking, {
          level: "error",
          detail: check.error ?? "unavailable",
          data: { serverId: row.id, serverName: row.name, brandId: row.brandId },
        });
        return null;
      }
      return { row, prefix: prefixes[i], tools: check.tools, session: check.session };
    }),
  );
  const routes = new Map<string, { row: BrandMcpServer; tool: string; session: McpSessionLike }>();
  const tools: ToolDefinition[] = [];
  const servers: BrandToolset["servers"] = [];
  for (const s of loaded) {
    if (!s) continue;
    servers.push({ id: s.row.id, name: s.row.name, tools: s.tools.length });
    for (const tool of s.tools) {
      const exposed = namespacedToolName(s.prefix, tool.name);
      if (routes.has(exposed)) continue;
      routes.set(exposed, { row: s.row, tool: tool.name, session: s.session });
      tools.push(toToolDefinition(s.row.name, exposed, tool));
    }
  }
  return {
    tools,
    servers,
    has: (name) => routes.has(name),
    async call(name, args) {
      const route = routes.get(name);
      if (!route) return { error: `No brand tool named ${name}.` };
      const started = now();
      const argsChars = JSON.stringify(args ?? {}).length;
      let result: Record<string, unknown>;
      let error: string | null = null;
      try {
        result = resultForModel(await route.session.callTool(route.tool, args ?? {}, CALL_TIMEOUT_MS));
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: `${route.row.name} could not run ${route.tool}: ${error}. Go on without it.` };
        console.error(`[chat-service] brand MCP tool ${route.row.name}/${route.tool} (server ${route.row.id}, run ${scope.runId}) failed: ${error}`);
      }
      const ok = error === null && result.ok === true;
      trace(scope.runId, BRAND_MCP_TOOL_EVENT, scope.eventIdentity, scope.tracking, {
        level: ok ? "info" : "warn",
        detail: `${route.row.name} / ${route.tool}: ${ok ? "ok" : error ? "failed" : "error result"}`,
        data: {
          serverId: route.row.id,
          serverName: route.row.name,
          brandId: route.row.brandId,
          tool: route.tool,
          durationMs: now() - started,
          ok,
          ...(error ? { error: error.slice(0, 300) } : {}),
          argsChars,
          resultChars: JSON.stringify(result).length,
        },
      });
      return result;
    },
  };
}
