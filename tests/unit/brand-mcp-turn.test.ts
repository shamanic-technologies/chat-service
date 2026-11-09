import { describe, it, expect, vi, beforeEach } from "vitest";

const vendorLoop = vi.hoisted(() => ({ calls: [] as Array<Array<{ name: string; args: Record<string, unknown> }>> }));

// The vendor loop as a script: each round = the tool calls the "model" makes.
vi.mock("../../src/lib/vendor-chat.js", () => ({
  streamVendorChat: vi.fn(async (opts: { executeTool: (c: { name: string; args: Record<string, unknown> }) => Promise<unknown>; beforeProviderCall: (d: { depth: number; requestBody: Record<string, unknown>; at: Date }) => Promise<void>; onRoundBilled?: (l: Array<{ costName: string; quantity: number }>) => void; tools: Array<{ name: string }> }) => {
    let depth = 0;
    for (const round of vendorLoop.calls) {
      await opts.beforeProviderCall({ depth: depth++, requestBody: { tools: opts.tools.map((t) => t.name) }, at: new Date() });
      if (round.length === 1 && round[0].name === "__throw") throw new Error("vendor 503");
      opts.onRoundBilled?.([{ costName: "deepseek-x-input", quantity: 50 }]);
      for (const call of round) {
        const r = await opts.executeTool(call);
        if (r === "input_request") return { tokensInput: 100, lastRequestTokensInput: 50, tokensOutput: 20, costLines: [{ costName: "deepseek-x-input", quantity: 100 }], fullResponse: "", toolCalls: [], emittedInputRequest: true };
      }
    }
    return { tokensInput: 100, lastRequestTokensInput: 50, tokensOutput: 20, costLines: [{ costName: "deepseek-x-input", quantity: 100 }], fullResponse: "", toolCalls: [], emittedInputRequest: false };
  }),
}));

import { brandToolsRefusalFor, buildOutputTool, completeWithBrandTools, newBrandToolsSpend, NoOutputError, OUTPUT_TOOL_NAME } from "../../src/lib/complete-brand-tools.js";
import { BRAND_MCP_TOOL_EVENT, BRAND_MCP_UNAVAILABLE_EVENT, loadBrandToolset, type BrandToolset, type SecretStore } from "../../src/lib/brand-mcp.js";
import { McpError } from "../../src/lib/mcp-client.js";
import type { BrandMcpServer } from "../../src/db/schema.js";

function row(over: Partial<BrandMcpServer>): BrandMcpServer {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "org-1",
    brandId: "brand-1",
    name: "Distribute",
    url: "https://mcp.distribute.you/mcp",
    hasAuth: true,
    createdByUserId: "user-1",
    status: "connected",
    error: null,
    toolNames: [],
    checkedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** The two drizzle chains loadBrandToolset uses: select…orderBy (the rows), update…returning (the stored check). */
function fakeDb(rows: BrandMcpServer[]) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: async () => rows }) }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updates.push(v);
            return [{ ...rows[0], ...v }];
          },
        }),
      }),
    }),
  };
  return { db: db as never, updates };
}

const secrets: SecretStore = {
  save: vi.fn(async () => undefined),
  read: vi.fn(async () => "Bearer secret-value"),
  remove: vi.fn(async () => undefined),
};

const scope = { orgId: "org-1", brandId: "brand-1", runId: "run-1", eventIdentity: { orgId: "org-1", userId: "user-1" }, tracking: {} };

describe("a turn's brand tools", () => {
  beforeEach(() => vendorLoop.calls.splice(0));

  it("no server plugged: null (the turn runs exactly as before)", async () => {
    const { db } = fakeDb([]);
    expect(await loadBrandToolset({ db, secrets }, scope)).toBeNull();
  });

  it("lists every server's tools namespaced; a call runs on its server and is ONE run event without the secret", async () => {
    const { db, updates } = fakeDb([row({})]);
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "lead disqualified" }] }));
    const sessionFactory = vi.fn((o: { authorization: string | null }) => {
      expect(o.authorization).toBe("Bearer secret-value");
      return { listTools: async () => [{ name: "distribute_call_api", inputSchema: { type: "object", properties: { path: { type: "string" } } } }], callTool };
    });
    const trace = vi.fn();
    let t = 1000;
    const toolset = (await loadBrandToolset({ db, secrets, sessionFactory, trace, now: () => (t += 250) }, scope))!;
    expect(toolset.tools.map((x) => x.name)).toEqual(["distribute__distribute_call_api"]);
    expect(updates[0]).toMatchObject({ status: "connected", error: null, toolNames: ["distribute_call_api"] });
    const result = await toolset.call("distribute__distribute_call_api", { path: "/v1/leads/x/disqualify" });
    expect(result).toEqual({ ok: true, content: "lead disqualified" });
    expect(callTool).toHaveBeenCalledWith("distribute_call_api", { path: "/v1/leads/x/disqualify" }, expect.any(Number));
    expect(trace).toHaveBeenCalledTimes(1);
    const [runId, event, identity, , opts] = trace.mock.calls[0];
    expect(runId).toBe("run-1");
    expect(event).toBe(BRAND_MCP_TOOL_EVENT);
    expect(identity).toEqual({ orgId: "org-1", userId: "user-1" });
    expect(opts.data).toMatchObject({ serverName: "Distribute", tool: "distribute_call_api", ok: true, durationMs: 250 });
    expect(typeof opts.data.argsChars).toBe("number");
    expect(typeof opts.data.resultChars).toBe("number");
    expect(JSON.stringify(trace.mock.calls)).not.toContain("secret-value");
  });

  it("a server down at turn start: its tools are absent, the turn goes on, an error event says why", async () => {
    const { db, updates } = fakeDb([row({})]);
    const sessionFactory = () => ({ listTools: async () => { throw new McpError("the server could not be reached (ECONNREFUSED)"); }, callTool: async () => ({}) });
    const trace = vi.fn();
    const toolset = (await loadBrandToolset({ db, secrets, sessionFactory, trace }, scope))!;
    expect(toolset.tools).toEqual([]);
    expect(updates[0]).toMatchObject({ status: "error" });
    expect(String(updates[0].error)).toContain("ECONNREFUSED");
    expect(trace.mock.calls[0][1]).toBe(BRAND_MCP_UNAVAILABLE_EVENT);
  });

  it("a call that fails is an error RESULT the model reads (never a thrown turn), logged as a failed event", async () => {
    const { db } = fakeDb([row({ hasAuth: false })]);
    const sessionFactory = () => ({ listTools: async () => [{ name: "slow" }], callTool: async () => { throw new McpError("the server did not answer within 30s"); } });
    const trace = vi.fn();
    const toolset = (await loadBrandToolset({ db, secrets, sessionFactory, trace }, scope))!;
    const result = await toolset.call("distribute__slow", {});
    expect(result).toMatchObject({ ok: false });
    expect(String(result.error)).toContain("did not answer within 30s");
    expect(trace.mock.calls.at(-1)![4].data).toMatchObject({ ok: false, tool: "slow" });
  });
});

