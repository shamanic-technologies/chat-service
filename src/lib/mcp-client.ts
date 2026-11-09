// ---------------------------------------------------------------------------
// A minimal MCP client over Streamable HTTP (BRAND-MCP-1109).
//
// A brand plugs its own MCP server(s) for our conversation AI. This client
// speaks the protocol's HTTP transport (spec 2025-06-18, "Streamable HTTP"):
// JSON-RPC 2.0 POSTed to ONE endpoint, answered either as `application/json`
// or as a `text/event-stream` carrying the response; the server may hand a
// session id (`Mcp-Session-Id`) on `initialize`, sent back on every later
// request. Only what our AI needs: initialize, tools/list, tools/call.
//
// No SDK on purpose: three methods, one transport, no new dependency on a
// service that boots on a 2 GB box.
// ---------------------------------------------------------------------------

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "distribute-chat-service", version: "1.0.0" };

/** A tool as the server lists it. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** What a tools/call answers (content blocks, an error flag, optional structured output). */
export interface McpCallResult {
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
  structuredContent?: unknown;
}

/** A failure talking to the server, in plain words (shown to the brand and to the model). */
export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

export interface McpConnectOptions {
  url: string;
  /** The exact `Authorization` header value the brand pasted (never logged). */
  authorization?: string | null;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Reads the JSON-RPC response with `id` out of an SSE body, stopping at the first match. */
async function readSseResponse(res: Response, id: number): Promise<JsonRpcResponse> {
  if (!res.body) throw new McpError("the server answered an empty event stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : (frames.pop() ?? "");
      for (const frame of done ? frames.filter(Boolean) : frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data.trim()) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(data);
        } catch {
          continue;
        }
        for (const m of Array.isArray(msg) ? msg : [msg]) {
          const r = m as JsonRpcResponse;
          if (r && r.id === id && ("result" in r || "error" in r)) return r;
        }
      }
      if (done) break;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  throw new McpError("the server closed its event stream without answering");
}

/** One MCP session with one server (initialize once, then list / call). */
export class McpSession {
  private sessionId: string | null = null;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private nextId = 1;
  private initialized = false;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: McpConnectOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.initialized ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...(this.opts.authorization ? { Authorization: this.opts.authorization } : {}),
    };
  }

  private async post(body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    try {
      return await this.fetchImpl(this.opts.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new McpError(`the server did not answer within ${Math.round(timeoutMs / 1000)}s`);
      const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
      throw new McpError(`the server could not be reached (${cause})`);
    }
  }

  private async request(method: string, params: Record<string, unknown> | undefined, timeoutMs = this.timeoutMs): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, timeoutMs);
    if (res.status === 401 || res.status === 403) {
      throw new McpError(`the server refused our credentials (HTTP ${res.status}): check the Authorization value`);
    }
    if (res.status === 404 && this.sessionId) throw new McpSessionExpired();
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new McpError(`the server answered HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    if (method === "initialize") {
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
    }
    const type = res.headers.get("content-type") ?? "";
    let msg: JsonRpcResponse;
    if (type.includes("text/event-stream")) {
      msg = await readSseResponse(res, id);
    } else {
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new McpError(`the server did not answer JSON (${type || "no content type"})`);
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const hit = list.find((m) => (m as JsonRpcResponse)?.id === id) as JsonRpcResponse | undefined;
      if (!hit) throw new McpError("the server answered without a response to our request");
      msg = hit;
    }
    if (msg.error) throw new McpError(`the server answered an error: ${msg.error.message ?? JSON.stringify(msg.error).slice(0, 200)}`);
    return msg.result;
  }

  private async notify(method: string, timeoutMs = this.timeoutMs): Promise<void> {
    const res = await this.post({ jsonrpc: "2.0", method }, timeoutMs);
    // 202 Accepted is the spec's answer; anything 2xx is fine, the body is unused.
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) throw new McpError(`the server refused the ${method} notification (HTTP ${res.status})`);
  }

  /** The handshake. Idempotent. */
  async connect(timeoutMs = this.timeoutMs): Promise<void> {
    if (this.initialized) return;
    this.sessionId = null;
    const result = (await this.request(
      "initialize",
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      timeoutMs,
    )) as { protocolVersion?: unknown } | undefined;
    if (typeof result?.protocolVersion === "string") this.protocolVersion = result.protocolVersion;
    this.initialized = true;
    await this.notify("notifications/initialized", timeoutMs);
  }

  /** Runs `fn` on a connected session; a session the server forgot is re-opened once. */
  private async withSession<T>(fn: () => Promise<T>, timeoutMs = this.timeoutMs): Promise<T> {
    await this.connect(timeoutMs);
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof McpSessionExpired)) throw err;
      this.initialized = false;
      await this.connect(timeoutMs);
      return fn();
    }
  }

  /** Every tool the server lists (follows `nextCursor`, at most 20 pages). */
  async listTools(timeoutMs = this.timeoutMs): Promise<McpTool[]> {
    return this.withSession(async () => {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = (await this.request("tools/list", cursor ? { cursor } : undefined, timeoutMs)) as { tools?: unknown; nextCursor?: unknown } | undefined;
        for (const t of Array.isArray(result?.tools) ? result.tools : []) {
          const tool = t as McpTool;
          if (tool && typeof tool.name === "string" && tool.name) tools.push(tool);
        }
        if (typeof result?.nextCursor !== "string" || !result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return tools;
    }, timeoutMs);
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpCallResult> {
    return this.withSession(async () => (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as McpCallResult, timeoutMs);
  }
}

/** The server answered 404 to a request carrying a session id: the spec says start a new session. */
class McpSessionExpired extends McpError {
  constructor() {
    super("the server forgot our session");
  }
}
