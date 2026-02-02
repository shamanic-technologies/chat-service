import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Type, type FunctionDeclaration } from "@google/genai";

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "https://mcp.mcpfactory.org";

export interface McpConnection {
  client: Client;
  tools: FunctionDeclaration[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

export async function connectMcp(apiKey: string): Promise<McpConnection> {
  const transport = new SSEClientTransport(new URL(`${MCP_SERVER_URL}/sse`), {
    requestInit: {
      headers: { "X-API-Key": apiKey },
    },
  });

  const client = new Client({ name: "foxy-chat", version: "1.0.0" });
  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();

  const tools: FunctionDeclaration[] = mcpTools.map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    parameters: tool.inputSchema as unknown as FunctionDeclaration["parameters"],
  }));

  const callTool = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> => {
    const result = await client.callTool({ name, arguments: args });
    return result.content;
  };

  const close = async () => {
    await client.close();
  };

  return { client, tools, callTool, close };
}
