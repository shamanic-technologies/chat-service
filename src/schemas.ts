import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

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
    mcpServerUrl: z.string().url().optional(),
    mcpKeyName: z.string().min(1).optional(),
  })
  .openapi("AppConfigRequest");

export const AppConfigResponseSchema = z
  .object({
    appId: z.string(),
    orgId: z.string(),
    systemPrompt: z.string(),
    mcpServerUrl: z.string().nullable(),
    mcpKeyName: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("AppConfigResponse");

export type AppConfigRequest = z.infer<typeof AppConfigRequestSchema>;

registry.registerPath({
  method: "put",
  path: "/apps/{appId}/config",
  tags: ["App Config"],
  summary: "Register or update app configuration",
  description:
    "Idempotent upsert of app configuration including system prompt and optional MCP settings. Call on every cold start.",
  request: {
    params: z.object({ appId: z.string() }),
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

// --- Chat ---

export const ChatRequestSchema = z
  .object({
    message: z.string().min(1, "message is required"),
    sessionId: z.string().uuid().optional(),
    appId: z.string().min(1, "appId is required"),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("ChatRequest");

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

registry.registerPath({
  method: "post",
  path: "/chat",
  tags: ["Chat"],
  summary: "Stream AI chat response",
  description:
    "Send a message and receive a streamed AI response via Server-Sent Events (SSE). Supports MCP tool calling and quick-reply buttons. Requires app config to be registered first via PUT /apps/{appId}/config.",
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
    }),
    body: {
      content: { "application/json": { schema: ChatRequestSchema } },
    },
  },
  responses: {
    200: {
      description:
        "SSE stream of chat events (token, tool_call, tool_result, input_request, buttons, [DONE])",
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
      description: "App config not found — register via PUT /apps/{appId}/config first",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
