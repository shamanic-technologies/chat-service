import { pgTable, uuid, text, timestamp, jsonb, integer, unique, index } from "drizzle-orm/pg-core";

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull(),
  userId: text("user_id"),
  runId: uuid("run_id"),
  parentRunId: uuid("parent_run_id"),
  campaignId: text("campaign_id"),
  brandIds: text("brand_ids").array(),
  workflowSlug: text("workflow_slug"),
  featureSlug: text("feature_slug"),
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
  contentBlocks: jsonb("content_blocks").$type<unknown[]>(),
  toolCalls: jsonb("tool_calls").$type<ToolCallRecord[]>(),
  buttons: jsonb("buttons").$type<ButtonRecord[]>(),
  tokenCount: integer("token_count"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appConfigs = pgTable(
  "app_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    key: text("key").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    allowedTools: jsonb("allowed_tools").notNull().$type<string[]>(),
    provider: text("provider").$type<"anthropic" | "google">(),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("app_configs_org_id_key_unique").on(table.orgId, table.key)],
);

// `brand_id` column is the canonical cache partition for /orgs/rag/score. It holds
// either a single brand UUID (legacy single-brand cache rows + N=1 multi-brand requests)
// or a comma-separated, ASCII-sorted list of brand UUIDs for N>=2 multi-brand requests
// (e.g. "550e8400-...,660f9500-..."). The plural-name rename was skipped on purpose
// so existing single-brand rows stay byte-identical and require no migration.
export const brandProfileEmbeddings = pgTable(
  "brand_profile_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    brandId: text("brand_id").notNull(),
    contentHash: text("content_hash").notNull(),
    queryText: text("query_text").notNull(),
    embedding: jsonb("embedding").notNull().$type<number[]>(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("brand_profile_embeddings_org_brand_hash_unique").on(
      table.orgId,
      table.brandId,
      table.contentHash,
    ),
    index("brand_profile_embeddings_org_brand_idx").on(table.orgId, table.brandId),
  ],
);

export type BrandProfileEmbedding = typeof brandProfileEmbeddings.$inferSelect;
export type NewBrandProfileEmbedding = typeof brandProfileEmbeddings.$inferInsert;

export const platformConfigs = pgTable("platform_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  systemPrompt: text("system_prompt").notNull(),
  allowedTools: jsonb("allowed_tools").notNull().$type<string[]>(),
  provider: text("provider").$type<"anthropic" | "google">(),
  model: text("model"),
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
