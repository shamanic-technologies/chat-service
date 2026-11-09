import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { like } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import {
  BrandMcpInputError,
  createServer,
  deleteServer,
  listServers,
  loadBrandToolset,
  recheckServer,
  serverView,
  type SecretStore,
  type SessionFactory,
} from "../../src/lib/brand-mcp.js";
import { McpError } from "../../src/lib/mcp-client.js";

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;
const RUN = Date.now().toString(36);
const ORG = `org-brandmcp-${RUN}`;
const BRAND = "4c6b1d3e-2f0a-4b8e-9d7c-1a2b3c4d5e6f";

describe("brand MCP servers (stored per org and brand)", { timeout: 30000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const vault = new Map<string, string>();
  const secrets: SecretStore = {
    save: vi.fn(async (_c, brandId, serverId, value) => void vault.set(`${brandId}/${serverId}`, value)),
    read: vi.fn(async (_c, brandId, serverId) => {
      const v = vault.get(`${brandId}/${serverId}`);
      if (!v) throw new Error("404");
      return v;
    }),
    remove: vi.fn(async (_c, brandId, serverId) => void vault.delete(`${brandId}/${serverId}`)),
  };
  let up = true;
  const sessionFactory: SessionFactory = ({ authorization }) => ({
    listTools: async () => {
      if (!up) throw new McpError("the server could not be reached (ECONNREFUSED)");
      if (authorization !== "Bearer good") throw new McpError("the server refused our credentials (HTTP 401): check the Authorization value");
      return [{ name: "distribute_list_leads" }, { name: "distribute_call_api" }];
    },
    callTool: async (name) => ({ content: [{ type: "text", text: `ran ${name}` }] }),
  });
  const caller = { orgId: ORG, userId: "user-1", runId: null };

  beforeAll(() => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    client = postgres(connectionString);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await db.delete(schema.brandMcpServers).where(like(schema.brandMcpServers.orgId, `org-brandmcp-${RUN}%`));
    await client?.end();
  });

  it("plugs a server: secret to the vault, the check stored (connected, tool names), the read never shows the secret", async () => {
    const row = await createServer({ db: db as never, secrets, sessionFactory }, caller, BRAND, { name: "Distribute", url: "https://mcp.distribute.you/mcp", authorization: "Bearer good" });
    expect(row.status).toBe("connected");
    expect(row.toolNames).toEqual(["distribute_list_leads", "distribute_call_api"]);
    expect(vault.get(`${BRAND}/${row.id}`)).toBe("Bearer good");
    const listed = (await listServers(db as never, ORG, BRAND)).map(serverView);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "Distribute", status: "connected", toolCount: 2, hasAuthorization: true, error: null });
    expect(JSON.stringify(listed)).not.toContain("Bearer good");
    // Another org reads nothing of it.
    expect(await listServers(db as never, `${ORG}-other`, BRAND)).toEqual([]);
  });

  it("the same URL twice is a 409; a bad URL a 400; a refused credential is stored as the error in plain words", async () => {
    await expect(createServer({ db: db as never, secrets, sessionFactory }, caller, BRAND, { name: "Again", url: "https://mcp.distribute.you/mcp" })).rejects.toMatchObject({ status: 409 });
    await expect(createServer({ db: db as never, secrets, sessionFactory }, caller, BRAND, { name: "Local", url: "http://localhost:8080" })).rejects.toBeInstanceOf(BrandMcpInputError);
    const bad = await createServer({ db: db as never, secrets, sessionFactory }, caller, BRAND, { name: "CRM", url: "https://crm.example.com/mcp", authorization: "Bearer wrong" });
    expect(bad.status).toBe("error");
    expect(bad.error).toMatch(/refused our credentials/);
    expect(bad.toolNames).toEqual([]);
  });

  it("re-check reads the stored secret and refreshes the check", async () => {
    const [first] = await listServers(db as never, ORG, BRAND);
    up = false;
    const down = await recheckServer({ db: db as never, secrets, sessionFactory }, caller, BRAND, first.id);
    expect(down.status).toBe("error");
    expect(down.error).toContain("ECONNREFUSED");
    up = true;
    const back = await recheckServer({ db: db as never, secrets, sessionFactory }, caller, BRAND, first.id);
    expect(back.status).toBe("connected");
  });

  it("a turn loads only the connected servers' tools, namespaced; the down one is stored as such", async () => {
    const trace = vi.fn();
    const toolset = (await loadBrandToolset({ db: db as never, secrets, sessionFactory, trace }, { orgId: ORG, brandId: BRAND, runId: "r", eventIdentity: { orgId: ORG, userId: "user-1" }, tracking: {} }))!;
    expect(toolset.tools.map((t) => t.name)).toEqual(["distribute__distribute_list_leads", "distribute__distribute_call_api"]);
    expect(await toolset.call("distribute__distribute_call_api", {})).toEqual({ ok: true, content: "ran distribute_call_api" });
  });

  it("unplug removes the row and its secret; an unknown id is a 404", async () => {
    const [first] = await listServers(db as never, ORG, BRAND);
    await deleteServer({ db: db as never, secrets }, caller, BRAND, first.id);
    expect(vault.has(`${BRAND}/${first.id}`)).toBe(false);
    expect((await listServers(db as never, ORG, BRAND)).map((r) => r.id)).not.toContain(first.id);
    await expect(deleteServer({ db: db as never, secrets }, caller, BRAND, first.id)).rejects.toMatchObject({ status: 404 });
  });
});
