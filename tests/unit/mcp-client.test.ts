import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockConnect,
  mockListTools,
  mockCallTool,
  mockClose,
  MockStreamableHTTPClientTransport,
} = vi.hoisted(() => ({
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockListTools: vi.fn().mockResolvedValue({
    tools: [
      {
        name: "test_tool",
        description: "A test tool",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }),
  mockCallTool: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "result" }],
  }),
  mockClose: vi.fn().mockResolvedValue(undefined),
  MockStreamableHTTPClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    close: mockClose,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTPClientTransport,
}));

import { connectMcp } from "../../src/lib/mcp-client.js";

describe("connectMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses StreamableHTTPClientTransport with /mcp endpoint", async () => {
    await connectMcp("test-api-key");

    expect(MockStreamableHTTPClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/mcp",
      }),
      expect.objectContaining({
        requestInit: {
          headers: { "X-API-Key": "test-api-key" },
        },
      })
    );
  });

  it("does not use legacy /sse endpoint", async () => {
    await connectMcp("test-api-key");

    const url = MockStreamableHTTPClientTransport.mock.calls[0][0] as URL;
    expect(url.pathname).not.toBe("/sse");
    expect(url.pathname).toBe("/mcp");
  });

  it("returns tools mapped to FunctionDeclaration format", async () => {
    const conn = await connectMcp("test-api-key");

    expect(conn.tools).toHaveLength(1);
    expect(conn.tools[0]).toEqual({
      name: "test_tool",
      description: "A test tool",
      parameters: { type: "object", properties: {} },
    });
  });

  it("callTool delegates to MCP client", async () => {
    const conn = await connectMcp("test-api-key");
    const result = await conn.callTool("test_tool", { arg: "value" });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: "test_tool",
      arguments: { arg: "value" },
    });
    expect(result).toEqual([{ type: "text", text: "result" }]);
  });

  it("close delegates to MCP client", async () => {
    const conn = await connectMcp("test-api-key");
    await conn.close();

    expect(mockClose).toHaveBeenCalled();
  });
});
