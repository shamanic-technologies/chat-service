import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-sonnet-4-6";
/** Cost-name prefix used by costs-service: {provider}-{model} */
export const COST_PREFIX = "anthropic-sonnet-4.6";
const MAX_TOKENS = 64_000;

// ---------------------------------------------------------------------------
// Provider + model alias → versioned API model ID + cost prefix
// Callers specify version-free aliases (e.g. "sonnet"); the service resolves
// the latest versioned model ID internally.
// ---------------------------------------------------------------------------

export type Provider = "anthropic" | "google";
export type ModelAlias = "haiku" | "sonnet" | "opus" | "flash-lite" | "flash" | "pro";

interface ResolvedModel {
  /** Versioned model ID sent to the provider's API */
  apiModelId: string;
  /** Cost-name prefix for costs-service */
  costPrefix: string;
  /** Provider key used for key-service resolution */
  provider: "anthropic" | "google";
}

const MODEL_MAP: Record<string, Record<string, ResolvedModel>> = {
  anthropic: {
    haiku: { apiModelId: "claude-haiku-4-5", costPrefix: "anthropic-haiku-4.5", provider: "anthropic" },
    sonnet: { apiModelId: "claude-sonnet-4-6", costPrefix: "anthropic-sonnet-4.6", provider: "anthropic" },
    opus: { apiModelId: "claude-opus-4-6", costPrefix: "anthropic-opus-4.6", provider: "anthropic" },
  },
  google: {
    "flash-lite": { apiModelId: "gemini-3.1-flash-lite-preview", costPrefix: "google-flash-lite-3.1", provider: "google" },
    "flash": { apiModelId: "gemini-3-flash-preview", costPrefix: "google-flash-3", provider: "google" },
    "pro": { apiModelId: "gemini-3.1-pro-preview", costPrefix: "google-pro-3.1", provider: "google" },
  },
};

/** Valid model aliases per provider — used for Zod validation. */
export const PROVIDER_MODELS: Record<Provider, readonly ModelAlias[]> = {
  anthropic: ["haiku", "sonnet", "opus"],
  google: ["flash-lite", "flash", "pro"],
};

/**
 * Resolve a (provider, model alias) pair to the versioned API model ID,
 * cost prefix, and provider string.
 * Throws if the combination is invalid.
 */
export function resolveModel(provider: Provider, modelAlias: ModelAlias): ResolvedModel {
  const providerMap = MODEL_MAP[provider];
  if (!providerMap) throw new Error(`Unknown provider: ${provider}`);
  const resolved = providerMap[modelAlias];
  if (!resolved) throw new Error(`Unknown model "${modelAlias}" for provider "${provider}"`);
  return resolved;
}

/**
 * @deprecated — kept for backward compat during migration. Use resolveModel instead.
 */
export const SUPPORTED_MODELS: Record<string, string> = {
  "claude-sonnet-4-6": "anthropic-sonnet-4.6",
  "claude-haiku-4-5": "anthropic-haiku-4.5",
  "claude-opus-4-6": "anthropic-opus-4.6",
  "gemini-3.1-flash-lite-preview": "google-flash-lite-3.1",
  "gemini-3-flash-preview": "google-flash-3",
  "gemini-3.1-pro-preview": "google-pro-3.1",
};

/** Resolve the cost prefix for a given model ID (falls back to default). */
export function costPrefixForModel(model: string): string {
  return SUPPORTED_MODELS[model] ?? COST_PREFIX;
}

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic JSON Schema format)
// ---------------------------------------------------------------------------

export const REQUEST_USER_INPUT_TOOL: Anthropic.Tool = {
  name: "request_user_input",
  description:
    "Ask the user for structured input via a frontend widget. ONLY use this when you genuinely need information that you do not already have — check your context and conversation history first. NEVER use this for confirmations, yes/no questions, or to echo back values the user already provided. If the user confirms an action (e.g. says 'yes' or 'go ahead'), execute the action directly using the appropriate tool instead of sending another form.",
  input_schema: {
    type: "object" as const,
    properties: {
      input_type: {
        type: "string",
        description: "The type of input widget to render: url, text, or email",
      },
      label: {
        type: "string",
        description: "The label/question shown above the input field",
      },
      placeholder: {
        type: "string",
        description: "Placeholder text inside the input field",
      },
      field: {
        type: "string",
        description:
          "A key identifying what this input is for, e.g. brand_url",
      },
      value: {
        type: "string",
        description:
          "Optional pre-filled value for the input field. When you already have a suggested value (e.g. a description you generated), set this so the user only has to confirm. Omit to leave the field empty.",
      },
    },
    required: ["input_type", "label", "field"],
  },
};

