import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type, type FunctionDeclaration } from "@google/genai";

export interface McpConfig {
  serverUrl: string;
  bearerToken: string;
}

export interface McpConnection {
  client: Client;
  tools: FunctionDeclaration[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

export async function connectMcp(config: McpConfig): Promise<McpConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(`${config.serverUrl}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${config.bearerToken}` },
    },
  });

  const client = new Client({ name: "chat-service", version: "1.0.0" });
  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();

  const tools: FunctionDeclaration[] = mcpTools.map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    parameters: tool.inputSchema as unknown as FunctionDeclaration["parameters"],
  }));

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const result = await client.callTool({ name, arguments: args });
    return result.content;
  };

  const close = async () => {
    await client.close();
  };

  return { client, tools, callTool, close };
}
