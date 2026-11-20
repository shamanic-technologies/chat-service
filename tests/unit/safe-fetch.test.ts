import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PUBLIC_ONLY_MESSAGE,
  PublicUrlRefusedError,
  checkPublicUrl,
  isPublicAddress,
  nodeTransport,
  publicFetch,
  type Resolver,
  type Transport,
} from "../../src/lib/safe-fetch.js";
import { McpError, McpSession } from "../../src/lib/mcp-client.js";
import { checkServer, mcpUrlNotPublic } from "../../src/lib/brand-mcp.js";

// SEC-MCP-SSRF-1120 (prod 2026-11-20): a customer-supplied URL reaches the
// public internet only, on every hop.

/** DNS as the attacker's names answer it: nip.io / sslip.io embed their IP, public names get a public IP. */
const fakeDns: Resolver = async (host) => {
  const embedded = host.match(/^(\d+\.\d+\.\d+\.\d+)\.(nip\.io|sslip\.io)$/);
  if (embedded) return [{ address: embedded[1], family: 4 }];
  if (host === "rebind.example.com") return [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }];
  if (host === "v6private.example.com") return [{ address: "fd00::1", family: 6 }];
  if (host === "internal-docker.example.com") return [{ address: "172.18.0.7", family: 4 }];
  return [{ address: "104.18.1.1", family: 4 }];
};

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.17.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fd00::1",
    "fc12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::10.0.0.1",
    "2002:7f00:1::",
    "2002:ac11:1::1",
    "2001:db8::1",
    "2001:0:4136:e378::1",
    "fe80::1%eth0",
    "not-an-ip",
  ])("refuses %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(["8.8.8.8", "104.18.1.1", "62.83.93.230", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"])("allows %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

describe("checkPublicUrl: the attacker's direct targets are refused before any connection", () => {
  it.each([
    "http://mcp-service:8080/mcp",
    "http://brand-service:8080/health",
    "http://chat-service:8080/",
    "http://stripe-service:8080/",
    "http://runs-service:8080/",
    "http://google-service:8080/",
    "http://costs-service:8080/",
    "http://key-service:8080/",
    "http://localhost:2019/config/",
    "https://127.0.0.1.nip.io:2019/",
    "https://172.17.0.1.nip.io/",
    "http://172.17.0.1.nip.io:80/",
    "https://10.0.0.1.sslip.io/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f000001/",
    "http://127.1/",
    "http://[::1]:8080/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/",
    "http://printer.local/",
    "https://rebind.example.com/",
    "https://v6private.example.com/",
    "https://internal-docker.example.com/",
    "file:///etc/passwd",
    "gopher://example.com/",
  ])("refuses %s", async (url) => {
    await expect(checkPublicUrl(url, { resolve: fakeDns })).rejects.toBeInstanceOf(PublicUrlRefusedError);
  });

  it("allows a public name and pins its resolved address", async () => {
    const hop = await checkPublicUrl("https://mcp.distribute.you/mcp", { resolve: fakeDns });
    expect(hop.address).toBe("104.18.1.1");
    expect(hop.url.hostname).toBe("mcp.distribute.you");
  });

  it("refuses a protocol the call site did not allow", async () => {
    await expect(checkPublicUrl("http://mcp.distribute.you/mcp", { protocols: ["https:"], resolve: fakeDns })).rejects.toBeInstanceOf(PublicUrlRefusedError);
  });
});

/** A public redirector that sends every request to `target` (tinyurl, httpbin redirect-to...). */
function redirector(target: string, status = 302): { transport: Transport; hosts: string[] } {
  const hosts: string[] = [];
  const transport: Transport = async (hop) => {
    hosts.push(hop.url.hostname);
    if (hop.url.hostname === "tinyurl.com" || hop.url.hostname.startsWith("httpb")) return new Response(null, { status, headers: { location: target } });
    // Reaching here for an internal host is the bug.
    return new Response("Cannot POST /health", { status: 404 });
  };
  return { transport, hosts };
}

describe("publicFetch: every redirect hop is checked", () => {
  it.each([
    ["https://tinyurl.com/25vzdf63", "http://mcp-service:8080/mcp"],
    ["https://tinyurl.com/x1", "http://brand-service:8080/health"],
    ["https://tinyurl.com/x2", "http://chat-service:8080/health"],
    ["https://tinyurl.com/x3", "http://stripe-service:8080/health"],
    ["https://tinyurl.com/x4", "http://runs-service:8080/health"],
    ["https://tinyurl.com/x5", "http://google-service:8080/health"],
    ["https://tinyurl.com/x6", "http://costs-service:8080/health"],
    ["https://tinyurl.com/x7", "http://key-service:8080/health"],
    ["https://httpbin.org/redirect-to?url=http://127.0.0.1.nip.io:2019/config/", "http://127.0.0.1.nip.io:2019/config/"],
    ["https://httpbingo.org/redirect-to?url=http://172.17.0.1.nip.io/", "http://172.17.0.1.nip.io/"],
    ["https://httpbun.com/redirect-to?url=http://169.254.169.254/", "http://169.254.169.254/latest/meta-data/"],
    ["https://tinyurl.com/x8", "http://[::1]:8080/"],
    ["https://tinyurl.com/x9", "http://2130706433:8080/"],
  ])("%s -> %s is refused before the internal hop", async (start, target) => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { transport, hosts } = redirector(target, status);
      await expect(publicFetch(start, { method: "POST", body: "{}", transport, resolve: fakeDns })).rejects.toBeInstanceOf(PublicUrlRefusedError);
      expect(hosts).toHaveLength(1);
    }
  });

  it("follows a public redirect, keeps POST + body on 307, drops Authorization across origins", async () => {
    const seen: Array<{ host: string; method: string; body: string | null; auth?: string }> = [];
    const transport: Transport = async (hop, req) => {
      seen.push({ host: hop.url.hostname, method: req.method, body: req.body?.toString() ?? null, auth: req.headers.Authorization });
      if (hop.url.hostname === "a.example.com") return new Response(null, { status: 307, headers: { location: "https://b.example.com/mcp" } });
      return new Response("ok", { status: 200 });
    };
    const res = await publicFetch("https://a.example.com/mcp", { method: "POST", body: "{\"x\":1}", headers: { Authorization: "Bearer k" }, transport, resolve: fakeDns });
    expect(await res.text()).toBe("ok");
    expect(seen).toEqual([
      { host: "a.example.com", method: "POST", body: "{\"x\":1}", auth: "Bearer k" },
      { host: "b.example.com", method: "POST", body: "{\"x\":1}", auth: undefined },
    ]);
  });

  it("stops after too many redirects", async () => {
    const transport: Transport = async (hop) => new Response(null, { status: 302, headers: { location: `${hop.url.href}x` } });
    await expect(publicFetch("https://loop.example.com/", { transport, resolve: fakeDns })).rejects.toThrow(/too many redirects/);
  });
});