export const UPDATE_WORKFLOW_TOOL: Anthropic.Tool = {
  name: "update_workflow",
  description:
    "Update a workflow's metadata (name, description, tags) and/or its DAG structure. Use this to directly modify a workflow when the user asks — do not use input_request to confirm values you already know. For structural changes (adding/removing nodes or edges), pass the full dag object.",
  input_schema: {
    type: "object" as const,
    properties: {
      workflowId: {
        type: "string",
        description:
          "UUID of the workflow to update. If available in context, use it directly — do NOT ask the user for it.",
      },
      name: {
        type: "string",
        description: "New workflow name (optional)",
      },
      description: {
        type: "string",
        description: "New workflow description (optional)",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "New tags for the workflow (optional)",
      },
      dag: {
        type: "object",
        description:
          "Full DAG definition with nodes and edges. Use for structural changes like adding/removing nodes or edges. Must include the complete DAG — partial updates are not supported. Use get_workflow_details first to read the current DAG, then modify and pass the full result.",
      },
    },
    required: ["workflowId"],
  },
};

export const VALIDATE_WORKFLOW_TOOL: Anthropic.Tool = {
  name: "validate_workflow",
  description:
    "Validate a workflow's DAG structure. Returns whether the workflow is valid and any errors found. Use this when the user asks to check or validate a workflow.",
  input_schema: {
    type: "object" as const,
    properties: {
      workflowId: {
        type: "string",
        description:
          "UUID of the workflow to validate. If available in context, use it directly — do NOT ask the user for it.",
      },
    },
    required: ["workflowId"],
  },
};

export const GET_PROMPT_TEMPLATE_TOOL: Anthropic.Tool = {
  name: "get_prompt_template",
  description:
    "Retrieve a stored prompt template by type from the content-generation service. Use this when the user asks to see, review, or check a prompt template (e.g. cold-email, follow-up).",
  input_schema: {
    type: "object" as const,
    properties: {
      type: {
        type: "string",
        description:
          "The prompt type to look up (e.g. 'cold-email', 'follow-up', 'sales-email')",
      },
    },
    required: ["type"],
  },
};

export const UPDATE_PROMPT_TEMPLATE_TOOL: Anthropic.Tool = {
  name: "update_prompt_template",
  description:
    "Create a new version of an existing prompt template. The original is never modified — a new version is created automatically (e.g. 'cold-email' → 'cold-email-v2'). Use this when the user wants to update, improve, or modify a prompt template.",
  input_schema: {
    type: "object" as const,
    properties: {
      sourceType: {
        type: "string",
        description:
          "The type of the existing prompt to version from (e.g. 'cold-email')",
      },
      prompt: {
        type: "string",
        description:
          "The new prompt template text with {{variable}} placeholders. Must NOT contain company-specific data — only {{variables}}.",
      },
      variables: {
        type: "array",
        items: { type: "string" },
        description:
          "List of variable names used in the prompt (e.g. ['leadFirstName', 'leadCompanyName'])",
      },
    },
    required: ["sourceType", "prompt", "variables"],
  },
};

export const UPDATE_WORKFLOW_NODE_CONFIG_TOOL: Anthropic.Tool = {
  name: "update_workflow_node_config",
  description:
    "Update the static config of a specific node in a workflow's DAG. Fetches the current DAG, merges your config changes into the target node, and saves. Use this to change node parameters like prompt type, target URL, call-to-action, etc.",
  input_schema: {
    type: "object" as const,
    properties: {
      workflowId: {
        type: "string",
        description:
          "UUID of the workflow to update. If available in context, use it directly.",
      },
      nodeId: {
        type: "string",
        description:
          "ID of the node to update (e.g. 'email-generate', 'email-send')",
      },
      configUpdates: {
        type: "object",
        description:
          'Key-value pairs to merge into the node\'s config. Only specified keys are changed; others are preserved. Example: {"body": {"type": "cold-email-v3"}}',
      },
    },
    required: ["workflowId", "nodeId", "configUpdates"],
  },
};

// ---------------------------------------------------------------------------
// API Registry progressive disclosure tools
// ---------------------------------------------------------------------------

export const LIST_SERVICES_TOOL: Anthropic.Tool = {
  name: "list_services",
  description:
    "List all available microservices with their name, description, and endpoint count. START HERE for service discovery. Then use list_service_endpoints to drill into a specific service, and call_api to invoke an endpoint.",
  input_schema: {
    type: "object" as const,
    properties: {},
  },
};

