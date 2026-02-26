import {
  GoogleGenAI,
  Type,
  FunctionCallingConfigMode,
  ThinkingLevel,
  type FunctionDeclaration,
  type Content,
  type Part,
} from "@google/genai";

export const REQUEST_USER_INPUT_TOOL: FunctionDeclaration = {
  name: "request_user_input",
  description:
    "Ask the user for structured input via a frontend widget. Use this instead of asking in plain text when you need a specific data type like a URL, email, or text field.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      input_type: {
        type: Type.STRING,
        description: "The type of input widget to render: url, text, or email",
      },
      label: {
        type: Type.STRING,
        description: "The label/question shown above the input field",
      },
      placeholder: {
        type: Type.STRING,
        description: "Placeholder text inside the input field",
      },
      field: {
        type: Type.STRING,
        description:
          "A key identifying what this input is for, e.g. brand_url",
      },
    },
    required: ["input_type", "label", "field"],
  },
};

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  systemPrompt: string;
}

export interface UsageMetadata {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type GeminiEvent =
  | { type: "token"; content: string }
  | { type: "function_call"; call: FunctionCall }
  | { type: "done"; usage?: UsageMetadata };

export function buildSystemPrompt(
  basePrompt: string,
  context?: Record<string, unknown>,
): string {
  if (!context || Object.keys(context).length === 0) return basePrompt;
  return `${basePrompt}\n\n---\n## Additional Context (this request only)\n${JSON.stringify(context, null, 2)}`;
}

export function createGeminiClient({
  apiKey,
  model = "gemini-3-flash-preview",
  systemPrompt,
}: GeminiOptions) {
  const ai = new GoogleGenAI({ apiKey });

  return {
    model,

    async *streamChat(
      history: Content[],
      userMessage: string,
      tools?: FunctionDeclaration[],
    ): AsyncGenerator<GeminiEvent> {
      const response = await ai.models.generateContentStream({
        model,
        contents: [
          ...history,
          { role: "user", parts: [{ text: userMessage }] },
        ],
        config: {
          systemInstruction: systemPrompt,
          tools: tools?.length
            ? [{ functionDeclarations: tools }]
            : undefined,
          toolConfig: tools?.length
            ? {
                functionCallingConfig: {
                  mode: FunctionCallingConfigMode.AUTO,
                },
              }
            : undefined,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
          },
        },
      });

      let usage: UsageMetadata | undefined;
      for await (const chunk of response) {
        if (chunk.usageMetadata) {
          usage = {
            promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
          };
        }
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        for (const part of candidate.content?.parts ?? []) {
          if (part.thought) continue;
          if (part.text) {
            yield { type: "token", content: part.text };
          }
          if (part.functionCall) {
            yield {
              type: "function_call",
              call: {
                name: part.functionCall.name!,
                args:
                  (part.functionCall.args as Record<string, unknown>) ?? {},
                ...(part.thoughtSignature
                  ? { thoughtSignature: part.thoughtSignature }
                  : {}),
              },
            };
          }
        }
      }

      yield { type: "done", usage };
    },

    async *sendFunctionResult(
      history: Content[],
      functionName: string,
      result: unknown,
      tools?: FunctionDeclaration[],
    ): AsyncGenerator<GeminiEvent> {
      const response = await ai.models.generateContentStream({
        model,
        contents: [
          ...history,
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: functionName,
                  response: { result },
                },
              } as Part,
            ],
          },
        ],
        config: {
          systemInstruction: systemPrompt,
          tools: tools?.length
            ? [{ functionDeclarations: tools }]
            : undefined,
          toolConfig: tools?.length
            ? {
                functionCallingConfig: {
                  mode: FunctionCallingConfigMode.AUTO,
                },
              }
            : undefined,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
          },
        },
      });

      let usage: UsageMetadata | undefined;
      for await (const chunk of response) {
        if (chunk.usageMetadata) {
          usage = {
            promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
          };
        }
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        for (const part of candidate.content?.parts ?? []) {
          if (part.thought) continue;
          if (part.text) {
            yield { type: "token", content: part.text };
          }
          if (part.functionCall) {
            yield {
              type: "function_call",
              call: {
                name: part.functionCall.name!,
                args:
                  (part.functionCall.args as Record<string, unknown>) ?? {},
                ...(part.thoughtSignature
                  ? { thoughtSignature: part.thoughtSignature }
                  : {}),
              },
            };
          }
        }
      }

      yield { type: "done", usage };
    },
  };
}