describe("nodeTransport: real sockets", () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`secret ${req.method} ${req.headers.host}`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("never connects to a loopback URL (real DNS-free check)", async () => {
    await expect(publicFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(PublicUrlRefusedError);
    await expect(publicFetch(`http://localhost:${port}/`)).rejects.toBeInstanceOf(PublicUrlRefusedError);
  });

  it("connects to the PINNED address, never re-resolving the name (DNS rebinding)", async () => {
    // The name does not exist: only the pinned address can have answered.
    const res = await nodeTransport(
      { url: new URL(`http://rebinding-test.invalid:${port}/x`), address: "127.0.0.1", family: 4 },
      { method: "GET", headers: {}, body: null },
    );
    expect(await res.text()).toBe(`secret GET rebinding-test.invalid:${port}`);
  });

  it("a public hop whose redirect points at loopback is refused (real transport, pinned first hop)", async () => {
    // First hop "resolves" to the local server (as a public name would to its host); its redirect to 127.0.0.1 is refused.
    const transport: Transport = (hop, req) => nodeTransport({ ...hop, address: "127.0.0.1" }, req);
    await expect(publicFetch(`http://public.example.com:${port}/redirect`, { transport, resolve: fakeDns })).rejects.toBeInstanceOf(PublicUrlRefusedError);
  });

  it("honours an abort with the signal's own reason", async () => {
    const signal = AbortSignal.abort(new DOMException("t", "TimeoutError"));
    await expect(
      nodeTransport({ url: new URL(`http://x.invalid:${port}/`), address: "127.0.0.1", family: 4 }, { method: "GET", headers: {}, body: null, signal }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("brand MCP check: a refused hop stores a generic error, never the remote's answer", () => {
  const mcpOverRedirector = (target: string) =>
    new McpSession({
      url: "https://tinyurl.com/25vzdf63",
      fetchImpl: (url, init) => publicFetch(url, { ...init, protocols: ["https:"], transport: redirector(target).transport, resolve: fakeDns }),
    });

  it.each(["http://mcp-service:8080/mcp", "http://brand-service:8080/health", "http://127.0.0.1.nip.io:2019/"])("tinyurl -> %s", async (target) => {
    const check = await checkServer("https://tinyurl.com/25vzdf63", null, () => mcpOverRedirector(target));
    expect(check.status).toBe("error");
    expect(check.tools).toEqual([]);
    expect(check.error).toBe(`Could not connect: ${PUBLIC_ONLY_MESSAGE}.`);
    expect(check.error).not.toMatch(/Cannot POST|mcp-service|brand-service|127\.0\.0\.1/);
  });

  it("an HTTP error from a public server is stored as its status only, never its body", async () => {
    const session = new McpSession({
      url: "https://mcp.example.com/mcp",
      fetchImpl: async () => new Response('{"error":"Missing required header x-org-id"}', { status: 400 }),
    });
    const err = await session.listTools().catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toBe("the server answered HTTP 400");
  });

  it("a normal public MCP (https://mcp.distribute.you/mcp) still connects through the guard", async () => {
    const transport: Transport = async (hop, req) => {
      expect(hop.url.href).toBe("https://mcp.distribute.you/mcp");
      expect(hop.address).toBe("104.18.1.1");
      const body = JSON.parse(req.body!.toString()) as { id?: number; method: string };
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "list_brands" }] } });
    };
    const factory = () =>
      new McpSession({ url: "https://mcp.distribute.you/mcp", fetchImpl: (url, init) => publicFetch(url, { ...init, protocols: ["https:"], transport, resolve: fakeDns }) });
    const check = await checkServer("https://mcp.distribute.you/mcp", "Bearer k", factory);
    expect(check).toMatchObject({ status: "connected", error: null });
    expect(check.tools.map((t) => t.name)).toEqual(["list_brands"]);
  });

  it("create refuses a name that resolves inside before storing anything", async () => {
    expect(await mcpUrlNotPublic("https://127.0.0.1.nip.io/mcp", fakeDns)).toBe("The server must be reachable on the public internet.");
    expect(await mcpUrlNotPublic("https://mcp.distribute.you/mcp", fakeDns)).toBeNull();
    // A name that does not resolve yet is left to the connect check.
    expect(await mcpUrlNotPublic("https://nope.example.com/mcp", async () => Promise.reject(new Error("ENOTFOUND")))).toBeNull();
  });

  it("the default MCP session goes through the guard (no fetchImpl = publicFetch)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const err = await new McpSession({ url: "https://127.0.0.1.nip.io:2019/mcp", timeoutMs: 5_000 }).listTools().catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    // Either refused on the resolved private address, or nip.io unreachable from CI DNS: never the global fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
