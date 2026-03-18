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
    "Ask the user for structured input via a frontend widget. ONLY use this when you genuinely need information that you do not already have — check your context and conversation history first. NEVER use this for confirmations, yes/no questions, or to echo back values the user already provided. If the user confirms an action (e.g. says 'yes' or 'go ahead'), execute the action directly using the appropriate tool instead of sending another form.",
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
      value: {
        type: Type.STRING,
        description:
          "Optional pre-filled value for the input field. When you already have a suggested value (e.g. a description you generated), set this so the user only has to confirm. Omit to leave the field empty.",
      },
    },
    required: ["input_type", "label", "field"],
  },
};

export const UPDATE_WORKFLOW_TOOL: FunctionDeclaration = {
  name: "update_workflow",
  description:
    "Update a workflow's metadata (name, description, tags). Use this to directly modify a workflow when the user asks — do not use input_request to confirm values you already know.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      workflowId: {
        type: Type.STRING,
        description:
          "UUID of the workflow to update. If available in context, use it directly — do NOT ask the user for it.",
      },
      name: {
        type: Type.STRING,
        description: "New workflow name (optional)",
      },
      description: {
        type: Type.STRING,
        description: "New workflow description (optional)",
      },
      tags: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "New tags for the workflow (optional)",
      },
    },
    required: ["workflowId"],
  },
};

export const VALIDATE_WORKFLOW_TOOL: FunctionDeclaration = {
  name: "validate_workflow",
  description:
    "Validate a workflow's DAG structure. Returns whether the workflow is valid and any errors found. Use this when the user asks to check or validate a workflow.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      workflowId: {
        type: Type.STRING,
        description:
          "UUID of the workflow to validate. If available in context, use it directly — do NOT ask the user for it.",
      },
    },
    required: ["workflowId"],
  },
};

export const BUILTIN_TOOLS: FunctionDeclaration[] = [
  REQUEST_USER_INPUT_TOOL,
  UPDATE_WORKFLOW_TOOL,
  VALIDATE_WORKFLOW_TOOL,
];

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
  | { type: "thinking_start" }
  | { type: "thinking_delta"; thinking: string }
  | { type: "thinking_stop" }
  | { type: "function_call"; call: FunctionCall }
  | { type: "done"; usage?: UsageMetadata };

export function buildSystemPrompt(
  basePrompt: string,
  context?: Record<string, unknown>,
): string {
  if (!context || Object.keys(context).length === 0) return basePrompt;

  const contextKeys = Object.keys(context);
  const contextInstructions = [
    `\n\n---\n## Additional Context (this request only)`,
    JSON.stringify(context, null, 2),
    `\n## IMPORTANT: Context Usage Rules`,
    `The values above (${contextKeys.join(", ")}) are already known — use them directly when calling tools.`,
    `Do NOT call request_user_input to ask for any value that is already present in this context.`,
    `For example, if workflowId is in context and you need to update or validate the workflow, pass it directly to the tool.`,
    `Only use request_user_input when you genuinely need information that is NOT available in context or conversation history.`,
  ].join("\n");

  return `${basePrompt}${contextInstructions}`;
}

export function createGeminiClient({
  apiKey,
  model = "gemini-3.1-pro-preview",
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
      let inThinking = false;
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
          if (part.thought) {
            if (!inThinking) {
              inThinking = true;
              yield { type: "thinking_start" } as const;
            }
            if (part.text) {
              yield { type: "thinking_delta", thinking: part.text } as const;
            }
            continue;
          }
          if (inThinking) {
            inThinking = false;
            yield { type: "thinking_stop" } as const;
          }
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
      if (inThinking) {
        yield { type: "thinking_stop" } as const;
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
      let inThinking = false;
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
          if (part.thought) {
            if (!inThinking) {
              inThinking = true;
              yield { type: "thinking_start" } as const;
            }
            if (part.text) {
              yield { type: "thinking_delta", thinking: part.text } as const;
            }
            continue;
          }
          if (inThinking) {
            inThinking = false;
            yield { type: "thinking_stop" } as const;
          }
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
      if (inThinking) {
        yield { type: "thinking_stop" } as const;
      }

      yield { type: "done", usage };
    },
  };
}