export const LIST_SERVICE_ENDPOINTS_TOOL: Anthropic.Tool = {
  name: "list_service_endpoints",
  description:
    "List all endpoints for a specific service (method, path, summary). Use after list_services to explore a service. Then use call_api to invoke a specific endpoint.",
  input_schema: {
    type: "object" as const,
    properties: {
      service: {
        type: "string",
        description:
          "Service name from list_services (e.g. 'brand', 'features', 'workflow')",
      },
    },
    required: ["service"],
  },
};

// call_api tool removed — security risk (unrestricted admin-key access to all services)

// ---------------------------------------------------------------------------
// Key-service read tools
// ---------------------------------------------------------------------------

export const LIST_ORG_KEYS_TOOL: Anthropic.Tool = {
  name: "list_org_keys",
  description:
    "List all API keys configured for the current organization. Returns provider names and masked keys (never the actual secret). Use this to check if an org has the required keys configured before running a workflow.",
  input_schema: {
    type: "object" as const,
    properties: {},
  },
};

export const GET_KEY_SOURCE_TOOL: Anthropic.Tool = {
  name: "get_key_source",
  description:
    "Get the key source preference for a specific provider. Returns whether the org uses its own key ('org') or the platform key ('platform'). If no explicit preference is set, returns 'platform' with isDefault=true.",
  input_schema: {
    type: "object" as const,
    properties: {
      provider: {
        type: "string",
        description:
          "Provider name (e.g. 'anthropic', 'openai', 'stripe', 'instantly')",
      },
    },
    required: ["provider"],
  },
};

export const LIST_KEY_SOURCES_TOOL: Anthropic.Tool = {
  name: "list_key_sources",
  description:
    "List all key source preferences for the current org. Shows which providers use org keys vs platform keys. Providers not listed default to 'platform'.",
  input_schema: {
    type: "object" as const,
    properties: {},
  },
};

export const CHECK_PROVIDER_REQUIREMENTS_TOOL: Anthropic.Tool = {
  name: "check_provider_requirements",
  description:
    "Query which third-party API providers are needed to call a set of service endpoints. Given a list of endpoints (service + method + path), returns which providers each endpoint requires. Use this to determine what keys the org needs before executing a workflow or calling multiple services.",
  input_schema: {
    type: "object" as const,
    properties: {
      endpoints: {
        type: "array",
        items: {
          type: "object",
          properties: {
            service: { type: "string", description: "Service name (e.g. 'chat')" },
            method: { type: "string", description: "HTTP method (e.g. 'POST')" },
            path: { type: "string", description: "Endpoint path (e.g. '/complete')" },
          },
          required: ["service", "method", "path"],
        },
        description: "List of endpoints to check requirements for",
      },
    },
    required: ["endpoints"],
  },
};

export const GET_WORKFLOW_DETAILS_TOOL: Anthropic.Tool = {
  name: "get_workflow_details",
  description:
    "Fetch the full details of a workflow including its DAG, metadata, and status. Use this to inspect the current state of a workflow, especially after making changes via update_workflow or update_workflow_node_config.",
  input_schema: {
    type: "object" as const,
    properties: {
      workflowId: {
        type: "string",
        description:
          "UUID of the workflow to fetch. If available in context, use it directly — do NOT ask the user for it.",
      },
    },
    required: ["workflowId"],
  },
};

export const GENERATE_WORKFLOW_TOOL: Anthropic.Tool = {
  name: "generate_workflow",
  description:
    "Generate a new workflow from a natural language description. Uses an LLM to create a valid DAG, validates it, and deploys it automatically. Use this when the user wants to create a brand new workflow from scratch.",
  input_schema: {
    type: "object" as const,
    properties: {
      description: {
        type: "string",
        description:
          "Natural language description of the desired workflow. Be specific about the steps, services, and data flow. Minimum 10 characters.",
      },
      featureSlug: {
        type: "string",
        description:
          "Feature slug from features-service (e.g. 'cold-email-outreach'). Required — used to build the workflow slug.",
      },
      hints: {
        type: "object",
        description:
          "Optional hints to guide generation. Can include: services (array of service names to scope to), nodeTypes (suggested node types), expectedInputs (expected flow_input field names like 'campaignId').",
      },
      style: {
        type: "object",
        description:
          "Optional style configuration. When provided, the workflow is generated in the style of the specified human or brand, and the signatureName uses the style name with auto-versioning (e.g. 'hormozi-v1').",
        properties: {
          type: {
            type: "string",
            enum: ["human", "brand"],
            description: "Style source type. 'human' for an industry expert, 'brand' for a company/organization.",
          },
          humanId: {
            type: "string",
            description: "Human ID from human-service. Required when type is 'human'.",
          },
          brandId: {
            type: "string",
            description: "Brand ID from brand-service. Required when type is 'brand'.",
          },
          name: {
            type: "string",
            description: "Display name of the human or brand (e.g. 'Hormozi'). Used to build the signatureName.",
          },
        },
        required: ["type", "name"],
      },
    },
    required: ["description", "featureSlug"],
  },
};

