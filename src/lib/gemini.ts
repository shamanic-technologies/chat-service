import {
  GoogleGenerativeAI,
  type Content,
  type FunctionDeclaration,
  type GenerateContentStreamResult,
  FunctionCallingMode,
  type FunctionCall,
} from "@google/generative-ai";

const SYSTEM_PROMPT = `You are Foxy, the MCP Factory AI assistant. You help users set up and use MCP Factory's tools for sales outreach.

Key behaviors:
- Be friendly, concise, and helpful
- Ask ONE question at a time to guide users
- When you can help with a task using tools, do so proactively
- Offer quick-reply button options when there are clear choices. Format them as a list at the END of your response using exactly this syntax: - [Button Text]
- If the user needs to set up BYOK keys, guide them to /setup

Available tools let you search for leads, create campaigns, and manage outreach on behalf of the user.

You have access to mcpfactory_suggest_icp which analyzes a brand's website to suggest who they should target with cold emails. Call this tool when the user wants to create a campaign but hasn't specified their target audience (job titles, industries, or locations). Present the suggestions to the user for confirmation before creating the campaign. The returned person_titles, q_organization_keyword_tags, and organization_locations map directly to target_titles, target_industries, and target_locations in mcpfactory_create_campaign.`;

export interface GeminiOptions {
  apiKey: string;
  model?: string;
}

export function createGeminiClient({ apiKey, model = "gemini-2.0-flash" }: GeminiOptions) {
  const genAI = new GoogleGenerativeAI(apiKey);

  return {
    async *streamChat(
      history: Content[],
      userMessage: string,
      tools?: FunctionDeclaration[]
    ): AsyncGenerator<
      | { type: "token"; content: string }
      | { type: "function_call"; call: FunctionCall }
      | { type: "done" }
    > {
      const generativeModel = genAI.getGenerativeModel({
        model,
        systemInstruction: SYSTEM_PROMPT,
        tools: tools?.length
          ? [{ functionDeclarations: tools }]
          : undefined,
        toolConfig: tools?.length
          ? { functionCallingConfig: { mode: FunctionCallingMode.AUTO } }
          : undefined,
      });

      const chat = generativeModel.startChat({ history });

      const result: GenerateContentStreamResult = await chat.sendMessageStream(
        userMessage
      );

      for await (const chunk of result.stream) {
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        for (const part of candidate.content.parts) {
          if (part.text) {
            yield { type: "token", content: part.text };
          }
          if (part.functionCall) {
            yield { type: "function_call", call: part.functionCall };
          }
        }
      }

      yield { type: "done" };
    },

    async sendFunctionResult(
      history: Content[],
      functionName: string,
      result: unknown,
      tools?: FunctionDeclaration[]
    ): Promise<GenerateContentStreamResult> {
      const generativeModel = genAI.getGenerativeModel({
        model,
        systemInstruction: SYSTEM_PROMPT,
        tools: tools?.length
          ? [{ functionDeclarations: tools }]
          : undefined,
      });

      const chat = generativeModel.startChat({ history });

      return chat.sendMessageStream([
        {
          functionResponse: {
            name: functionName,
            response: { result },
          },
        },
      ]);
    },
  };
}
