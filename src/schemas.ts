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

// --- Chat ---

export const ChatRequestSchema = z
  .object({
    message: z.string().min(1, "message is required"),
    sessionId: z.string().uuid().optional(),
  })
  .openapi("ChatRequest");

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

registry.registerPath({
  method: "post",
  path: "/chat",
  tags: ["Chat"],
  summary: "Stream AI chat response",
  description:
    "Send a message and receive a streamed AI response via Server-Sent Events (SSE). Supports MCP tool calling and quick-reply buttons.",
  request: {
    headers: z.object({
      authorization: z.string().openapi({
        description: "Bearer token used to scope sessions by organization (format: Bearer <key>)",
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
      description: "Missing or empty message",
      content: {
        "application/json": { schema: ValidationErrorResponseSchema },
      },
    },
    401: {
      description: "Missing or invalid Authorization Bearer header",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
