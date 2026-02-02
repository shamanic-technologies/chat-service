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
}));

import { createGeminiClient } from "../../src/lib/gemini.js";

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
