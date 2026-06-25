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
  "x-audience-id": z.string().optional().openapi({
    description:
      "Priority audience ID for the campaign run — injected by campaign-service and propagated through the chain for per-audience cost attribution. Optional outside the campaign flow.",
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
        "Available tools: request_user_input, create_workflow, upgrade_workflow, fork_workflow, " +
        "validate_workflow, get_workflow_details, get_workflow_required_providers, list_workflows, " +
        "get_prompt_template, update_prompt_template, " +
        "list_services, list_service_endpoints, " +
        "list_org_keys, get_key_source, list_key_sources, check_provider_requirements, " +
        "create_feature, update_feature, list_features, get_feature, get_feature_inputs, " +
        "prefill_feature, get_feature_stats, " +
        "update_campaign_fields, extract_brand_fields, browse_url",
      example: [
        "request_user_input",
        "create_workflow",
        "upgrade_workflow",
        "fork_workflow",
        "validate_workflow",
        "get_workflow_details",
        "list_workflows",
      ],
    }),
    provider: z.enum(["anthropic", "google"]).optional().openapi({
      description:
        "LLM provider for this chat mode. Omit to use the default (google).\n\n" +
        "- `anthropic` — Claude models (haiku, sonnet, opus)\n" +
        "- `google` — Gemini models (flash-lite, flash, flash-pro, pro)",
      example: "google",
    }),
    model: z.enum(["haiku", "sonnet", "opus", "flash-lite", "flash", "flash-pro", "pro"]).optional().openapi({
      description:
        "Model alias (version-free). Omit to use the provider's default " +
        "(sonnet for anthropic, flash-pro for google). Must match the provider:\n\n" +
        "- anthropic → haiku, sonnet, opus\n" +
        "- google → flash-lite, flash, flash-pro, pro",
      example: "pro",
    }),
  })
  .strict()
  .refine(
    (data) => {
      if (!data.provider || !data.model) return true;
      const anthropicModels = ["haiku", "sonnet", "opus"];
      const googleModels = ["flash-lite", "flash", "flash-pro", "pro"];
      if (data.provider === "anthropic") return anthropicModels.includes(data.model);
      if (data.provider === "google") return googleModels.includes(data.model);
      return false;
    },
    {
      message: "Model must match provider: anthropic → haiku|sonnet|opus, google → flash-lite|flash|flash-pro|pro",
      path: ["model"],
    },
  )
  .openapi("AppConfigRequest");

export const AppConfigResponseSchema = z
  .object({
    orgId: z.string(),
    key: z.string(),
    systemPrompt: z.string(),
    allowedTools: z.array(z.string()),
    provider: z.enum(["anthropic", "google"]).nullable().openapi({
      description: "LLM provider. Null means default (google).",
    }),
    model: z.string().nullable().openapi({
      description: "Model alias. Null means provider default (sonnet for anthropic, flash-pro for google).",
    }),
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
    '"allowedTools": ["request_user_input", "create_workflow", "upgrade_workflow", "fork_workflow", "validate_workflow", "get_workflow_details", "list_workflows", "get_prompt_template", "update_prompt_template", "list_org_keys", "get_key_source", "list_key_sources", "check_provider_requirements", "list_services", "list_service_endpoints", "get_workflow_required_providers"] }\n' +
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
        "create_workflow",
        "upgrade_workflow",
        "fork_workflow",
        "validate_workflow",
        "get_workflow_details",
        "list_workflows",
      ],
    }),
    provider: z.enum(["anthropic", "google"]).optional().openapi({
      description:
        "LLM provider for this chat mode. Omit to use the default (google).\n\n" +
        "- `anthropic` — Claude models (haiku, sonnet, opus)\n" +
        "- `google` — Gemini models (flash-lite, flash, flash-pro, pro)",
      example: "google",
    }),
    model: z.enum(["haiku", "sonnet", "opus", "flash-lite", "flash", "flash-pro", "pro"]).optional().openapi({
      description:
        "Model alias (version-free). Omit to use the provider's default " +
        "(sonnet for anthropic, flash-pro for google). Must match the provider.",
      example: "pro",
    }),
  })
  .strict()
  .refine(
    (data) => {
      if (!data.provider || !data.model) return true;
      const anthropicModels = ["haiku", "sonnet", "opus"];
      const googleModels = ["flash-lite", "flash", "flash-pro", "pro"];
      if (data.provider === "anthropic") return anthropicModels.includes(data.model);
      if (data.provider === "google") return googleModels.includes(data.model);
      return false;
    },
    {
      message: "Model must match provider: anthropic → haiku|sonnet|opus, google → flash-lite|flash|flash-pro|pro",
      path: ["model"],
    },
  )
  .openapi("PlatformConfigRequest");