export const GET_WORKFLOW_REQUIRED_PROVIDERS_TOOL: Anthropic.Tool = {
  name: "get_workflow_required_providers",
  description:
    "Get the BYOK (Bring Your Own Key) providers required to execute a workflow. Returns which external API keys the user needs to configure before running the workflow (e.g. Stripe, Anthropic). Use this proactively to warn users about missing keys before they try to execute.",
  input_schema: {
    type: "object" as const,
    properties: {
      workflowId: {
        type: "string",
        description:
          "UUID of the workflow. If available in context, use it directly — do NOT ask the user for it.",
      },
    },
    required: ["workflowId"],
  },
};

export const LIST_WORKFLOWS_TOOL: Anthropic.Tool = {
  name: "list_workflows",
  description:
    "List existing workflows with optional filters. Use this when the user asks to see their workflows, find a specific workflow, or check if a workflow already exists for a given purpose.",
  input_schema: {
    type: "object" as const,
    properties: {
      featureSlug: {
        type: "string",
        description: "Filter by feature slug (e.g. 'cold-email-outreach')",
      },
      category: {
        type: "string",
        enum: ["sales", "pr", "outlets", "journalists"],
        description: "Filter by category (optional)",
      },
      channel: {
        type: "string",
        enum: ["email", "database"],
        description: "Filter by channel (optional)",
      },
      audienceType: {
        type: "string",
        enum: ["cold-outreach", "discovery"],
        description: "Filter by audience type (optional)",
      },
      tag: {
        type: "string",
        description: "Filter workflows that contain this tag (optional)",
      },
      status: {
        type: "string",
        description: "Filter by status. Defaults to 'active'. Use 'all' to include deprecated workflows (optional)",
      },
      brandId: {
        type: "string",
        description: "Filter by brand ID (optional)",
      },
      humanId: {
        type: "string",
        description: "Filter by human ID (optional)",
      },
      campaignId: {
        type: "string",
        description: "Filter by campaign ID (optional)",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Feature-creator tools (available only when context.type === "feature-creator")
// ---------------------------------------------------------------------------

const featureInputItems = {
  type: "object" as const,
  properties: {
    key: { type: "string", description: "Machine-readable input key (e.g. 'targetCompanyUrl')" },
    label: { type: "string", description: "Human-readable label (e.g. 'Target Company URL')" },
    type: { type: "string", enum: ["text", "textarea", "number", "select"], description: "Input field type" },
    placeholder: { type: "string", description: "Placeholder text shown in the input (e.g. 'https://example.com')" },
    description: { type: "string", description: "What this input is for" },
    extractKey: { type: "string", description: "Key used to extract this value from enrichment data (e.g. 'company_url')" },
    options: { type: "array", items: { type: "string" }, description: "Options for select-type inputs (only when type is 'select')" },
  },
  required: ["key", "label", "type", "placeholder", "description", "extractKey"],
};

const featureOutputItems = {
  type: "object" as const,
  properties: {
    key: { type: "string", description: "Stats registry key (e.g. 'emailsSent'). Must reference a valid key from GET /stats/registry." },
    displayOrder: { type: "integer", description: "Order in which this output appears in the UI (0-based)" },
    defaultSort: { type: "boolean", description: "Whether this output is the default sort column (optional)" },
    sortDirection: { type: "string", enum: ["asc", "desc"], description: "Sort direction when this is the default sort column (optional)" },
  },
  required: ["key", "displayOrder"],
};

export const CREATE_FEATURE_TOOL: Anthropic.Tool = {
  name: "create_feature",
  description:
    "Create a new feature definition in the features catalogue. Use this when the user has finished designing a feature and wants to save it. Always confirm the feature details with the user before calling this tool. Returns 409 if the slug or name already exists.",
  input_schema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description:
          "URL-friendly identifier for the feature (e.g. 'cold-email-outreach'). Use lowercase kebab-case. Optional — auto-generated from name if omitted.",
      },
      name: {
        type: "string",
        description: "Machine-readable feature name (e.g. 'Cold Email Outreach'). This becomes the unique identifier — for forked features it may include a version suffix (e.g. 'Cold Email Outreach v2'). The human-readable displayName is derived from this automatically.",
      },
      description: {
        type: "string",
        description: "Brief description of what the feature does",
      },
      icon: {
        type: "string",
        description: "Icon identifier for the feature (e.g. 'mail', 'linkedin', 'phone')",
      },
      category: {
        type: "string",
        description: "Feature category (e.g. 'sales', 'pr', 'marketing')",
      },
      channel: {
        type: "string",
        description: "Communication channel (e.g. 'email', 'linkedin', 'phone')",
      },
      audienceType: {
        type: "string",
        description: "Target audience type (e.g. 'cold-outreach', 'warm-leads', 'existing-customers')",
      },
      implemented: {
        type: "boolean",
        description: "Whether this feature is implemented and ready for use (default: true)",
      },
      displayOrder: {
        type: "integer",
        description: "Display order in the feature catalogue (default: 0)",
      },
      status: {
        type: "string",
        enum: ["active", "draft", "deprecated"],
        description: "Feature lifecycle status (default: 'active')",
      },
      inputs: {
        type: "array",
        items: featureInputItems,
        description: "Input fields the user must provide to run this feature (min 1)",
      },
      outputs: {
        type: "array",
        items: featureOutputItems,
        description: "Output metrics the feature produces (min 1)",
      },
      charts: {
        type: "array",
        description: "Chart definitions for the feature dashboard. At least one chart required. Two types: funnel-bar (sequential conversion steps, min 2 steps) and breakdown-bar (categorical segments, min 2 segments).",
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                key: { type: "string", description: "Unique chart key (e.g. 'outreach-funnel')" },
                type: { type: "string", enum: ["funnel-bar"], description: "Funnel bar chart — shows conversion through sequential steps" },
                title: { type: "string", description: "Chart title (e.g. 'Outreach Funnel')" },
                displayOrder: { type: "integer", description: "Order in which the chart appears (0-based)" },
                steps: {
                  type: "array",
                  description: "Funnel steps — each key must reference an output key. Min 2 steps.",
                  minItems: 2,
                  items: {
                    type: "object",
                    properties: { key: { type: "string", description: "Output key this step represents" } },
                    required: ["key"],
                  },
                },
              },
              required: ["key", "type", "title", "displayOrder", "steps"],
            },
            {
              type: "object",
              properties: {
                key: { type: "string", description: "Unique chart key (e.g. 'reply-sentiment')" },
                type: { type: "string", enum: ["breakdown-bar"], description: "Breakdown bar chart — shows categorical distribution" },
                title: { type: "string", description: "Chart title (e.g. 'Reply Sentiment')" },
                displayOrder: { type: "integer", description: "Order in which the chart appears (0-based)" },
                segments: {
                  type: "array",
                  description: "Breakdown segments — each key must reference an output key. Min 2 segments.",
                  minItems: 2,
                  items: {
                    type: "object",
                    properties: {
                      key: { type: "string", description: "Output key this segment represents" },
                      color: { type: "string", enum: ["green", "blue", "red", "gray", "orange"], description: "Segment color" },
                      sentiment: { type: "string", enum: ["positive", "neutral", "negative"], description: "Sentiment category" },
                    },
                    required: ["key", "color", "sentiment"],
                  },
                },
              },
              required: ["key", "type", "title", "displayOrder", "segments"],
            },
          ],
        },
      },
      entities: {
        type: "array",
        description: "Entity types shown in campaign detail sidebar (e.g. ['leads', 'companies', 'emails']). At least one required.",
        items: { type: "string" },
        minItems: 1,
      },
    },
    required: ["name", "description", "icon", "category", "channel", "audienceType", "inputs", "outputs", "charts", "entities"],
  },
};

