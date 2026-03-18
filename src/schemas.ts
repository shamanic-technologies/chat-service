import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// --- Workflow tracking headers (optional, injected by workflow-service) ---

const workflowTrackingHeaders = {
  "x-campaign-id": z.string().optional().openapi({
    description: "Campaign ID — injected automatically by workflow-service",
  }),
  "x-brand-id": z.string().optional().openapi({
    description: "Brand ID — injected automatically by workflow-service",
  }),
  "x-workflow-name": z.string().optional().openapi({
    description: "Workflow name — injected automatically by workflow-service",
  }),
};

// --- Shared schemas ---

export const ErrorResponseSchema = z
  .object({
    error: z.string(),
  })
  .openapi("ErrorResponse");

export const ValidationErrorResponseSchema = z
  .object({
    error: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("ValidationErrorResponse");

// --- Health ---

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
  })
  .openapi("HealthResponse");

registry.registerPath({
  method: "get",
  path: "/health",
  tags: ["Health"],
  summary: "Health check",
  description: "Returns service health status",
  responses: {
    200: {
      description: "Service is healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

// --- OpenAPI ---

registry.registerPath({
  method: "get",
  path: "/openapi.json",
  tags: ["Docs"],
  summary: "OpenAPI specification",
  description: "Returns the OpenAPI 3.0 JSON specification for this service",
  responses: {
    200: {
      description: "OpenAPI spec",
      content: { "application/json": { schema: z.object({}).passthrough() } },
    },
    404: {
      description: "Spec not generated",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- App Config ---

export const AppConfigRequestSchema = z
  .object({
    systemPrompt: z.string().min(1, "systemPrompt is required"),
  })
  .openapi("AppConfigRequest");

export const AppConfigResponseSchema = z
  .object({
    orgId: z.string(),
    systemPrompt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("AppConfigResponse");

export type AppConfigRequest = z.infer<typeof AppConfigRequestSchema>;

registry.registerPath({
  method: "put",
  path: "/config",
  tags: ["App Config"],
  summary: "Register or update app configuration",
  description:
    "Idempotent upsert of app configuration scoped by org (via x-org-id header). Includes system prompt. Call on every cold start.",
  request: {
    headers: z.object({
      "x-api-key": z.string().openapi({
        description: "Service-to-service API key",
      }),
      "x-org-id": z.string().openapi({
        description: "Internal org UUID from client-service",
      }),
      "x-user-id": z.string().openapi({
        description: "Internal user UUID from client-service",
      }),
      "x-run-id": z.string().uuid().openapi({
        description: "Caller's run ID",
      }),
      ...workflowTrackingHeaders,
    }),
    body: {
      content: { "application/json": { schema: AppConfigRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "App config saved",
      content: {
        "application/json": { schema: AppConfigResponseSchema },
      },
    },
    400: {
      description: "Invalid request",
      content: {
        "application/json": { schema: ValidationErrorResponseSchema },
      },
    },
    401: {
      description: "Missing or invalid x-api-key header",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Platform Config ---

export const PlatformConfigRequestSchema = z
  .object({
    systemPrompt: z.string().min(1, "systemPrompt is required"),
  })
  .openapi("PlatformConfigRequest");

export const PlatformConfigResponseSchema = z
  .object({
    systemPrompt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("PlatformConfigResponse");

export type PlatformConfigRequest = z.infer<typeof PlatformConfigRequestSchema>;

registry.registerPath({
  method: "put",
  path: "/platform-config",
  tags: ["Platform Config"],
  summary: "Register or update platform-wide chat configuration",
  description:
    "Idempotent upsert of a global chat configuration (not scoped to any org). Used as fallback when no per-org config exists. Auth: X-API-Key only — no x-org-id, x-user-id, or x-run-id required. Called on every cold start by api-service.",
  request: {
    headers: z.object({
      "x-api-key": z.string().openapi({
        description: "Service-to-service API key",
      }),
    }),
    body: {
      content: { "application/json": { schema: PlatformConfigRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Platform config saved",
      content: {
        "application/json": { schema: PlatformConfigResponseSchema },
      },
    },
    400: {
      description: "Invalid request",
      content: {
        "application/json": { schema: ValidationErrorResponseSchema },
      },
    },
    401: {
      description: "Missing or invalid x-api-key header",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Chat ---

export const ChatRequestSchema = z
  .object({
    message: z.string().min(1, "message is required").openapi({
      description: "The user's chat message",
      example: "What campaigns are performing best this week?",
    }),
    sessionId: z.string().uuid().optional().openapi({
      description:
        "UUID of an existing session to continue. Omit to create a new session. " +
        "When omitted, the service creates a new session and returns its ID in the first SSE event " +
        '({"sessionId":"<uuid>"}). Use that ID in subsequent requests to continue the conversation. ' +
        "If a sessionId is provided but does not exist or belongs to a different org, the stream " +
        'returns a "Session not found." error and closes.',
      example: "550e8400-e29b-41d4-a716-446655440000",
    }),
    context: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        "Free-form JSON injected into the system prompt for this request only (not stored). " +
        "Use this to pass dynamic data like brand URLs, campaign objectives, budgets, etc.",
      example: {
        brandUrl: "https://example.com",
        objective: "clicks",
        budgetAmount: 500,
      },
    }),
  })
  .openapi("ChatRequest");

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// --- SSE Event Schemas (documentation only — these describe the `data:` payloads in the SSE stream) ---

const SSESessionEventSchema = z
  .object({
    sessionId: z.string().uuid().openapi({
      description: "The session UUID — store this for subsequent requests",
    }),
  })
  .openapi("SSESessionEvent");

const SSETokenEventSchema = z
  .object({
    type: z.literal("token"),
    content: z.string().openapi({
      description: "Incremental text fragment of the AI response",
    }),
  })
  .openapi("SSETokenEvent");

const SSEThinkingStartEventSchema = z
  .object({
    type: z.literal("thinking_start"),
  })
  .openapi("SSEThinkingStartEvent");

const SSEThinkingDeltaEventSchema = z
  .object({
    type: z.literal("thinking_delta"),
    thinking: z.string().openapi({
      description: "Incremental fragment of the model's internal reasoning",
    }),
  })
  .openapi("SSEThinkingDeltaEvent");

const SSEThinkingStopEventSchema = z
  .object({
    type: z.literal("thinking_stop"),
  })
  .openapi("SSEThinkingStopEvent");

const SSEToolCallEventSchema = z
  .object({
    type: z.literal("tool_call"),
    id: z.string().openapi({
      description:
        "Unique identifier (format: tc_<uuid>) — use this to match with the corresponding tool_result",
      example: "tc_550e8400-e29b-41d4-a716-446655440000",
    }),
    name: z.string().openapi({
      description: "The tool name being invoked",
      example: "update_workflow",
    }),
    args: z.record(z.string(), z.unknown()).openapi({
      description: "Input arguments passed to the tool, as a JSON object",
      example: { query: "tech companies in Chicago" },
    }),
  })
  .openapi("SSEToolCallEvent");

const SSEToolResultEventSchema = z
  .object({
    type: z.literal("tool_result"),
    id: z.string().openapi({
      description:
        "Matches the id from the corresponding tool_call event",
      example: "tc_550e8400-e29b-41d4-a716-446655440000",
    }),
    name: z.string().openapi({
      description: "The tool name that produced this result",
      example: "update_workflow",
    }),
    result: z.unknown().openapi({
      description: "The tool output — can be a string or a JSON object",
    }),
  })
  .openapi("SSEToolResultEvent");

const SSEInputRequestEventSchema = z
  .object({
    type: z.literal("input_request"),
    input_type: z.enum(["url", "text", "email"]).openapi({
      description: "The type of input widget the frontend should render",
    }),
    label: z.string().openapi({
      description: "Human-readable label/question for the input",
      example: "What's your brand URL?",
    }),
    placeholder: z.string().optional().openapi({
      description: "Placeholder text for the input field",
      example: "https://yourbrand.com",
    }),
    field: z.string().openapi({
      description: "Identifier for what the input represents",
      example: "brand_url",
    }),
    value: z.string().optional().openapi({
      description:
        "Pre-filled value for the input field. When present, the frontend renders the field " +
        "already populated so the user can confirm with a single click. When absent, the field is empty.",
      example: "Automated cold email outreach campaign targeting SaaS founders",
    }),
  })
  .openapi("SSEInputRequestEvent");

const SSEButtonsEventSchema = z
  .object({
    type: z.literal("buttons"),
    buttons: z
      .array(
        z.object({
          label: z.string().openapi({ description: "Button display text" }),
          value: z.string().openapi({
            description:
              "Text to send as the next user message when the button is clicked",
          }),
        }),
      )
      .openapi({ description: "Quick-reply buttons extracted from the AI response" }),
  })
  .openapi("SSEButtonsEvent");

const SSEErrorEventSchema = z
  .object({
    type: z.literal("error"),
    message: z.string().openapi({
      description:
        "Human-readable error message explaining what went wrong",
      example:
        "The AI model returned an empty response. This may happen when the conversation is too long or the message content triggers a safety filter.",
    }),
  })
  .openapi("SSEErrorEvent");

// Register all SSE event schemas so they appear in the OpenAPI components
registry.register("SSESessionEvent", SSESessionEventSchema);
registry.register("SSETokenEvent", SSETokenEventSchema);
registry.register("SSEThinkingStartEvent", SSEThinkingStartEventSchema);
registry.register("SSEThinkingDeltaEvent", SSEThinkingDeltaEventSchema);
registry.register("SSEThinkingStopEvent", SSEThinkingStopEventSchema);
registry.register("SSEToolCallEvent", SSEToolCallEventSchema);
registry.register("SSEToolResultEvent", SSEToolResultEventSchema);
registry.register("SSEInputRequestEvent", SSEInputRequestEventSchema);
registry.register("SSEButtonsEvent", SSEButtonsEventSchema);
registry.register("SSEErrorEvent", SSEErrorEventSchema);

registry.registerPath({
  method: "post",
  path: "/chat",
  tags: ["Chat"],
  summary: "Stream AI chat response",
  description: `Send a message and receive a streamed AI response via Server-Sent Events (SSE).

**Session lifecycle:**
- To start a new conversation, omit \`sessionId\`. The first SSE event will be \`{"sessionId":"<uuid>"}\` — store this ID.
- To continue a conversation, pass that \`sessionId\` in subsequent requests.
- If a provided \`sessionId\` does not exist or belongs to a different org, the stream returns an error and closes.

**SSE event order:**
Each \`data:\` line contains a JSON object. Events arrive in this order:

1. **Session** — \`{"sessionId":"<uuid>"}\` (always first)
2. **Thinking** _(optional)_ — \`thinking_start\` → one or more \`thinking_delta\` → \`thinking_stop\`. May appear before tokens and after tool results.
3. **Tokens** — \`{"type":"token","content":"..."}\` streamed incrementally as the AI generates text.
4. **Tool calls** _(optional, repeatable)_ — \`tool_call\` followed by \`tool_result\`, then more thinking/tokens as the AI continues.
5. **Input request** _(optional)_ — \`input_request\` when the AI needs structured user input (terminates the response).
6. **Buttons** _(optional)_ — \`{"type":"buttons","buttons":[...]}\` with quick-reply options, sent after all tokens.
7. **Error** _(optional)_ — \`{"type":"error","message":"..."}\` if the AI model returns an empty response (context overflow, safety filter) or an unexpected error occurs. Sent before \`[DONE]\`.
8. **Done** — \`"[DONE]"\` (always last).

See the SSE event schemas (SSESessionEvent, SSETokenEvent, SSEThinkingStartEvent, SSEThinkingDeltaEvent, SSEThinkingStopEvent, SSEToolCallEvent, SSEToolResultEvent, SSEInputRequestEvent, SSEButtonsEvent, SSEErrorEvent) in components/schemas for exact payload shapes.

Requires app config to be registered first via PUT /config (or platform config via PUT /platform-config as fallback).`,
  request: {
    headers: z.object({
      "x-api-key": z.string().openapi({
        description: "Service-to-service API key",
      }),
      "x-org-id": z.string().openapi({
        description: "Internal org UUID from client-service",
      }),
      "x-user-id": z.string().openapi({
        description: "Internal user UUID from client-service",
      }),
      "x-run-id": z.string().uuid().openapi({
        description:
          "Caller's run ID — used as parentRunId when creating this service's own run in runs-service",
      }),
      ...workflowTrackingHeaders,
    }),
    body: {
      content: { "application/json": { schema: ChatRequestSchema } },
    },
  },
  responses: {
    200: {
      description:
        "SSE stream of chat events. Each `data:` line is a JSON object matching one of the SSE event schemas " +
        "(SSESessionEvent, SSETokenEvent, SSEThinkingStartEvent, SSEThinkingDeltaEvent, SSEThinkingStopEvent, " +
        'SSEToolCallEvent, SSEToolResultEvent, SSEInputRequestEvent, SSEButtonsEvent, SSEErrorEvent), except the final `data: "[DONE]"` which is a plain string.',
      content: {
        "text/event-stream": {
          schema: z.string(),
        },
      },
    },
    400: {
      description: "Missing or invalid request fields",
      content: {
        "application/json": { schema: ValidationErrorResponseSchema },
      },
    },
    401: {
      description: "Missing or invalid x-api-key header",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description:
        "App config not found — register via PUT /config first, or ensure platform config exists via PUT /platform-config",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
