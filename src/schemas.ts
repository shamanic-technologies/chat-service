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
    description: "Brand ID(s) — injected automatically by workflow-service. May be a single UUID or a comma-separated list of UUIDs for multi-brand campaigns (e.g. 'uuid1,uuid2,uuid3').",
    example: "550e8400-e29b-41d4-a716-446655440000,660f9500-f30c-52e5-b827-557766551111",
  }),
  "x-workflow-slug": z.string().optional().openapi({
    description: "Workflow slug — injected automatically by workflow-service",
  }),
  "x-feature-slug": z.string().optional().openapi({
    description: "Feature slug — propagated through the entire service chain",
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

export const InsufficientCreditsResponseSchema = z
  .object({
    error: z.literal("Insufficient credits"),
    balance_cents: z.number().openapi({
      description: "Current credit balance in USD cents",
    }),
    required_cents: z.number().openapi({
      description: "Estimated cost of this request in USD cents",
    }),
  })
  .openapi("InsufficientCreditsResponse");

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
    key: z.string().min(1, "key is required").openapi({
      description:
        "Config key — identifies which chat mode this config is for (e.g. 'workflow', 'feature', 'press-kit'). " +
        "Each org can have multiple configs, one per key.",
      example: "workflow",
    }),
    systemPrompt: z.string().min(1, "systemPrompt is required").openapi({
      description: "System prompt sent to the LLM for this chat mode",
      example:
        "You are an AI assistant that helps users understand and modify their workflows.",
    }),
    allowedTools: z.array(z.string().min(1)).min(1, "allowedTools must contain at least one tool").openapi({
      description:
        "List of tool names the LLM is allowed to use in this chat mode. " +
        "Only these tools will be provided to the model and executable server-side. " +
        "Available tools: request_user_input, update_workflow, validate_workflow, " +
        "get_workflow_details, generate_workflow, get_workflow_required_providers, list_workflows, " +
        "update_workflow_node_config, get_prompt_template, update_prompt_template, " +
        "list_services, list_service_endpoints, " +
        "list_org_keys, get_key_source, list_key_sources, check_provider_requirements, " +
        "create_feature, update_feature, list_features, get_feature, get_feature_inputs, " +
        "prefill_feature, get_feature_stats, " +
        "update_campaign_fields, extract_brand_fields, extract_brand_text",
      example: [
        "request_user_input",
        "update_workflow",
        "validate_workflow",
        "get_workflow_details",
        "list_workflows",
      ],
    }),
  })
  .strict()
  .openapi("AppConfigRequest");

export const AppConfigResponseSchema = z
  .object({
    orgId: z.string(),
    key: z.string(),
    systemPrompt: z.string(),
    allowedTools: z.array(z.string()),
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
    "Idempotent upsert of app configuration scoped by (orgId, key). Each key represents a chat mode " +
    "(e.g. 'workflow', 'feature', 'press-kit'). The config defines the system prompt and which tools " +
    "the LLM can use in that mode. Call on every cold start.\n\n" +
    "**Example — workflow chat config:**\n" +
    "```json\n" +
    '{ "key": "workflow", "systemPrompt": "You help users understand and modify workflows...", ' +
    '"allowedTools": ["request_user_input", "update_workflow", "validate_workflow", "get_workflow_details", "list_workflows", "update_workflow_node_config", "get_prompt_template", "update_prompt_template", "list_org_keys", "get_key_source", "list_key_sources", "check_provider_requirements", "list_services", "list_service_endpoints", "generate_workflow", "get_workflow_required_providers"] }\n' +
    "```\n\n" +
    "**Example — feature chat config:**\n" +
    "```json\n" +
    '{ "key": "feature", "systemPrompt": "You help users design and manage features...", ' +
    '"allowedTools": ["request_user_input", "create_feature", "update_feature", "list_features", "get_feature", "get_feature_inputs", "prefill_feature", "get_feature_stats"] }\n' +
    "```",
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
    key: z.string().min(1, "key is required").openapi({
      description:
        "Config key — identifies which chat mode this platform config is for. " +
        "Used as fallback when no per-org config exists for this key.",
      example: "workflow",
    }),
    systemPrompt: z.string().min(1, "systemPrompt is required").openapi({
      description: "Default system prompt for all orgs without a per-org config for this key",
      example:
        "You are an AI assistant that helps users understand and modify their workflows.",
    }),
    allowedTools: z.array(z.string().min(1)).min(1, "allowedTools must contain at least one tool").openapi({
      description:
        "List of tool names the LLM is allowed to use. Same semantics as in PUT /config.",
      example: [
        "request_user_input",
        "update_workflow",
        "validate_workflow",
        "get_workflow_details",
        "list_workflows",
      ],
    }),
  })
  .strict()
  .openapi("PlatformConfigRequest");