export const UPDATE_FEATURE_TOOL: Anthropic.Tool = {
  name: "update_feature",
  description:
    "Update an existing feature definition by slug (fork-on-write). Only provided fields are modified — omit fields you don't want to change. If only metadata changes (same signature), the feature is updated in-place. If inputs or outputs change (different signature), a NEW feature is created (forked) with a version suffix, the original is deprecated, and the fork inherits the original's displayName. The response includes a 'forked' boolean indicating which happened.",
  input_schema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description: "The slug of the feature to update.",
      },
      name: { type: "string", description: "New feature name (optional)" },
      description: { type: "string", description: "New feature description (optional)" },
      icon: { type: "string", description: "New icon identifier (optional)" },
      category: { type: "string", description: "New category (optional)" },
      channel: { type: "string", description: "New channel (optional)" },
      audienceType: { type: "string", description: "New audience type (optional)" },
      implemented: { type: "boolean", description: "Whether this feature is implemented (optional)" },
      displayOrder: { type: "integer", description: "New display order (optional)" },
      status: { type: "string", enum: ["active", "draft", "deprecated"], description: "New status (optional)" },
      inputs: {
        type: "array",
        items: featureInputItems,
        description: "New input fields (replaces all existing inputs)",
      },
      outputs: {
        type: "array",
        items: featureOutputItems,
        description: "New output fields (replaces all existing outputs)",
      },
      charts: {
        type: "array",
        description: "New chart definitions (replaces all existing charts). Two types: funnel-bar and breakdown-bar.",
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                key: { type: "string" },
                type: { type: "string", enum: ["funnel-bar"] },
                title: { type: "string" },
                displayOrder: { type: "integer" },
                steps: {
                  type: "array",
                  minItems: 2,
                  items: {
                    type: "object",
                    properties: { key: { type: "string" } },
                    required: ["key"],
                  },
                },
              },
              required: ["key", "type", "title", "displayOrder", "steps"],
            },
            {
              type: "object",
              properties: {
                key: { type: "string" },
                type: { type: "string", enum: ["breakdown-bar"] },
                title: { type: "string" },
                displayOrder: { type: "integer" },
                segments: {
                  type: "array",
                  minItems: 2,
                  items: {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      color: { type: "string", enum: ["green", "blue", "red", "gray", "orange"] },
                      sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
                    },
                    required: ["key", "color", "sentiment"],
                  },
                },
              },
              required: ["key", "type", "title", "displayOrder", "segments"],
            },
          ],
        },
      },
      entities: {
        type: "array",
        description: "New entity types (replaces all existing entities)",
        items: { type: "string" },
      },
    },
    required: ["slug"],
  },
};