export const PlatformConfigResponseSchema = z
  .object({
    key: z.string(),
    systemPrompt: z.string(),
    allowedTools: z.array(z.string()),
    provider: z.enum(["anthropic", "google"]).nullable().openapi({
      description: "LLM provider. Null means default (google).",
    }),
    model: z.string().nullable().openapi({
      description: "Model alias. Null means provider default (sonnet for anthropic, flash-pro for google).",
    }),
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
    systemPrompt: z.string().openapi({
      description:
        "Inline system prompt — no pre-registered config required. Empty string is allowed: " +
        "the provider receives no system prompt and falls back to its default behavior. The " +
        "value is forwarded byte-equal to the provider; the service does not inject, enrich, " +
        "or nudge the prompt.",
      example: "You are a PR research assistant.",
    }),
    responseFormat: z.literal("json").optional().openapi({
      description: 'Set to "json" to instruct the model to return valid JSON. The response will be parsed and returned in the `json` field.',
    }),
    responseSchema: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        "Optional JSON Schema describing the exact shape of the expected JSON response. When set, the schema is " +
        "passed to the provider's structured-output API (Gemini: `generationConfig.responseSchema`; Anthropic: " +
        "`output_config.format` with `type: \"json_schema\"`) and the provider enforces the shape server-side. " +
        "Implies `responseFormat: \"json\"`. " +
        "**Anthropic constraint:** the schema must be strict — `additionalProperties: false` and an explicit `properties` map. " +
        "Permissive schemas are rejected with 400.",
      example: {
        type: "object",
        additionalProperties: false,
        properties: { subject: { type: "string" }, emails: { type: "array", items: { type: "object" } } },
        required: ["subject", "emails"],
      },
    }),
    temperature: z.number().min(0).max(2).optional().openapi({
      description: "Sampling temperature (0–2). Lower = more deterministic.",
      example: 0.3,
    }),
    maxTokens: z.number().int().min(1).max(64_000).optional().openapi({
      description:
        "Optional output-token budget for this call. When set, it caps the provider's " +
        "generation (Anthropic `max_tokens` / Gemini `maxOutputTokens`, bounded to 64000) " +
        "AND sizes the pre-call cost reservation exactly to this budget. Omit it and the " +
        "service reserves a right-sized estimate (well below the 64000 model max) while the " +
        "provider keeps the full budget so long outputs are not truncated. Declare it when " +
        "you know your output is small (e.g. scoring, short JSON, suggestion lists) — this " +
        "prevents a burst of concurrent calls from over-reserving against your org balance.",
      example: 4096,
    }),
    provider: z.enum(["anthropic", "google"]).openapi({
      description: "LLM provider to use.",
      example: "anthropic",
    }),
    model: z.enum(["haiku", "sonnet", "opus", "flash-lite", "flash", "flash-pro", "pro"]).openapi({
      description:
        "Model alias (version-free). The service resolves the latest versioned model internally.\n\n" +
        "**Anthropic models:** `haiku` (fast/cheap), `sonnet` (balanced), `opus` (highest quality).\n" +
        "**Google models:** `flash-lite` (cheapest, vision), `flash` (balanced, reasoning), `flash-pro` (mid-tier, Gemini 3.5 Flash), `pro` (most powerful).\n\n" +
        "The model must match the provider: anthropic → haiku|sonnet|opus, google → flash-lite|flash|flash-pro|pro.",
      example: "sonnet",
    }),
    webSearch: z.boolean().optional().openapi({
      description:
        "Opt-in native web search. When true, the resolved provider answers using its OWN " +
        "native web search — Google Search grounding for `google`, the server-side `web_search` " +
        "tool for `anthropic` — so the response reflects live web content instead of the model's " +
        "parametric memory. Citation source URLs are appended to `content` (text mode only). " +
        "Omitted or false = no grounding, byte-identical to a non-grounded call (no extra cost). " +
        "The web-search cost is metered per query/search and billed in addition to tokens.",
      example: true,
    }),
    disableThinking: z.boolean().optional().openapi({
      description:
        "Minimize the model's internal reasoning (\"thinking\") so the whole output budget goes to " +
        "the answer. Use for extraction / structured-JSON / scoring tasks that don't need " +
        "chain-of-thought. Effect is provider-floored, NOT a guaranteed full-off (like `maxSearches`): " +
        "Gemini 2.5 → thinking fully OFF; Anthropic → no-op (`/complete` never enables thinking); " +
        "Gemini 3 has NO full-off, so it drops to the lowest level the gen allows — `minimal` for " +
        "Flash (incl. the `flash-pro` default = Gemini 3.5 Flash), `low` for Pro. Omitted or false = " +
        "the service default (bounded thinking, byte-identical to a normal call).",
      example: true,
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
      google: ["flash-lite", "flash", "flash-pro", "pro"],
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
- Supports optional \`temperature\` override
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

// --- Image Generation ---

export const GenerateImageRequestSchema = z
  .object({
    prompt: z.string().min(1, "prompt is required").openapi({
      description:
        "Text prompt for Gemini image generation. Chat-service owns provider/model request shaping; callers should describe the desired image, not pass Gemini generationConfig fields.",
      example:
        "Generate a square PNG avatar portrait for a B2B SaaS buyer persona: confident marketing leader, clean studio lighting, no text.",
    }),
    size: z.enum(["small", "medium", "large", "xlarge"]).optional().openapi({
      description:
        "Generated image size. Omit for `small` (512px). `medium` maps to 1K, `large` maps to 2K, and `xlarge` maps to 4K.",
      example: "small",
    }),
  })
  .strict()
  .openapi("GenerateImageRequest");

export const GenerateImageResponseSchema = z
  .object({
    imageBase64: z.string().openapi({
      description: "Base64-encoded generated image bytes. Decode and store with the returned MIME type.",
      example: "iVBORw0KGgoAAAANSUhEUgAA...",
    }),
    mimeType: z.string().openapi({
      description: "MIME type for the generated image bytes.",
      example: "image/png",
    }),
    model: z.string().openapi({
      description: "Versioned Gemini image model used by chat-service.",
      example: "gemini-3.1-flash-image",
    }),
    tokensInput: z.number().openapi({
      description: "Input tokens reported by Gemini for the prompt.",
      example: 120,
    }),
    tokensOutput: z.number().openapi({
      description: "Image output tokens reported by Gemini.",
      example: 747,
    }),
    text: z.string().optional().openapi({
      description: "Optional text part returned alongside the image, when Gemini includes one.",
      example: "Here is the generated avatar.",
    }),
  })
  .openapi("GenerateImageResponse");

export type GenerateImageRequest = z.infer<typeof GenerateImageRequestSchema>;

registry.registerPath({
  method: "post",
  path: "/orgs/images/generate",
  tags: ["Images"],
  summary: "Generate an image",
  description: `Org-scoped service-auth image generation for user-initiated workflows such as persona avatar regeneration.

Chat-service owns provider key resolution, Gemini request shaping, run creation, cost provisioning, billing authorization, provider execution, and cost reconciliation. Callers pass a text prompt plus optional size and receive generated image bytes plus MIME/model metadata suitable for storage.`,
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
      content: { "application/json": { schema: GenerateImageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Generated image data",
      content: {
        "application/json": { schema: GenerateImageResponseSchema },
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
      description: "Upstream service unavailable or provider image generation failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Internal Platform Complete ---

export const InternalPlatformCompleteRequestSchema = z
  .object({
    message: z.string().min(1, "message is required").openapi({
      description: "The prompt to send to the LLM",
      example: "Analyze this workflow definition and suggest field mappings.",
    }),
    systemPrompt: z.string().openapi({
      description:
        "Inline system prompt. Empty string is allowed: the provider receives no system " +
        "prompt and falls back to its default behavior. The value is forwarded byte-equal " +
        "to the provider; the service does not inject, enrich, or nudge the prompt.",
      example: "You are a workflow analysis assistant.",
    }),
    responseFormat: z.literal("json").optional().openapi({
      description: 'Set to "json" to instruct the model to return valid JSON.',
    }),
    responseSchema: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        "Optional JSON Schema enforced server-side by the provider's structured-output API. " +
        "Implies `responseFormat: \"json\"`. Same shape and constraints as POST /complete.",
    }),
    temperature: z.number().min(0).max(2).optional().openapi({
      description: "Sampling temperature (0–2). Lower = more deterministic.",
      example: 0.3,
    }),
    provider: z.enum(["anthropic", "google"]).openapi({
      description: "LLM provider to use.",
      example: "anthropic",
    }),
    model: z.enum(["haiku", "sonnet", "opus", "flash-lite", "flash", "flash-pro", "pro"]).openapi({
      description: "Model alias (version-free).",
      example: "sonnet",
    }),
    webSearch: z.boolean().optional().openapi({
      description:
        "Opt-in native web search. When true, the resolved provider answers using its OWN native " +
        "web search (Google Search grounding for `google`, server-side `web_search` for `anthropic`). " +
        "Citation source URLs are appended to `content` (text mode only). Omitted or false = no " +
        "grounding, byte-identical to a non-grounded call. The web-search cost is declared on the " +
        "platform run in addition to tokens.",
      example: true,
    }),
    disableThinking: z.boolean().optional().openapi({
      description:
        "Minimize the model's internal reasoning so the whole output budget goes to the answer. " +
        "Provider-floored, NOT a guaranteed full-off: Gemini 2.5 → fully OFF; Anthropic → no-op; " +
        "Gemini 3 → lowest level the gen allows (`minimal` Flash, `low` Pro — no full-off exists). " +
        "Same semantics as POST /complete. Omitted or false = the service default (bounded thinking).",
      example: true,
    }),
  })
  .openapi("InternalPlatformCompleteRequest");

