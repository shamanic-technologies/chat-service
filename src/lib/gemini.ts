import {
  GoogleGenAI,
  Type,
  FunctionCallingConfigMode,
  ThinkingLevel,
  type FunctionDeclaration,
  type Content,
  type Part,
} from "@google/genai";

const SYSTEM_PROMPT = `You are Foxy, the MCP Factory AI assistant. You help users set up and use MCP Factory's tools for sales outreach.

Key behaviors:
- Be friendly, concise, and helpful
- Ask ONE question at a time to guide users
- When you can help with a task using tools, do so proactively
- Offer quick-reply button options when there are clear choices. Format them as a list at the END of your response using exactly this syntax: - [Button Text]
- If the user needs to set up BYOK keys, guide them to /setup

Available tools let you search for leads, create campaigns, and manage outreach on behalf of the user.

## Campaign tools

- mcpfactory_list_brands: List brands the user has set up.
- mcpfactory_suggest_icp: Analyze a brand URL to suggest target audience (job titles, industries, locations). The returned person_titles, q_organization_keyword_tags, and organization_locations map directly to target_titles, target_industries, and target_locations in mcpfactory_create_campaign.
- mcpfactory_create_campaign: Create and start a campaign. Required: name, brand_url, target_titles. Optional: target_industries, target_locations, max_daily_budget_usd, max_weekly_budget_usd, max_monthly_budget_usd, max_total_budget_usd, max_leads, end_date.
- mcpfactory_list_campaigns: List campaigns, optionally filtered by status (ongoing, stopped, all). Use when the user asks about their campaigns.
- mcpfactory_campaign_stats: Get campaign performance stats (leads, emails, opens, replies, costs). Use when the user asks how a campaign is doing.
- mcpfactory_stop_campaign: Stop a running campaign by campaign_id.
- mcpfactory_resume_campaign: Resume a stopped campaign by campaign_id.
- mcpfactory_campaign_debug: Get detailed debug info for a campaign (status, runs, errors, pipeline state). Use when troubleshooting.

## Campaign creation flow

IMPORTANT: When the user wants to create a campaign or send cold emails, follow this flow:
1. FIRST, call mcpfactory_list_brands to check if the user already has brands set up.
2. If brands exist, present them as button options (e.g. - [https://mybrand.com]) and add a final option - [Use a different URL].
3. If the user picks an existing brand, proceed with that brand URL.
4. If no brands exist, or the user picks "Use a different URL", call request_user_input({ input_type: "url", label: "What's your brand URL?", placeholder: "https://yourbrand.com", field: "brand_url" }) to render a URL input widget.
5. If the user hasn't specified a target audience, call mcpfactory_suggest_icp to get suggestions before creating.
Never ask for the brand URL in plain text — always use either buttons (for existing brands) or the request_user_input tool (for new URLs).

## Campaign management flow

When the user asks about their campaigns, call mcpfactory_list_campaigns first.
When they ask about a specific campaign's performance, call mcpfactory_campaign_stats with the campaign_id.
When they want to stop or resume a campaign, use mcpfactory_stop_campaign or mcpfactory_resume_campaign.
If something seems wrong with a campaign, use mcpfactory_campaign_debug to investigate.`;

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
}

export function createGeminiClient({ apiKey, model = "gemini-3-flash-preview" }: GeminiOptions) {
  const ai = new GoogleGenAI({ apiKey });

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
      const response = await ai.models.generateContentStream({
        model,
        contents: [
          ...history,
          { role: "user", parts: [{ text: userMessage }] },
        ],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: tools?.length
            ? [{ functionDeclarations: tools }]
            : undefined,
          toolConfig: tools?.length
            ? { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } }
            : undefined,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
          },
        },
      });

      for await (const chunk of response) {
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
                args: (part.functionCall.args as Record<string, unknown>) ?? {},
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
              },
            };
          }
        }
      }

      yield { type: "done" };
    },

    async *sendFunctionResult(
      history: Content[],
      functionName: string,
      result: unknown,
      tools?: FunctionDeclaration[]
    ): AsyncGenerator<
      | { type: "token"; content: string }
      | { type: "function_call"; call: FunctionCall }
      | { type: "done" }
    > {
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
          systemInstruction: SYSTEM_PROMPT,
          tools: tools?.length
            ? [{ functionDeclarations: tools }]
            : undefined,
          toolConfig: tools?.length
            ? { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } }
            : undefined,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
          },
        },
      });

      for await (const chunk of response) {
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
                args: (part.functionCall.args as Record<string, unknown>) ?? {},
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
              },
            };
          }
        }
      }

      yield { type: "done" };
    },
  };
}
