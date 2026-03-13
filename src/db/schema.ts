import { pgTable, uuid, text, timestamp, jsonb, integer, unique } from "drizzle-orm/pg-core";

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull(),
  userId: text("user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role").notNull().$type<"user" | "assistant" | "tool">(),
  content: text("content").notNull(),
  toolCalls: jsonb("tool_calls").$type<ToolCallRecord[]>(),
  buttons: jsonb("buttons").$type<ButtonRecord[]>(),
  tokenCount: integer("token_count"),
  runId: uuid("run_id"),
  campaignId: text("campaign_id"),
  brandId: text("brand_id"),
  workflowName: text("workflow_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appConfigs = pgTable(
  "app_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    mcpServerUrl: text("mcp_server_url"),
    mcpKeyName: text("mcp_key_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("app_configs_org_id_unique").on(table.orgId)],
);

export const platformConfigs = pgTable("platform_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  systemPrompt: text("system_prompt").notNull(),
  mcpServerUrl: text("mcp_server_url"),
  mcpKeyName: text("mcp_key_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
}

export interface ButtonRecord {
  label: string;
  value: string;
}

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type AppConfig = typeof appConfigs.$inferSelect;
export type NewAppConfig = typeof appConfigs.$inferInsert;
export type PlatformConfig = typeof platformConfigs.$inferSelect;
export type NewPlatformConfig = typeof platformConfigs.$inferInsert;