describe("/complete with brandTools", () => {
  const toolset: BrandToolset = {
    tools: [{ name: "distribute__get_lead", description: "d", input_schema: { type: "object", properties: {} } }],
    servers: [{ id: "s", name: "Distribute", tools: 1 }],
    has: (n) => n === "distribute__get_lead",
    call: vi.fn(async () => ({ ok: true, content: "Ava runs 2 campaigns" })),
  };
  const base = { provider: "deepseek" as const, apiKey: "k", model: "deepseek-x", costPrefix: "deepseek-x", systemPrompt: "Write.", message: "m", toolset };

  beforeEach(() => vendorLoop.calls.splice(0));

  it("runs the brand tool, then returns the caller's structured output; every round after the first passes the cost hook", async () => {
    vendorLoop.calls.push([{ name: "distribute__get_lead", args: {} }], [{ name: OUTPUT_TOOL_NAME, args: { decision: "write", body: "Hi" } }]);
    const beforeProviderCall = vi.fn(async () => undefined);
    const r = await completeWithBrandTools({ ...base, spend: newBrandToolsSpend(), responseSchema: { type: "object", properties: { decision: { type: "string" }, body: { type: "string" } }, required: ["decision"] }, beforeProviderCall });
    expect(JSON.parse(r.content)).toEqual({ decision: "write", body: "Hi" });
    expect(r.toolCalls).toBe(1);
    expect(beforeProviderCall.mock.calls.map((c) => (c[0] as { depth: number }).depth)).toEqual([0, 1]);
    expect(r.costLines).toEqual([{ costName: "deepseek-x-input", quantity: 100 }]);
  });

  it("the model never returned its output: NoOutputError, the spent round is in the caller's ledger", async () => {
    vendorLoop.calls.push([{ name: "distribute__get_lead", args: {} }]);
    const spend = newBrandToolsSpend();
    const err = await completeWithBrandTools({ ...base, spend, beforeProviderCall: async () => undefined }).catch((e) => e);
    expect(err).toBeInstanceOf(NoOutputError);
    expect(spend.lines).toEqual([{ costName: "deepseek-x-input", quantity: 50 }]);
  });

  it("a provider failure mid-loop: the rounds already spent stay in the ledger (never undeclared)", async () => {
    vendorLoop.calls.push([{ name: "distribute__get_lead", args: {} }], [{ name: "__throw", args: {} }]);
    const spend = newBrandToolsSpend();
    const err = await completeWithBrandTools({ ...base, spend, beforeProviderCall: async () => undefined }).catch((e) => e);
    expect(String(err)).toContain("vendor 503");
    expect(spend.lines).toEqual([{ costName: "deepseek-x-input", quantity: 50 }]);
  });

  it("text mode returns the text; a non-object schema is wrapped and unwrapped", () => {
    const text = buildOutputTool(null);
    expect(text.textMode).toBe(true);
    expect(text.unwrap({ text: "hello" })).toBe("hello");
    const arr = buildOutputTool({ type: "array", items: { type: "string" } });
    expect(arr.tool.input_schema.properties).toEqual({ output: { type: "array", items: { type: "string" } } });
    expect(arr.unwrap({ output: ["a"] })).toEqual(["a"]);
  });

  it("served on every provider; the one named refusal is google + webSearch (Gemini cannot ground and call tools in one request)", () => {
    expect(brandToolsRefusalFor(undefined, "google", { webSearch: true, imageUrl: true })).toBeNull();
    for (const p of ["anthropic", "google", "deepseek", "zai", "moonshot", "openai"]) {
      expect(brandToolsRefusalFor({ brandId: "b" }, p, { webSearch: false, imageUrl: false })).toBeNull();
    }
    expect(brandToolsRefusalFor({ brandId: "b" }, "anthropic", { webSearch: true, imageUrl: true })).toBeNull();
    expect(brandToolsRefusalFor({ brandId: "b" }, "google", { webSearch: false, imageUrl: true })).toBeNull();
    const g = brandToolsRefusalFor({ brandId: "b" }, "google", { webSearch: true, imageUrl: false });
    expect(g).toMatch(/webSearch on provider "google"/);
    expect(g).toMatch(/anthropic/);
  });
});
