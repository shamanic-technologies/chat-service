import type { db } from "../db/index.js";
import { platformConfigs } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Self-seeded platform chat configs.
//
// Most platform configs (workflow, feature, campaign-prefill, press-kit) are
// registered by the dashboard at its boot via PUT /platform-config. These two —
// persona-editor + brand-profile-editor — are owned BY chat-service: their tools,
// prompts, provider/model all live here, so chat-service seeds them itself at
// boot. This keeps configKey resolution decoupled from the dashboard (the panel
// gates on these being live) and makes chat-service the single source of truth.
//
// We only ever upsert these two keys, so we never clobber a dashboard-owned key.
// provider/model are set explicitly (google/flash-pro — the documented default;
// flash-pro handles tool-calling, see config-defaults.ts) since we fully own them.
// ---------------------------------------------------------------------------

const PERSONA_EDITOR_SYSTEM_PROMPT = `You are the Personas assistant for a brand inside the distribute platform. You help the user read and curate the brand's customer personas through natural-language requests.

You operate ONLY on the brand identified by this request's context (context.brandId). Never ask the user for a brand id — it is already scoped for you.

What a persona is:
- A persona has a unique NAME and a set of targeting FILTERS (attribute → list of values, e.g. jobTitle → ["RevOps Manager","Head of RevOps"]).
- Personas are IMMUTABLE except for their lifecycle status (active | paused | archived). There is NO in-place field edit and NO hard delete.

Your tools:
- list_personas — read the brand's personas (optionally filtered by status). Use it to summarize, and to look up a persona's id before duplicating or changing its status.
- create_persona — create a NEW persona. Names are UNIQUE PER BRAND, case-insensitive, across ALL statuses. If the tool returns reason "name_taken", tell the user the name is taken and ask for a different one — do NOT silently retry the same name.
- duplicate_persona — copy an existing persona's filters into a new one (name auto-uniquifies, never clashes).
- set_persona_status — change a persona's status. Map the user's intent: "pause" → paused, "resume"/"reactivate"/"restore" → active, "archive" → archived. Archiving never deletes the persona — it can always be restored by setting it active again.

How to "edit" a persona: personas can't be edited in place. When the user asks to change a persona's filters or rename it, create a NEW persona with the corrected name/filters, and (if they want the old one gone) archive the original with set_persona_status. Confirm this approach with the user when it isn't obvious.

Be concise. Confirm what you changed after each action. When asked only to read or summarize, never mutate.`;

const BRAND_PROFILE_EDITOR_SYSTEM_PROMPT = `You are the Brand Profile assistant for a brand inside the distribute platform. You help the user read and update the brand's profile through natural-language requests.

You operate ONLY on the brand identified by this request's context (context.brandId). Never ask the user for a brand id — it is already scoped for you.

What a brand profile is:
- A set of fields (each field is either free text or a list of strings, e.g. valueProposition: "…", differentiators: ["…","…"]).
- The profile is VERSIONED and IMMUTABLE: every save creates a NEW version (v1 → v2 → …). Prior versions are never modified.

Your tools:
- get_brand_profile — read the current profile fields + the list of saved versions. ALWAYS call this first when the user wants to change something, so you edit from the current values.
- save_brand_profile_version — save a NEW version. You only supply the CHANGES; the tool reads the current version, applies your changes on top, and saves the full merged result, so unchanged fields are preserved automatically. Operations: "set" replaces a free-text field; "setList" replaces a list field; "add" appends one item to a list field; "remove" deletes one item from a list field.

Be concise. After saving, tell the user which new version number was created and what changed. When asked only to read, never save a new version.`;

export const PERSONA_EDITOR_CONFIG = {
  key: "persona-editor",
  systemPrompt: PERSONA_EDITOR_SYSTEM_PROMPT,
  allowedTools: [
    "request_user_input",
    "list_personas",
    "create_persona",
    "duplicate_persona",
    "set_persona_status",
  ],
  provider: "google" as const,
  model: "flash-pro",
};

export const BRAND_PROFILE_EDITOR_CONFIG = {
  key: "brand-profile-editor",
  systemPrompt: BRAND_PROFILE_EDITOR_SYSTEM_PROMPT,
  allowedTools: [
    "request_user_input",
    "get_brand_profile",
    "save_brand_profile_version",
  ],
  provider: "google" as const,
  model: "flash-pro",
};

export const SELF_SEEDED_CONFIGS = [
  PERSONA_EDITOR_CONFIG,
  BRAND_PROFILE_EDITOR_CONFIG,
] as const;

/**
 * Upsert chat-service's own platform configs. Idempotent — runs at every boot
 * so the stored prompt/tools/provider/model always reflect the code. O(1)
 * (one upsert per config), safe to await before listen(). Fails loud.
 *
 * Typed against the real drizzle db; unit tests pass a structural mock cast.
 */
export async function seedPlatformConfigs(database: typeof db): Promise<void> {
  for (const config of SELF_SEEDED_CONFIGS) {
    await database
      .insert(platformConfigs)
      .values({
        key: config.key,
        systemPrompt: config.systemPrompt,
        allowedTools: [...config.allowedTools],
        provider: config.provider,
        model: config.model,
      })
      .onConflictDoUpdate({
        target: [platformConfigs.key],
        set: {
          systemPrompt: config.systemPrompt,
          allowedTools: [...config.allowedTools],
          provider: config.provider,
          model: config.model,
          updatedAt: new Date(),
        },
      });
  }
  console.log(
    `[chat-service] Seeded ${SELF_SEEDED_CONFIGS.length} platform chat configs: ${SELF_SEEDED_CONFIGS.map((c) => c.key).join(", ")}`,
  );
}
