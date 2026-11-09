import { describe, it, expect, vi } from "vitest";
import { McpError, McpSession } from "../../src/lib/mcp-client.js";
import {
  BRAND_MCP_TOOL_EVENT,
  BRAND_TOOLS_LINE,
  MAX_RESULT_CHARS,
  mcpUrlProblem,
  namespacedToolName,
  resultForModel,
  serverPrefixes,
  serverView,
  toToolDefinition,
} from "../../src/lib/brand-mcp.js";
import { brandToolsBlock } from "../../src/lib/lead-turn.js";
import type { BrandMcpServer } from "../../src/db/schema.js";

type Handler = (body: Record<string, unknown>, headers: Record<string, string>) => Response | Promise<Response>;

function fakeServer(handler: Handler) {
  const calls: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const headers = init.headers as Record<string, string>;
    calls.push({ body, headers });
    return handler(body, headers);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

const sse = (messages: unknown[]) =>
  new Response(messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

describe("MCP client (Streamable HTTP)", () => {
  it("initializes, keeps the session id, sends initialized, then lists tools across pages", async () => {
    const { fetchImpl, calls } = fakeServer((body) => {
      if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }, { "mcp-session-id": "s-1" });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list" && !(body.params as { cursor?: string } | undefined)?.cursor) {
        return sse([{ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "a" }], nextCursor: "p2" } }]);
      }
      return json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "b", description: "B" }] } });
    });
    const session = new McpSession({ url: "https://mcp.example.com/mcp", authorization: "Bearer k", fetchImpl });
    const tools = await session.listTools();
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(calls.map((c) => c.body.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    expect(calls[0].headers["Mcp-Session-Id"]).toBeUndefined();
    expect(calls[2].headers["Mcp-Session-Id"]).toBe("s-1");
    expect(calls[2].headers["MCP-Protocol-Version"]).toBe("2025-06-18");
    expect(calls.every((c) => c.headers.Authorization === "Bearer k")).toBe(true);
    expect(calls[0].headers.Accept).toBe("application/json, text/event-stream");
  });

  it("reads the response with OUR id out of an event stream that carries other messages first", async () => {
    const { fetchImpl } = fakeServer((body) => {
      if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: {} });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return sse([{ jsonrpc: "2.0", method: "notifications/progress", params: {} }, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "done" }] } }]);
    });
    const result = await new McpSession({ url: "https://x.example.com/mcp", fetchImpl }).callTool("t", { a: 1 });
    expect(result.content?.[0]).toEqual({ type: "text", text: "done" });
  });

  it("says in plain words when the credentials are refused", async () => {
    const { fetchImpl } = fakeServer(() => new Response("nope", { status: 401 }));
    await expect(new McpSession({ url: "https://x.example.com/mcp", fetchImpl }).listTools()).rejects.toThrow(/refused our credentials \(HTTP 401\)/);
  });

  it("a JSON-RPC error is an McpError carrying the server's message", async () => {
    const { fetchImpl } = fakeServer((body) => {
      if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: {} });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Unknown tool" } });
    });
    const err = await new McpSession({ url: "https://x.example.com/mcp", fetchImpl }).callTool("zz", {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(String(err.message)).toContain("Unknown tool");
  });

  it("re-opens a session the server forgot (404 with a session id), once", async () => {
    let inits = 0;
    let forgot = false;
    const { fetchImpl } = fakeServer((body) => {
      if (body.method === "initialize") {
        inits++;
        return json({ jsonrpc: "2.0", id: body.id, result: {} }, { "mcp-session-id": `s-${inits}` });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (!forgot) {
        forgot = true;
        return new Response("", { status: 404 });
      }
      return json({ jsonrpc: "2.0", id: body.id, result: { content: [] } });
    });
    await new McpSession({ url: "https://x.example.com/mcp", fetchImpl }).callTool("t", {});
    expect(inits).toBe(2);
  });

  it("a server that does not answer in time is a timeout McpError", async () => {
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      await new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))));
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const err = await new McpSession({ url: "https://x.example.com/mcp", fetchImpl, timeoutMs: 30 }).listTools().catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toMatch(/did not answer within/);
  });
});

