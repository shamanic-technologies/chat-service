import { describe, it, expect } from "vitest";
import { toGeminiFunctionDeclarations, type ToolDefinition } from "../../src/lib/gemini-chat.js";

describe("toGeminiFunctionDeclarations", () => {
  it("converts Anthropic-style tool definitions to Gemini format", () => {
    const tools: ToolDefinition[] = [
      {
        name: "get_weather",
        description: "Get the weather for a city",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
            units: { type: "string", enum: ["celsius", "fahrenheit"] },
          },
          required: ["city"],
        },
      },
    ];

    const result = toGeminiFunctionDeclarations(tools);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("get_weather");
    expect(result[0].description).toBe("Get the weather for a city");
    expect(result[0].parameters.type).toBe("object");
    expect(result[0].parameters.properties).toEqual({
      city: { type: "string", description: "City name" },
      units: { type: "string", enum: ["celsius", "fahrenheit"] },
    });
    expect(result[0].parameters.required).toEqual(["city"]);
  });

  it("omits required when empty", () => {
    const tools: ToolDefinition[] = [
      {
        name: "list_items",
        description: "List all items",
        input_schema: {
          type: "object",
          properties: {},
        },
      },
    ];

    const result = toGeminiFunctionDeclarations(tools);
    expect(result[0].parameters.required).toBeUndefined();
  });

  it("converts multiple tools", () => {
    const tools: ToolDefinition[] = [
      {
        name: "tool_a",
        description: "Tool A",
        input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
      },
      {
        name: "tool_b",
        description: "Tool B",
        input_schema: { type: "object", properties: { y: { type: "number" } } },
      },
    ];

    const result = toGeminiFunctionDeclarations(tools);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("tool_a");
    expect(result[1].name).toBe("tool_b");
  });

  it("handles empty tools array", () => {
    expect(toGeminiFunctionDeclarations([])).toEqual([]);
  });
});
