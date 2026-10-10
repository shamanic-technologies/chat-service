import { pgTable, uuid, text, timestamp, jsonb, integer, unique, index, boolean } from "drizzle-orm/pg-core";
import type { ChoicesRecord, OpenPageRecord } from "../schemas.js";

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    runId: uuid("run_id"),
    parentRunId: uuid("parent_run_id"),
    campaignId: text("campaign_id"),
    brandIds: text("brand_ids").array(),
    workflowSlug: text("workflow_slug"),
    featureSlug: text("feature_slug"),
    audienceId: text("audience_id"),
    // The chat config key the session was started under (migration 0017).
    // NULL on sessions created before 2026-10-09. Read by GET /sessions/latest.
    configKey: text("config_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Created by migration 0012 for transfer-brand queries and live in production
  // since. Declared here so schema.ts describes the real schema — without it,
  // `drizzle-kit push` reads the index as drift and drops it.
  (table) => [
    index("sessions_org_brand_idx").on(table.orgId, table.brandIds),
    index("sessions_org_user_config_updated_idx").on(table.orgId, table.userId, table.configKey, table.updatedAt),
  ],
);

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
  // Rich choice cards (present_choices) and side-panel pages (open_page) the
  // assistant emitted on this turn, so a reload re-renders them (migration 0017).
  choices: jsonb("choices").$type<ChoicesRecord>(),
  openPages: jsonb("open_pages").$type<OpenPageRecord[]>(),
  // The out-of-credits action of this turn (credits_required, migration 0020).
  creditsRequired: jsonb("credits_required").$type<CreditsRequiredRecord>(),
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
    // Per-config Gemini-3 thinking level for the /chat path. NULL = code default
    // ("low"). Never read by /complete. See src/lib/gemini.ts buildThinkingConfig.
    thinkingLevel: text("thinking_level").$type<"minimal" | "low" | "medium" | "high">(),
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
  // Per-config Gemini-3 thinking level for the /chat path. NULL = code default
  // ("low"). Never read by /complete. See src/lib/gemini.ts buildThinkingConfig.
  thinkingLevel: text("thinking_level").$type<"minimal" | "low" | "medium" | "high">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Copilot SKILL TREE (migration 0018). One row per skill: the INDEX (slug
// "index", parent NULL) plus one sub-skill per topic (parent "index", or a
// deeper parent). Staff edit content live from the dashboard (autosave), so
// `updated_by` records who wrote the current content: "seed" = never touched by
// a human, and ONLY such rows may be refreshed from code at boot. A
// human-edited row is never overwritten by a deploy.
export const skills = pgTable("skills", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  parentSlug: text("parent_slug"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  content: text("content").notNull(),
  position: integer("position").notNull().default(0),
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Every content a skill has held, newest version last. Autosave writes are
// coalesced: a save by the SAME editor within SKILL_VERSION_COALESCE_MS of the
// previous version rewrites that version instead of adding one, so a typing
// burst is one recoverable snapshot, not one row per keystroke.
export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    editedBy: text("edited_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("skill_versions_skill_version_unique").on(table.skillId, table.version)],
);

// Requests the Copilot escalated to staff because a piece of the user's ask
// needs code (migration 0018). Deduped per org on (org, repo, kind, piece_key):
// a repeat bumps request_count instead of opening a second issue.
export const staffRequests = pgTable(
  "staff_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    brandId: text("brand_id"),
    sessionId: uuid("session_id"),
    kind: text("kind").notNull().$type<StaffRequestKind>(),
    // NULL for `contact_human` (no repo: it reaches a person, not a codebase; migration 0019).
    repo: text("repo"),
    pieceKey: text("piece_key").notNull(),
    title: text("title").notNull(),
    userRequest: text("user_request").notNull(),
    decomposition: jsonb("decomposition").notNull().$type<StaffRequestPiece[]>(),
    missingPiece: text("missing_piece").notNull(),
    requesterIsStaff: boolean("requester_is_staff").notNull(),
    issueUrl: text("issue_url"),
    issueNumber: integer("issue_number"),
    issueError: text("issue_error"),
    telegramSentAt: timestamp("telegram_sent_at", { withTimezone: true }),
    telegramSkippedReason: text("telegram_skipped_reason"),
    telegramError: text("telegram_error"),
    requestCount: integer("request_count").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("staff_requests_org_repo_kind_piece_unique").on(table.orgId, table.repo, table.kind, table.pieceKey),
  ],
);

/** bug / feature: code is broken or missing; skill_upgrade: a skill or a service doc is wrong or thin; contact_human: the user wants a person. */
export type StaffRequestKind = "bug" | "feature" | "skill_upgrade" | "contact_human";

/** The "Add credits" action stored on an out-of-credits assistant turn. */
export interface CreditsRequiredRecord {
  message: string;
  action: "add_credits";
  label: string;
}

export interface StaffRequestPiece {
  piece: string;
  outcome: "exists" | "create" | "needs_code";
  detail?: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  /**
   * Gemini-3 reasoning token captured from the functionCall part. Echoed back
   * on history replay (`toGeminiHistory`) — required or Gemini 3 returns 400.
   * Absent on Anthropic tool calls and on Gemini calls recorded before this
   * field existed (a dummy bypass value is substituted at replay time).
   */
  thoughtSignature?: string;
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
export type Skill = typeof skills.$inferSelect;
export type SkillVersion = typeof skillVersions.$inferSelect;
export type StaffRequest = typeof staffRequests.$inferSelect;