describe("brand tools: names, URL, what the model and the brand read", () => {
  it("namespaces every tool by its server, valid for every provider, unique across servers", () => {
    const prefixes = serverPrefixes(["Distribute", "distribute", "Mon CRM (prod)"]);
    expect(prefixes).toEqual(["distribute", "distribute_2", "mon_crm_prod"]);
    const name = namespacedToolName(prefixes[0], "distribute_list_leads");
    expect(name).toBe("distribute__distribute_list_leads");
    const long = namespacedToolName("a_very_long_server_name_x", "x".repeat(80));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(namespacedToolName("crm", "get.lead/v2")).toBe("crm__get_lead_v2");
  });

  it("a brand's server is a public https endpoint, never our own network", () => {
    expect(mcpUrlProblem("https://mcp.distribute.you/mcp")).toBeNull();
    expect(mcpUrlProblem("http://mcp.example.com/mcp")).toMatch(/https/);
    expect(mcpUrlProblem("https://key-service:8080/keys")).toMatch(/public internet/);
    expect(mcpUrlProblem("https://localhost/mcp")).toMatch(/public internet/);
    expect(mcpUrlProblem("https://10.0.0.4/mcp")).toMatch(/IP address/);
    expect(mcpUrlProblem("https://user:pw@mcp.example.com/mcp")).toMatch(/Authorization field/);
    expect(mcpUrlProblem("not a url")).toMatch(/not a valid URL/);
  });

  it("a tool keeps its input schema (properties, required that exist) and says whose system it is", () => {
    const def = toToolDefinition("Distribute", "distribute__get_lead", {
      name: "get_lead",
      description: "One lead.",
      inputSchema: { type: "object", properties: { leadId: { type: "string" } }, required: ["leadId", "ghost"], additionalProperties: false },
    });
    expect(def.input_schema).toEqual({ type: "object", properties: { leadId: { type: "string" } }, required: ["leadId"] });
    expect(def.description).toContain("Distribute, the brand's own system");
    expect(def.description).toContain("One lead.");
  });

  it("a result shows the server's text, bounded, and its error flag", () => {
    expect(resultForModel({ content: [{ type: "text", text: "hi" }] })).toEqual({ ok: true, content: "hi" });
    expect(resultForModel({ content: [{ type: "text", text: "bad" }], isError: true })).toEqual({ ok: false, content: "bad" });
    const big = resultForModel({ content: [{ type: "text", text: "x".repeat(MAX_RESULT_CHARS + 50) }] });
    expect(String(big.content)).toContain("[cut: 50 more characters]");
    expect(resultForModel({ content: [], structuredContent: { a: 1 } })).toEqual({ ok: true, structuredContent: { a: 1 } });
  });

  it("the list read never carries the Authorization value", () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      orgId: "o",
      brandId: "b",
      name: "Distribute",
      url: "https://mcp.distribute.you/mcp",
      hasAuth: true,
      createdByUserId: "u",
      status: "connected",
      error: null,
      toolNames: ["a", "b"],
      checkedAt: new Date("2026-11-09T10:00:00Z"),
      createdAt: new Date("2026-11-09T10:00:00Z"),
      updatedAt: new Date("2026-11-09T10:00:00Z"),
    } as BrandMcpServer;
    const view = serverView(row);
    expect(view).toEqual({
      id: row.id,
      brandId: "b",
      name: "Distribute",
      url: "https://mcp.distribute.you/mcp",
      hasAuthorization: true,
      status: "connected",
      error: null,
      toolCount: 2,
      toolNames: ["a", "b"],
      checkedAt: "2026-11-09T10:00:00.000Z",
      createdAt: "2026-11-09T10:00:00.000Z",
    });
    expect(JSON.stringify(view)).not.toMatch(/Bearer|authorization"/);
  });

  it("the writer's line is the strategy (look up first, act when asked, say what you did), one block", () => {
    expect(BRAND_TOOLS_LINE).toMatch(/look up/i);
    expect(BRAND_TOOLS_LINE).toMatch(/remove, disqualify, update/);
    expect(brandToolsBlock()).toContain(BRAND_TOOLS_LINE);
    expect(BRAND_MCP_TOOL_EVENT).toBe("brand-mcp-tool-call");
  });
});

describe("the opt-in field and the route body (wire contract)", async () => {
  const { CompleteRequestSchema, InternalPlatformCompleteRequestSchema, BrandMcpServerCreateSchema } = await import("../../src/schemas.js");
  const base = { message: "m", systemPrompt: "", provider: "deepseek", model: "deepseek-flash" };
  const brandId = "4c6b1d3e-2f0a-4b8e-9d7c-1a2b3c4d5e6f";

  it("/complete takes brandTools { brandId }; without it the parsed request carries nothing new", () => {
    const withIt = CompleteRequestSchema.safeParse({ ...base, brandTools: { brandId } });
    expect(withIt.success).toBe(true);
    expect(withIt.data?.brandTools).toEqual({ brandId });
    const without = CompleteRequestSchema.safeParse(base);
    expect(without.success).toBe(true);
    expect("brandTools" in (without.data as object)).toBe(false);
    expect(CompleteRequestSchema.safeParse({ ...base, brandTools: { brandId, orgId: brandId } }).success).toBe(false);
    expect(CompleteRequestSchema.safeParse({ ...base, brandTools: { brandId: "nope" } }).success).toBe(false);
  });

  it("/internal/platform-complete names the brand's org (no org header on that tier)", () => {
    expect(InternalPlatformCompleteRequestSchema.safeParse({ ...base, brandTools: { brandId } }).success).toBe(false);
    expect(InternalPlatformCompleteRequestSchema.safeParse({ ...base, brandTools: { brandId, orgId: brandId } }).success).toBe(true);
  });

  it("plug body: name, url, optional authorization; nothing else", () => {
    expect(BrandMcpServerCreateSchema.safeParse({ name: "Distribute", url: "https://mcp.distribute.you/mcp", authorization: "Bearer k" }).success).toBe(true);
    expect(BrandMcpServerCreateSchema.safeParse({ name: "Distribute", url: "https://mcp.distribute.you/mcp" }).success).toBe(true);
    expect(BrandMcpServerCreateSchema.safeParse({ name: "", url: "https://x.example.com" }).success).toBe(false);
    expect(BrandMcpServerCreateSchema.safeParse({ name: "a", url: "https://x.example.com", headers: {} }).success).toBe(false);
  });
});
