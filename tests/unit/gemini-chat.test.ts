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

  // Regression: Gemini's function-declaration `parameters` is the restricted
  // OpenAPI-3.0 Schema type and 400s on `additionalProperties` (and `$ref`,
  // `$schema`, etc.) carried by MCP tool input schemas. They must be stripped
  // recursively before sending. Reproduces the prod error:
  // `Unknown name "additionalProperties" at
  //  'tools[0].function_declarations[1].parameters.properties[0].value'`.
  it("strips additionalProperties nested in a property value", () => {
    const tools: ToolDefinition[] = [
      {
        name: "search_endpoints",
        description: "Search endpoints",
        input_schema: {
          type: "object",
          properties: {
            filters: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["filters"],
        },
      },
    ];

    const result = toGeminiFunctionDeclarations(tools);
    const filters = result[0].parameters.properties.filters as Record<string, unknown>;

    expect(filters).not.toHaveProperty("additionalProperties");
    expect(filters.type).toBe("object");
    // Whole declaration must be free of the rejected keyword.
    expect(JSON.stringify(result)).not.toContain("additionalProperties");
    // required is preserved.
    expect(result[0].parameters.required).toEqual(["filters"]);
  });

  it("strips $ref / $schema recursively from tool param schemas", () => {
    const tools: ToolDefinition[] = [
      {
        name: "call_api",
        description: "Call an API",
        input_schema: {
          type: "object",
          properties: {
            body: { $ref: "#/components/schemas/OrgId", type: "object" },
          },
        },
        // @ts-expect-error — JSON-Schema 7 keyword not on the typed shape but present at runtime
        $schema: "http://json-schema.org/draft-07/schema#",
      } as ToolDefinition,
    ];

    const result = toGeminiFunctionDeclarations(tools);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("$ref");
    expect(serialized).not.toContain("$schema");
    const body = result[0].parameters.properties.body as Record<string, unknown>;
    expect(body.type).toBe("object");
  });

  it("preserves Gemini-supported keys (enum, description, nullable, items)", () => {
    const tools: ToolDefinition[] = [
      {
        name: "filter_list",
        description: "Filter a list",
        input_schema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["open", "closed"], description: "Status" },
            tags: { type: "array", items: { type: "string" } },
            note: { type: "string", nullable: true },
          },
          required: ["status"],
        },
      },
    ];

    const result = toGeminiFunctionDeclarations(tools);
    expect(result[0].parameters.properties).toEqual({
      status: { type: "string", enum: ["open", "closed"], description: "Status" },
      tags: { type: "array", items: { type: "string" } },
      note: { type: "string", nullable: true },
    });
    expect(result[0].parameters.required).toEqual(["status"]);
  });
});