export const LIST_FEATURES_TOOL: Anthropic.Tool = {
  name: "list_features",
  description:
    "List features from the catalogue with optional filters. Use this to browse existing features, check for duplicates before creating, or find features by category/channel. The dashboard also sends features in context, but this tool fetches the latest from the database.",
  input_schema: {
    type: "object" as const,
    properties: {
      category: { type: "string", description: "Filter by category (e.g. 'sales', 'pr')" },
      channel: { type: "string", description: "Filter by channel (e.g. 'email', 'linkedin')" },
      audienceType: { type: "string", description: "Filter by audience type" },
      status: { type: "string", description: "Filter by status (e.g. 'active', 'draft')" },
      implemented: { type: "string", description: "Filter by implementation status ('true' or 'false')" },
    },
  },
};

export const GET_FEATURE_TOOL: Anthropic.Tool = {
  name: "get_feature",
  description:
    "Get full details of a single feature by its slug. Use this to inspect inputs, outputs, and metadata of an existing feature.",
  input_schema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description: "The feature slug to look up. If available in context, use it directly.",
      },
    },
    required: ["slug"],
  },
};

export const GET_FEATURE_INPUTS_TOOL: Anthropic.Tool = {
  name: "get_feature_inputs",
  description:
    "Get the input field definitions for a feature by slug. Returns the list of inputs the user must provide to run this feature. Lighter than get_feature — use when you only need the input schema.",
  input_schema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description: "The feature slug to look up inputs for.",
      },
    },
    required: ["slug"],
  },
};

export const PREFILL_FEATURE_TOOL: Anthropic.Tool = {
  name: "prefill_feature",
  description:
    "Pre-fill input values for a feature using the org's brand data. Returns a map of input key → suggested text value (or null if extraction failed). Use this to auto-populate form fields before the user reviews and submits.",
  input_schema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description: "The feature slug to pre-fill inputs for.",
      },
    },
    required: ["slug"],
  },
};

export const GET_FEATURE_STATS_TOOL: Anthropic.Tool = {
  name: "get_feature_stats",
  description:
    "Get computed stats for a feature — cost, run counts, campaign counts, and per-output metrics. Optionally group by workflowSlug, brandId, or campaignId. System stats (cost, runs, campaigns, dates) are always included.",
  input_schema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description: "The feature slug to get stats for.",
      },
      groupBy: {
        type: "string",
        enum: ["workflowSlug", "brandId", "campaignId"],
        description: "Group stats by this dimension (optional).",
      },
      brandId: {
        type: "string",
        description: "Filter stats to a specific brand (optional).",
      },
      campaignId: {
        type: "string",
        description: "Filter stats to a specific campaign (optional).",
      },
      workflowSlug: {
        type: "string",
        description: "Filter stats to a specific workflow (optional).",
      },
    },
    required: ["slug"],
  },
};

// ---------------------------------------------------------------------------
// Campaign-prefill tools
// ---------------------------------------------------------------------------

export const UPDATE_CAMPAIGN_FIELDS_TOOL: Anthropic.Tool = {
  name: "update_campaign_fields",
  description:
    "Update campaign form fields. Returns the fields object as-is so the frontend can apply the values to the form. Use this to pre-fill or modify campaign creation fields based on the conversation.",
  input_schema: {
    type: "object" as const,
    properties: {
      fields: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Key-value map of campaign form fields to update. Keys are field names, values are the new string values.",
      },
    },
    required: ["fields"],
  },
};