export const PlatformConfigResponseSchema = z
  .object({
    key: z.string(),
    systemPrompt: z.string(),
    allowedTools: z.array(z.string()),
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
    "Idempotent upsert of a platform-wide chat configuration keyed by `key`. " +
    "Used as fallback when no per-org config exists for the same key. " +
    "Auth: X-API-Key only — no x-org-id, x-user-id, or x-run-id required. " +
    "Called on every cold start by api-service.\n\n" +
    "**Config resolution in POST /chat:** " +
    "Per-org config `(orgId, configKey)` takes priority. If none exists, " +
    "platform config `(configKey)` is used. If neither exists → 404.",
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

// --- Complete (synchronous LLM call) ---

export const CompleteRequestSchema = z
  .object({
    message: z.string().min(1, "message is required").openapi({
      description: "The prompt to send to the LLM",
      example: "Given this brand context, generate 10 Google search queries for PR outreach.",
    }),
    systemPrompt: z.string().min(1).openapi({
      description: "Inline system prompt — no pre-registered config required",
      example: "You are a PR research assistant.",
    }),
    responseFormat: z.literal("json").optional().openapi({
      description: 'Set to "json" to instruct the model to return valid JSON. The response will be parsed and returned in the `json` field.',
    }),
    temperature: z.number().min(0).max(2).optional().openapi({
      description: "Sampling temperature (0–2). Lower = more deterministic.",
      example: 0.3,
    }),
    maxTokens: z.number().int().min(1).max(64000).optional().openapi({
      description: "Maximum tokens in the response (default: 64000)",
      example: 2000,
    }),
    provider: z.enum(["anthropic", "google"]).openapi({
      description: "LLM provider to use.",
      example: "anthropic",
    }),
    model: z.enum(["haiku", "sonnet", "opus", "flash-lite", "flash", "pro"]).openapi({
      description:
        "Model alias (version-free). The service resolves the latest versioned model internally.\n\n" +
        "**Anthropic models:** `haiku` (fast/cheap), `sonnet` (balanced), `opus` (highest quality).\n" +
        "**Google models:** `flash-lite` (cheapest, vision), `flash` (balanced, reasoning), `pro` (most powerful).\n\n" +
        "The model must match the provider: anthropic → haiku|sonnet|opus, google → flash-lite|flash|pro.",
      example: "sonnet",
    }),
    imageUrl: z.string().url().optional().openapi({
      description: "URL of an image to include in the prompt. The image is fetched server-side and sent to the model as a visual input. Supported by all models, but recommended with provider: \"google\", model: \"flash-lite\" for cost-effective vision tasks (image classification, scoring, analysis).",
      example: "https://example.com/images/hero.jpg",
    }),
    imageContext: z.object({
      alt: z.string().optional().openapi({
        description: "Alt text of the image (from the HTML img tag)",
        example: "Company team photo",
      }),
      title: z.string().optional().openapi({
        description: "Title attribute or caption of the image",
        example: "Our Leadership Team",
      }),
      sourceUrl: z.string().optional().openapi({
        description: "The page URL where the image was found (not the image URL itself)",
        example: "https://example.com/about",
      }),
    }).optional().openapi({
      description: "Optional metadata about the image (alt text, title, source page). Injected into the prompt alongside the image to help the model classify and score it more accurately. Only meaningful when imageUrl is provided.",
    }),
  })
  .superRefine((data, ctx) => {
    const validModels: Record<string, string[]> = {
      anthropic: ["haiku", "sonnet", "opus"],
      google: ["flash-lite", "flash", "pro"],
    };
    const allowed = validModels[data.provider];
    if (allowed && !allowed.includes(data.model)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Model "${data.model}" is not valid for provider "${data.provider}". Valid models: ${allowed.join(", ")}`,
        path: ["model"],
      });
    }
  })
  .openapi("CompleteRequest");

export const CompleteResponseSchema = z
  .object({
    content: z.string().openapi({
      description: "Raw text response from the model. WARNING: when responseFormat is \"json\", this field may contain markdown code fences (e.g. ```json...```). Do NOT use this field for JSON parsing — use the `json` field instead.",
      example: '{"subject": "Quick question", "emails": [{"body": "Hi...", "daysSinceLastStep": 0}]}',
    }),
    json: z.record(z.string(), z.unknown()).optional().openapi({
      description: "Parsed JSON object — present when responseFormat is \"json\". IMPORTANT: always use this field (not `content`) when you need structured data. Markdown fences are already stripped and the JSON is pre-parsed. If the model returns non-parsable JSON, the endpoint returns 502 instead of silently omitting this field.",
      example: { subject: "Quick question", emails: [{ body: "Hi there, I noticed...", daysSinceLastStep: 0 }] },
    }),
    tokensInput: z.number().openapi({
      description: "Number of input tokens consumed",
      example: 450,
    }),
    tokensOutput: z.number().openapi({
      description: "Number of output tokens generated",
      example: 800,
    }),
    model: z.string().openapi({
      description: "Versioned model ID actually used for the completion (resolved by the service from the provider+model alias)",
      example: "claude-sonnet-4-6",
    }),
  })
  .openapi("CompleteResponse");

export type CompleteRequest = z.infer<typeof CompleteRequestSchema>;

registry.registerPath({
  method: "post",
  path: "/complete",
  tags: ["Complete"],
  summary: "Synchronous LLM completion",
  description: `One-shot, non-streaming LLM call for service-to-service use. Returns a JSON response with the model output.

Unlike POST /chat, this endpoint:
- Does **not** create or use sessions (stateless, one-shot)
- Accepts an inline \`systemPrompt\` (no pre-registered config required)
- Returns JSON instead of SSE
- Supports \`responseFormat: "json"\` — when set, the parsed object is returned in the \`json\` field (always use \`json\`, not \`content\`, for structured data)
- Supports optional \`temperature\` and \`maxTokens\` overrides
- Supports **vision** via the \`imageUrl\` field — the image is fetched server-side and sent as visual input to the model

**Provider + model (both required):**
Callers specify a provider and a version-free model alias. The service resolves the latest versioned model ID internally.

| provider | model | Description |
|----------|-------|-------------|
| \`anthropic\` | \`sonnet\` | General-purpose, high quality |
| \`anthropic\` | \`haiku\` | Faster/cheaper for simple extraction and classification |
| \`anthropic\` | \`opus\` | Highest quality for complex reasoning |
| \`google\` | \`flash-lite\` | Cheapest, cost-effective vision model for image analysis |
| \`google\` | \`flash\` | Balanced price-performance with reasoning capabilities |
| \`google\` | \`pro\` | Most powerful Google model for complex tasks |

All Google models require a Google API key configured in key-service (provider: \`google\`).

**Use cases:** generating search queries, scoring/analyzing text, image classification and scoring (with \`imageUrl\` + google/flash-lite), any service that needs a quick LLM call without conversation context.`,
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
      content: { "application/json": { schema: CompleteRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "LLM completion result",
      content: {
        "application/json": { schema: CompleteResponseSchema },
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
    402: {
      description: "Insufficient credits (platform-key only)",
      content: {
        "application/json": { schema: InsufficientCreditsResponseSchema },
      },
    },
    502: {
      description: "Upstream service unavailable (key-service, billing-service, runs-service, or LLM provider)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Chat ---

export const ChatRequestSchema = z
  .object({
    configKey: z.string().min(1, "configKey is required").openapi({
      description:
        "Which chat config to use for this request. Must match a key registered via PUT /config " +
        "(per-org) or PUT /platform-config (platform-wide fallback). " +
        "Examples: 'workflow', 'feature', 'press-kit'.",
      example: "workflow",
    }),
    message: z.string().min(1, "message is required").openapi({
      description: "The user's chat message",
      example: "What campaigns are performing best this week?",
    }),
    sessionId: z.string().uuid().nullish().openapi({
      description:
        "UUID of an existing session to continue. Omit or pass null to start a new conversation. " +
        "When omitted, the service creates a new session and returns its ID in the first SSE event " +
        '({"sessionId":"<uuid>"}). Use that ID in subsequent requests to continue the conversation. ' +
        "If a sessionId is provided but does not exist or belongs to a different org, the stream " +
        'returns a "Session not found." error and closes.',
      example: "550e8400-e29b-41d4-a716-446655440000",
    }),
    context: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        "Free-form JSON context provided by the frontend (not user-editable). " +
        "Injected into the system prompt for this request only (not stored). " +
        "Re-send on every message — the service does not cache it. " +
        "Use this to pass the current page state: workflow details, brand info, etc.",
      example: {
        workflowId: "wf-550e8400-e29b-41d4-a716-446655440000",
        workflowSlug: "cold-email-outreach",
        workflowName: "Cold Email Outreach",
        brandId: "brand-123",
        brandUrl: "https://example.com",
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

**Config resolution:**
The \`configKey\` field selects which chat config to use. Resolution order:
1. Per-org config: \`(orgId, configKey)\` from PUT /config
2. Platform config: \`(configKey)\` from PUT /platform-config
3. If neither exists → 404

The selected config determines both the system prompt and which tools the LLM can use.

**Session lifecycle:**
- To start a new conversation, omit \`sessionId\` (or pass \`null\`). The first SSE event will be \`{"sessionId":"<uuid>"}\` — store this ID.
- To continue a conversation, pass that \`sessionId\` in subsequent requests.
- To reset a conversation (e.g. after a fork), omit \`sessionId\` and send a new \`context\`.

**Context:**
The \`context\` field is a free-form JSON object provided by the frontend on **every** message. It is injected into the system prompt but not stored. Re-send it on every request — the service does not cache it. After a fork (e.g. workflow updated → new workflow created), the frontend should update its context with the new IDs and either continue the session or start a new one.

**SSE event order:**
Each \`data:\` line contains a JSON object. Events arrive in this order:

1. **Session** — \`{"sessionId":"<uuid>"}\` (always first)
2. **Thinking** _(optional)_ — \`thinking_start\` → one or more \`thinking_delta\` → \`thinking_stop\`.
3. **Tokens** — \`{"type":"token","content":"..."}\` streamed incrementally.
4. **Tool calls** _(optional, repeatable)_ — \`tool_call\` followed by \`tool_result\`, then more thinking/tokens.
5. **Input request** _(optional)_ — \`input_request\` when the AI needs structured user input (terminates the response).
6. **Buttons** _(optional)_ — \`{"type":"buttons","buttons":[...]}\` with quick-reply options, sent after all tokens.
7. **Error** _(optional)_ — \`{"type":"error","message":"..."}\` if something goes wrong. Sent before \`[DONE]\`.
8. **Done** — \`"[DONE]"\` (always last).

**Available tools** depend on the config's \`allowedTools\`. The LLM only sees and can call the tools listed there. See PUT /config documentation for the full list of available tool names.`,
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
    402: {
      description:
        "Insufficient credits — the org's credit balance is too low to cover this request. " +
        "Only applies to platform-key usage (BYOK orgs are not charged).",
      content: {
        "application/json": { schema: InsufficientCreditsResponseSchema },
      },
    },
    404: {
      description:
        "App config not found — register via PUT /config first, or ensure platform config exists via PUT /platform-config",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