export type InternalPlatformCompleteRequest = z.infer<typeof InternalPlatformCompleteRequestSchema>;

registry.registerPath({
  method: "post",
  path: "/internal/platform-complete",
  tags: ["Internal"],
  summary: "Platform-level LLM completion (no billing, no run tracking)",
  description: `Internal endpoint for platform-level LLM calls that do not belong to a specific org or user.

**Auth:** Requires only \`x-api-key\` (no \`x-org-id\`, \`x-user-id\`, or \`x-run-id\`).

**Key resolution:** Uses the platform key directly via \`GET /keys/platform/{provider}/decrypt\` — no org-level key lookup.

**No billing, no run tracking.** This endpoint is for internal service-to-service calls (e.g. workflow upgrades at startup) where there is no org to bill and no user-initiated run to track.

Does not support \`imageUrl\` or \`imageContext\` — use \`POST /complete\` for vision tasks.`,
  request: {
    headers: z.object({
      "x-api-key": z.string().openapi({
        description: "Service-to-service API key",
      }),
    }),
    body: {
      content: { "application/json": { schema: InternalPlatformCompleteRequestSchema } },
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
    502: {
      description: "Upstream service unavailable (key-service or LLM provider)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Internal Platform Image Generation ---

registry.registerPath({
  method: "post",
  path: "/internal/platform-images/generate",
  tags: ["Internal"],
  summary: "Platform-level image generation (no org, no billing authorize)",
  description: `Internal endpoint for platform-level Gemini image generation that does not belong to a specific org or user. Platform twin of \`POST /orgs/images/generate\`.

**Auth:** Requires only \`x-api-key\` (no \`x-org-id\`, \`x-user-id\`, or \`x-run-id\`).

**Key resolution:** Uses the platform Google key directly via \`GET /keys/platform/google/decrypt\` — no org-level key lookup.

**Spend tracking:** Image-generation token spend is declared on a platform run (\`POST /v1/platform-runs\` → \`POST /v1/platform-runs/:id/costs\` with \`costSource: "platform"\`). No org affordability authorize and no provision/cancel — costs are posted as \`actual\` post-call. Fail loud (502) if spend cannot be declared.

Callers pass a text prompt plus optional size and receive generated image bytes plus MIME/model metadata suitable for storage.`,
  request: {
    headers: z.object({
      "x-api-key": z.string().openapi({
        description: "Service-to-service API key",
      }),
    }),
    body: {
      content: { "application/json": { schema: GenerateImageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Generated image data",
      content: {
        "application/json": { schema: GenerateImageResponseSchema },
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
    502: {
      description: "Upstream service unavailable (key-service or runs-service) or provider image generation failed",
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
    context: z
      .record(z.string(), z.unknown())
      .optional()
      .refine(
        (v) => v === undefined || JSON.stringify(v).length <= 51_200,
        { message: "context too large (max 50KB JSON)" },
      )
      .openapi({
        description:
          "Free-form JSON context provided by the frontend (not user-editable). " +
          "Injected into the system prompt for this request only (not stored). " +
          "Re-send on every message — the service does not cache it. " +
          "Use this to pass the current page state: workflow details, brand info, etc. " +
          "Capped at 50KB when serialized to JSON; oversized payloads return 400.",
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
      example: "fork_workflow",
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
      example: "fork_workflow",
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
    code: z
      .enum([
        "model_overloaded",
        "rate_limited",
        "model_error",
        "internal_error",
        "session_not_found",
      ])
      .openapi({
        description:
          "Machine-readable error code. `model_overloaded` — Claude is temporarily at capacity (retry after a moment). " +
          "`rate_limited` — too many requests (respect retry-after). " +
          "`model_error` — transient upstream error. " +
          "`internal_error` — unexpected server error. " +
          "`session_not_found` — the supplied sessionId does not exist or belongs to a different org.",
        example: "model_overloaded",
      }),
    message: z.string().openapi({
      description:
        "Human-readable error message explaining what went wrong",
      example:
        "Claude is temporarily overloaded. Please try again in a moment.",
    }),
  })
  .openapi("SSEErrorEvent");

const SSEContextUsageEventSchema = z
  .object({
    type: z.literal("context_usage"),
    inputTokens: z.number().int().nonnegative().openapi({
      description:
        "Tokens consumed on the input/prompt side for this turn (post-compaction for Anthropic, post-trim for Gemini).",
    }),
    outputTokens: z.number().int().nonnegative().openapi({
      description: "Tokens generated by the model on this turn.",
    }),
    maxTokens: z.number().int().positive().openapi({
      description:
        "Upper bound on the input window the service is willing to use, in tokens (200000 — Anthropic Sonnet limit, also enforced for Gemini).",
      example: 200_000,
    }),
    percent: z.number().int().min(0).max(100).openapi({
      description:
        "inputTokens / maxTokens as a 0–100 integer, capped at 100. Use this to render a usage gauge.",
    }),
  })
  .openapi("SSEContextUsageEvent");

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
registry.register("SSEContextUsageEvent", SSEContextUsageEventSchema);

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

// --- Internal: Transfer Brand ---

export const TransferBrandRequestSchema = z
  .object({
    sourceBrandId: z.string().min(1).openapi({
      description: "The brand UUID to transfer (in the source org)",
    }),
    sourceOrgId: z.string().min(1).openapi({
      description: "The org UUID the brand is currently in",
    }),
    targetOrgId: z.string().min(1).openapi({
      description: "The org UUID to transfer the brand to",
    }),
    targetBrandId: z.string().min(1).optional().openapi({
      description:
        "The brand UUID in the target org to rewrite to. " +
        "When present (conflict case), brand references are rewritten from sourceBrandId to targetBrandId. " +
        "When absent, only org_id is updated.",
    }),
  })
  .strict()
  .openapi("TransferBrandRequest");

export const TransferBrandResponseSchema = z
  .object({
    updatedTables: z.array(
      z.object({
        tableName: z.string(),
        count: z.number(),
      }),
    ).openapi({
      description: "List of tables updated with row counts",
    }),
  })
  .openapi("TransferBrandResponse");

export type TransferBrandRequest = z.infer<typeof TransferBrandRequestSchema>;

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  tags: ["Internal"],
  summary: "Transfer brand ownership between orgs",
  description:
    "Re-assigns all solo-brand sessions from sourceOrgId to targetOrgId. " +
    "Solo-brand = sessions where brand_ids contains exactly one element matching sourceBrandId. " +
    "When targetBrandId is provided (conflict case), brand references are rewritten to targetBrandId. " +
    "Sessions with multiple brand IDs (co-branding) are skipped. Idempotent.",
  request: {
    headers: z.object({
      "x-api-key": z.string().openapi({
        description: "Service-to-service API key",
      }),
    }),
    body: {
      content: { "application/json": { schema: TransferBrandRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Transfer completed",
      content: {
        "application/json": { schema: TransferBrandResponseSchema },
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

// --- Org RAG Score ---

export const RAG_SCORE_DOCUMENTS_MAX = 100;

export const RagScoreDocumentSchema = z
  .object({
    id: z.string().min(1, "id is required").openapi({
      description: "Caller-supplied identifier; preserved verbatim in the response.",
      example: "quote-7c2b",
    }),
    text: z.string().min(1, "text is required").openapi({
      description: "Free-form text body to embed and score against the brand profile.",
      example:
        "Looking to interview a B2B SaaS founder about pricing experiments for an upcoming feature.",
    }),
  })
  .strict()
  .openapi("RagScoreDocument");

export const RAG_SCORE_BRAND_IDS_MAX = 5;

export const RagScoreRequestSchema = z
  .object({
    documents: z
      .array(RagScoreDocumentSchema)
      .min(1, "documents must contain at least one item")
      .max(
        RAG_SCORE_DOCUMENTS_MAX,
        `documents may contain at most ${RAG_SCORE_DOCUMENTS_MAX} items`,
      )
      .openapi({
        description: `List of documents to score against the brand profile. At most ${RAG_SCORE_DOCUMENTS_MAX} items per request.`,
      }),
    brandIds: z
      .array(z.string().uuid("each brandIds entry must be a UUID"))
      .min(1, "brandIds must contain at least one item")
      .max(
        RAG_SCORE_BRAND_IDS_MAX,
        `brandIds may contain at most ${RAG_SCORE_BRAND_IDS_MAX} items`,
      )
      .optional()
      .openapi({
        description:
          "Brand IDs whose joint profile is used as the semantic query. Resolved via brand-service " +
          "(industry, expertise, target audience, voice). When more than one is provided, " +
          "brand-service consolidates field values across brands and one embedding is computed " +
          "against the consolidated profile. Preferred over legacy `brandId`.",
        example: [
          "550e8400-e29b-41d4-a716-446655440000",
          "660f9500-f30c-52e5-b827-557766551111",
        ],
      }),
    brandId: z
      .string()
      .uuid("brandId must be a UUID")
      .optional()
      .openapi({
        description:
          "Legacy single-brand field. Equivalent to `brandIds: [brandId]`. When both are provided, " +
          "`brandIds` wins. At least one of `brandIds` / `brandId` is required.",
        example: "550e8400-e29b-41d4-a716-446655440000",
      }),
    query: z.string().min(1).optional().openapi({
      description:
        "Optional override for the brand-profile query string. When omitted, the service " +
        "synthesizes a query from the resolved brand fields.",
    }),
  })
  .strict()
  .refine(
    (data) => data.brandIds !== undefined || data.brandId !== undefined,
    {
      message:
        "Provide either `brandIds: string[]` (preferred) or legacy `brandId: string`.",
      path: ["brandIds"],
    },
  )
  .openapi("RagScoreRequest");

export const RagScoreResultSchema = z
  .object({
    id: z.string().openapi({
      description: "Document id from the request, preserved verbatim.",
    }),
    score: z.number().openapi({
      description:
        "Cosine similarity in [0, 1] between the document embedding and the brand-profile " +
        "embedding. Negative values are clamped to 0.",
    }),
  })
  .openapi("RagScoreResult");

export const RagScoreResponseSchema = z
  .object({
    brandIds: z.array(z.string()).openapi({
      description:
        "Canonical-sorted list of brand IDs used to build the joint brand profile. " +
        "For a single-brand request this is a 1-element array; for multi-brand it is sorted ascending.",
    }),
    brandId: z.string().optional().openapi({
      description:
        "Echo of the legacy `brandId` field. Present only when the request resolved to exactly one brand " +
        "(either via legacy `brandId` or `brandIds: [single]`). Omitted on multi-brand requests.",
    }),
    queryText: z.string().openapi({
      description:
        "The brand-profile query string that was embedded. Useful for debugging and auditing.",
    }),
    cacheHit: z.boolean().openapi({
      description: "Whether the brand-profile embedding was served from cache.",
    }),
    model: z.string().openapi({
      description: "The Gemini embedding model used.",
      example: "gemini-embedding-001",
    }),
    results: z.array(RagScoreResultSchema).openapi({
      description: "Per-document scores, sorted by score descending.",
    }),
  })
  .openapi("RagScoreResponse");

export type RagScoreRequest = z.infer<typeof RagScoreRequestSchema>;
export type RagScoreResponse = z.infer<typeof RagScoreResponseSchema>;

registry.registerPath({
  method: "post",
  path: "/orgs/rag/score",
  tags: ["RAG"],
  summary: "Score documents against a brand profile (semantic similarity)",
  description: `RAG-style semantic similarity scoring for picking the best document(s) for a brand.

Used by journalists-quotes-service to rank quote requests against a brand profile, and by any other consumer that needs cheap document-vs-brand scoring.

**Multi-brand:** accepts \`brandIds: string[]\` (1..${RAG_SCORE_BRAND_IDS_MAX}) for joint scoring across multiple brands. Legacy \`brandId: string\` is still accepted and is equivalent to \`brandIds: [brandId]\`. When both are provided, \`brandIds\` wins. At least one is required. Multi-brand calls compute ONE embedding against the consolidated brand profile (brand-service merges field values across input brands) and ONE score per document.

**Pipeline:**
1. Canonical-sort \`brandIds\` ascending.
2. Resolve consolidated brand context via brand-service (industry, expertise, target audience, voice) in ONE call.
3. Synthesize a brand-profile query string (or use the caller-supplied \`query\`).
4. Compute the brand-profile embedding via Gemini's \`gemini-embedding-001\` (cached per (orgId, sorted(brandIds), contentHash)).
5. Compute embeddings for each \`documents[i].text\` in a single batch call.
6. Score = cosine similarity, sorted descending.

**Caching:** the brand-profile embedding is cached per canonical-sorted brand set + content hash. Same brand set, same resolved fields → cache hit. Different brand set (even subset) → cache miss. The cache automatically invalidates when any resolved brand field changes.

**Volume:** designed for batches up to ${RAG_SCORE_DOCUMENTS_MAX} documents per request, up to ${RAG_SCORE_BRAND_IDS_MAX} brands per joint profile.`,
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
      content: { "application/json": { schema: RagScoreRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Scored results, sorted by score descending",
      content: {
        "application/json": { schema: RagScoreResponseSchema },
      },
    },
    400: {
      description: "Missing or invalid request fields (including documents > cap)",
      content: {
        "application/json": { schema: ValidationErrorResponseSchema },
      },
    },
    401: {
      description: "Missing or invalid x-api-key header",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Brand not found in brand-service",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description:
        "Upstream service unavailable (brand-service, key-service, runs-service, or Gemini)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Org RAG Embed ---

export const RAG_EMBED_DOCUMENTS_MAX = 100;
/**
 * Per-text character cap. Gemini `gemini-embedding-001` accepts up to ~2048
 * input tokens per text; ~4 chars/token gives an 8000-char proxy that keeps
 * us safely under the provider limit without pulling in a tokenizer.
 */
export const RAG_EMBED_TEXT_MAX_CHARS = 8000;

export const RagEmbedDocumentSchema = z
  .object({
    id: z.string().min(1, "id is required").openapi({
      description: "Caller-supplied identifier; preserved verbatim in the response.",
      example: "quote-7c2b",
    }),
    text: z
      .string()
      .min(1, "text is required")
      .max(
        RAG_EMBED_TEXT_MAX_CHARS,
        `text may be at most ${RAG_EMBED_TEXT_MAX_CHARS} characters`,
      )
      .openapi({
        description: `Free-form text body to embed. Max ${RAG_EMBED_TEXT_MAX_CHARS} characters (matches Gemini gemini-embedding-001's ~2048-token input limit).`,
        example: "Looking to interview a B2B SaaS founder about pricing experiments.",
      }),
  })
  .strict()
  .openapi("RagEmbedDocument");

export const RagEmbedRequestSchema = z
  .object({
    documents: z
      .array(RagEmbedDocumentSchema)
      .min(1, "documents must contain at least one item")
      .max(
        RAG_EMBED_DOCUMENTS_MAX,
        `documents may contain at most ${RAG_EMBED_DOCUMENTS_MAX} items`,
      )
      .openapi({
        description: `List of texts to embed. At most ${RAG_EMBED_DOCUMENTS_MAX} items per request, ${RAG_EMBED_TEXT_MAX_CHARS} characters per text.`,
      }),
  })
  .strict()
  .openapi("RagEmbedRequest");

export const RagEmbedResultSchema = z
  .object({
    id: z.string().openapi({
      description: "Document id from the request, preserved verbatim.",
    }),
    embedding: z.array(z.number()).openapi({
      description:
        "Raw embedding vector for the document text. Length is the embedding model's output dimensionality (3072 for gemini-embedding-001).",
    }),
  })
  .openapi("RagEmbedResult");

export const RagEmbedResponseSchema = z
  .object({
    model: z.string().openapi({
      description: "The Gemini embedding model used.",
      example: "gemini-embedding-001",
    }),
    results: z.array(RagEmbedResultSchema).openapi({
      description:
        "Per-document embeddings, returned in the same order as the input documents (1:1 by index and id).",
    }),
  })
  .openapi("RagEmbedResponse");

export type RagEmbedRequest = z.infer<typeof RagEmbedRequestSchema>;
export type RagEmbedResponse = z.infer<typeof RagEmbedResponseSchema>;

registry.registerPath({
  method: "post",
  path: "/orgs/rag/embed",
  tags: ["RAG"],
  summary: "Compute raw embeddings for a batch of texts",
  description: `Returns raw embedding vectors for a batch of texts. Used by callers that need to run their own similarity, clustering, or dedup logic.

Backed by the same Gemini \`gemini-embedding-001\` model as \`/orgs/rag/score\` — single source of truth for embedding model selection across chat-service.

**Pipeline:**
1. Resolve the org's Google API key via key-service.
2. Call Gemini \`batchEmbedContents\` for all \`documents[i].text\` in a single batch.
3. Return per-document vectors in input order, with \`id\` preserved verbatim.

**No vector storage, no similarity scoring.** Callers persist and compare vectors themselves. For document-vs-brand semantic scoring use \`POST /orgs/rag/score\` instead.

**Limits:** at most ${RAG_EMBED_DOCUMENTS_MAX} documents per request, at most ${RAG_EMBED_TEXT_MAX_CHARS} characters per text (matches Gemini's ~2048-token input limit).`,
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
      content: { "application/json": { schema: RagEmbedRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Raw embeddings, one per input document, in input order",
      content: {
        "application/json": { schema: RagEmbedResponseSchema },
      },
    },
    400: {
      description:
        "Missing or invalid request fields (including documents > cap or text > char cap)",
      content: {
        "application/json": { schema: ValidationErrorResponseSchema },
      },
    },
    401: {
      description: "Missing or invalid x-api-key header",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description:
        "Upstream service unavailable (key-service, runs-service, or Gemini)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