export const EXTRACT_BRAND_FIELDS_TOOL: Anthropic.Tool = {
  name: "extract_brand_fields",
  description:
    "Extract arbitrary fields from the brand's website using AI. Uses the brand(s) from the x-brand-id header (no brandId parameter needed). Wraps brand-service extract-fields endpoint. Results are cached 30 days per field — safe to call repeatedly.",
  input_schema: {
    type: "object" as const,
    properties: {
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "Machine-readable key for the field (e.g. 'industry', 'target_audience').",
            },
            description: {
              type: "string",
              description: "Human-readable description of what to extract (e.g. 'The brand\\'s primary industry vertical').",
            },
          },
          required: ["key", "description"],
        },
        description: "List of fields to extract. Each field has a key and a description.",
      },
    },
    required: ["fields"],
  },
};

export const EXTRACT_BRAND_TEXT_TOOL: Anthropic.Tool = {
  name: "extract_brand_text",
  description:
    "Extract the full text content from a brand's public website pages. Returns the raw text of all scraped pages. Use this to read the brand's site content for analysis or to inform campaign creation.",
  input_schema: {
    type: "object" as const,
    properties: {
      brandId: {
        type: "string",
        description: "UUID of the brand whose website text to extract.",
      },
    },
    required: ["brandId"],
  },
};

// ---------------------------------------------------------------------------
// Tool registry — every tool the service knows how to execute.
// Clients choose which subset to enable via allowedTools in their config.
// ---------------------------------------------------------------------------

export const TOOL_REGISTRY: Record<string, Anthropic.Tool> = {
  request_user_input: REQUEST_USER_INPUT_TOOL,
  update_workflow: UPDATE_WORKFLOW_TOOL,
  validate_workflow: VALIDATE_WORKFLOW_TOOL,
  get_prompt_template: GET_PROMPT_TEMPLATE_TOOL,
  update_prompt_template: UPDATE_PROMPT_TEMPLATE_TOOL,
  update_workflow_node_config: UPDATE_WORKFLOW_NODE_CONFIG_TOOL,
  get_workflow_details: GET_WORKFLOW_DETAILS_TOOL,
  generate_workflow: GENERATE_WORKFLOW_TOOL,
  get_workflow_required_providers: GET_WORKFLOW_REQUIRED_PROVIDERS_TOOL,
  list_workflows: LIST_WORKFLOWS_TOOL,
  list_services: LIST_SERVICES_TOOL,
  list_service_endpoints: LIST_SERVICE_ENDPOINTS_TOOL,
  list_org_keys: LIST_ORG_KEYS_TOOL,
  get_key_source: GET_KEY_SOURCE_TOOL,
  list_key_sources: LIST_KEY_SOURCES_TOOL,
  check_provider_requirements: CHECK_PROVIDER_REQUIREMENTS_TOOL,
  create_feature: CREATE_FEATURE_TOOL,
  update_feature: UPDATE_FEATURE_TOOL,
  list_features: LIST_FEATURES_TOOL,
  get_feature: GET_FEATURE_TOOL,
  get_feature_inputs: GET_FEATURE_INPUTS_TOOL,
  prefill_feature: PREFILL_FEATURE_TOOL,
  get_feature_stats: GET_FEATURE_STATS_TOOL,
  update_campaign_fields: UPDATE_CAMPAIGN_FIELDS_TOOL,
  extract_brand_fields: EXTRACT_BRAND_FIELDS_TOOL,
  extract_brand_text: EXTRACT_BRAND_TEXT_TOOL,
};

/** All tool names available for use in allowedTools config. */
export const AVAILABLE_TOOL_NAMES = Object.keys(TOOL_REGISTRY);

/**
 * Resolve a list of tool names to their Anthropic tool definitions.
 * Ignores unknown names (logs a warning).
 */
