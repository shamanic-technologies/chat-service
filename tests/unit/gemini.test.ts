import { describe, it, expect, vi } from "vitest";

const mockGetGenerativeModel = vi.fn().mockReturnValue({
  startChat: () => ({
    sendMessageStream: async () => ({
      stream: (async function* () {})(),
    }),
  }),
});

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: mockGetGenerativeModel,
  })),
  FunctionCallingMode: { AUTO: "AUTO" },
  SchemaType: { OBJECT: "OBJECT", STRING: "STRING" },
}));

import { createGeminiClient, REQUEST_USER_INPUT_TOOL } from "../../src/lib/gemini.js";

describe("createGeminiClient", () => {
  it("defaults to gemini-3-flash-preview model", async () => {
    const client = createGeminiClient({ apiKey: "test-key" });
    const gen = client.streamChat([], "hello");
    // consume the generator to trigger getGenerativeModel
    for await (const _ of gen) {
      /* drain */
    }

    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-3-flash-preview" })
    );
  });

  it("allows overriding the model", async () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      model: "gemini-3-pro-preview",
    });
    const gen = client.streamChat([], "hello");
    for await (const _ of gen) {
      /* drain */
    }

    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-3-pro-preview" })
    );
  });
});

describe("REQUEST_USER_INPUT_TOOL", () => {
  it("has correct name and required parameters", () => {
    expect(REQUEST_USER_INPUT_TOOL.name).toBe("request_user_input");
    expect(REQUEST_USER_INPUT_TOOL.parameters).toBeDefined();

    const params = REQUEST_USER_INPUT_TOOL.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, unknown>;
    expect(props).toHaveProperty("input_type");
    expect(props).toHaveProperty("label");
    expect(props).toHaveProperty("field");
    expect(props).toHaveProperty("placeholder");
    expect(params.required).toEqual(["input_type", "label", "field"]);
  });
});