export function resolveToolSet(allowedTools: string[]): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  for (const name of allowedTools) {
    const tool = TOOL_REGISTRY[name];
    if (tool) {
      tools.push(tool);
    } else {
      console.warn(`[chat-service] Unknown tool in allowedTools: "${name}" — skipping`);
    }
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface UsageMetadata {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

export function buildSystemPrompt(
  basePrompt: string,
  context?: Record<string, unknown>,
  campaignContext?: Record<string, unknown> | null,
): string {
  let prompt = basePrompt;

  if (campaignContext && Object.keys(campaignContext).length > 0) {
    prompt += [
      `\n\n---\n## Campaign Context`,
      `The user launched this campaign with the following inputs. Use them to inform your responses, suggestions, and any content you generate.`,
      JSON.stringify(campaignContext, null, 2),
    ].join("\n");
  }

  if (context && Object.keys(context).length > 0) {
    prompt += [
      `\n\n---\n## Additional Context (this request only)`,
      JSON.stringify(context, null, 2),
    ].join("\n");
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export interface AnthropicOptions {
  apiKey: string;
  systemPrompt: string;
}

export function createAnthropicClient({ apiKey, systemPrompt }: AnthropicOptions) {
  const client = new Anthropic({ apiKey });

  return {
    model: MODEL,

    /**
     * Create a streaming request to Claude with compaction and context management.
     * Returns a MessageStream that is async-iterable and provides .finalMessage().
     */
    createStream(
      messages: Anthropic.MessageParam[],
      tools?: Anthropic.Tool[],
      signal?: AbortSignal,
    ) {
      // Build params with beta context management for compaction
      const params = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: "text" as const,
            text: systemPrompt,
            cache_control: { type: "ephemeral" as const },
          },
        ],
        messages,
        tools: tools && tools.length > 0 ? tools : undefined,
        thinking: { type: "adaptive" as const },
        // Beta: context management for automatic compaction
        context_management: {
          edits: [
            {
              type: "clear_thinking_20251015",
              keep: { type: "thinking_turns", value: 2 },
            },
            {
              type: "compact_20260112",
              trigger: { type: "input_tokens", value: 100_000 },
              pause_after_compaction: false,
            },
            {
              type: "clear_tool_uses_20250919",
              trigger: { type: "input_tokens", value: 50_000 },
              keep: { type: "tool_uses", value: 5 },
              exclude_tools: ["request_user_input"],
              clear_tool_inputs: false,
            },
          ],
        },
      };

      return client.messages.stream(
        params as unknown as Anthropic.MessageCreateParamsStreaming,
        {
          signal,
          headers: {
            "anthropic-beta": "compact-2026-01-12,context-management-2025-06-27",
          },
        },
      );
    },

    /**
     * Non-streaming completion — single request/response.
     * Used by POST /complete for service-to-service calls.
     */
    async complete(
      message: string,
      options?: {
        responseFormat?: "json";
        temperature?: number;
        maxTokens?: number;
        model?: string;
        imageUrl?: string;
        thinkingBudget?: number;
      },
    ): Promise<{
      content: string;
      tokensInput: number;
      tokensOutput: number;
      model: string;
    }> {
      const effectiveModel = options?.model ?? MODEL;

      // Build user content — multimodal when imageUrl is provided
      let userContent: Anthropic.MessageCreateParamsNonStreaming["messages"][0]["content"];
      if (options?.imageUrl) {
        userContent = [
          {
            type: "image",
            source: { type: "url", url: options.imageUrl },
          },
          { type: "text", text: message },
        ];
      } else {
        userContent = message;
      }

      const thinkingEnabled = (options?.thinkingBudget ?? 0) > 0;

      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: effectiveModel,
        max_tokens: options?.maxTokens ?? MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
        // When thinking is enabled, Anthropic forces temperature to 1
        ...(thinkingEnabled
          ? {}
          : options?.temperature != null ? { temperature: options.temperature } : {}),
        ...(thinkingEnabled
          ? { thinking: { type: "enabled" as const, budget_tokens: options!.thinkingBudget! } }
          : {}),
        ...(options?.responseFormat === "json"
          ? {
              output_config: {
                format: {
                  type: "json_schema" as const,
                  schema: {
                    type: "object",
                    additionalProperties: true,
                  },
                },
              },
            }
          : {}),
      };

      const response = await client.messages.create(params);

      if (response.stop_reason === "max_tokens") {
        const effectiveMax = options?.maxTokens ?? MAX_TOKENS;
        const contentPreview = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text).join("").slice(0, 300);
        const diag = [
          `[anthropic] max_tokens hit`,
          `model=${effectiveModel}`,
          `maxTokens=${effectiveMax}`,
          `tokensInput=${response.usage.input_tokens}`,
          `tokensOutput=${response.usage.output_tokens}`,
          `responseFormat=${options?.responseFormat ?? "text"}`,
          `systemPromptLen=${systemPrompt.length}`,
          `messageLen=${message.length}`,
          `contentPreview=${JSON.stringify(contentPreview)}`,
        ].join(" | ");

        if (options?.responseFormat === "json") {
          console.error(diag);
          throw new Error(`[anthropic] Output truncated (max_tokens). ${diag}`);
        }
        console.warn(`${diag} — returning partial content`);
      }

      // Extract text from content blocks
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      const content = textBlocks.map((b) => b.text).join("");

      return {
        content,
        tokensInput: response.usage.input_tokens,
        tokensOutput: response.usage.output_tokens,
        model: effectiveModel,
      };
    },
  };
}
