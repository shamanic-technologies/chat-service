import { describe, it, expect, vi } from "vitest";
import { TOOL_REGISTRY, AVAILABLE_TOOL_NAMES, resolveToolSet } from "../../src/lib/anthropic.js";
import {
  SELF_SEEDED_CONFIGS,
  PERSONA_EDITOR_CONFIG,
  BRAND_PROFILE_EDITOR_CONFIG,
  AUDIENCE_EDITOR_CONFIG,
  seedPlatformConfigs,
} from "../../src/lib/seed-platform-configs.js";

const NEW_TOOLS = [
  "list_personas",
  "create_persona",
  "duplicate_persona",
  "set_persona_status",
  "get_brand_profile",
  "save_brand_profile_version",
  "refresh_brand_profile_from_website",
  "list_audiences",
  "suggest_audiences",
  "set_audience_status",
  "rename_audience",
  "refresh_audience_count",
];

describe("persona / brand-profile tool registry", () => {
  it("registers all persona and brand-profile tools with matching names", () => {
    for (const name of NEW_TOOLS) {
      expect(TOOL_REGISTRY[name], `missing tool ${name}`).toBeDefined();
      expect(TOOL_REGISTRY[name].name).toBe(name);
    }
  });

  it("resolveToolSet resolves every tool in persona-editor's allowedTools", () => {
    const tools = resolveToolSet([...PERSONA_EDITOR_CONFIG.allowedTools]);
    expect(tools.map((t) => t.name)).toEqual([...PERSONA_EDITOR_CONFIG.allowedTools]);
  });

  it("resolveToolSet resolves every tool in brand-profile-editor's allowedTools", () => {
    const tools = resolveToolSet([...BRAND_PROFILE_EDITOR_CONFIG.allowedTools]);
    expect(tools.map((t) => t.name)).toEqual([...BRAND_PROFILE_EDITOR_CONFIG.allowedTools]);
  });

  it("resolveToolSet resolves every tool in audience-editor's allowedTools", () => {
    const tools = resolveToolSet([...AUDIENCE_EDITOR_CONFIG.allowedTools]);
    expect(tools.map((t) => t.name)).toEqual([...AUDIENCE_EDITOR_CONFIG.allowedTools]);
  });
});

describe("self-seeded platform configs", () => {
  it("declares all expected keys", () => {
    expect(SELF_SEEDED_CONFIGS.map((c) => c.key).sort()).toEqual([
      "audience-editor",
      "brand-profile-editor",
      "persona-editor",
    ]);
  });

  it("every allowedTool is a real registered tool", () => {
    for (const config of SELF_SEEDED_CONFIGS) {
      for (const tool of config.allowedTools) {
        expect(AVAILABLE_TOOL_NAMES, `${config.key} → ${tool}`).toContain(tool);
      }
    }
  });

  it("defaults to google/flash-pro and a non-empty system prompt", () => {
    for (const config of SELF_SEEDED_CONFIGS) {
      expect(config.provider).toBe("google");
      expect(config.model).toBe("flash-pro");
      expect(config.systemPrompt.length).toBeGreaterThan(50);
    }
  });

  it("persona-editor cannot touch brand-profile tools and vice-versa (scoping)", () => {
    expect(PERSONA_EDITOR_CONFIG.allowedTools).not.toContain("save_brand_profile_version");
    expect(PERSONA_EDITOR_CONFIG.allowedTools).not.toContain("refresh_brand_profile_from_website");
    expect(BRAND_PROFILE_EDITOR_CONFIG.allowedTools).not.toContain("create_persona");
    // No write tool grants a hard-delete capability — none exists.
    const everyTool = [...PERSONA_EDITOR_CONFIG.allowedTools, ...BRAND_PROFILE_EDITOR_CONFIG.allowedTools];
    expect(everyTool.some((t) => /delete|destroy|remove_persona/.test(t))).toBe(false);
  });

  it("audience-editor is isolated from persona / brand-profile tools and vice-versa (scoping)", () => {
    const audienceTools = [
      "list_audiences",
      "suggest_audiences",
      "set_audience_status",
      "rename_audience",
      "refresh_audience_count",
    ];
    // audience-editor exposes ONLY audience tools (+ request_user_input).
    for (const tool of AUDIENCE_EDITOR_CONFIG.allowedTools) {
      if (tool === "request_user_input") continue;
      expect(audienceTools, `audience-editor leaks ${tool}`).toContain(tool);
    }
    // persona / brand-profile editors cannot reach any audience tool.
    for (const tool of audienceTools) {
      expect(PERSONA_EDITOR_CONFIG.allowedTools).not.toContain(tool);
      expect(BRAND_PROFILE_EDITOR_CONFIG.allowedTools).not.toContain(tool);
    }
    // audience-editor cannot reach persona / brand-profile tools.
    for (const tool of [
      ...PERSONA_EDITOR_CONFIG.allowedTools,
      ...BRAND_PROFILE_EDITOR_CONFIG.allowedTools,
    ]) {
      if (tool === "request_user_input") continue;
      expect(AUDIENCE_EDITOR_CONFIG.allowedTools).not.toContain(tool);
    }
    // No audience tool grants a hard-delete capability — none exists (archive only).
    expect(audienceTools.some((t) => /delete|destroy|remove/.test(t))).toBe(false);
  });

  it("brand-profile-editor exposes the website refresh tool and prompt guard", () => {
    expect(BRAND_PROFILE_EDITOR_CONFIG.allowedTools).toContain(
      "refresh_brand_profile_from_website",
    );
    expect(BRAND_PROFILE_EDITOR_CONFIG.systemPrompt).toContain(
      "Do not stop after get_brand_profile",
    );
    expect(BRAND_PROFILE_EDITOR_CONFIG.systemPrompt).toContain(
      "When asked only to read, summarize, or give an opinion, never save",
    );
  });
});

describe("seedPlatformConfigs", () => {
  it("upserts every config with its full payload", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });

    await seedPlatformConfigs({ insert } as never);

    expect(insert).toHaveBeenCalledTimes(SELF_SEEDED_CONFIGS.length);
    expect(values).toHaveBeenCalledTimes(SELF_SEEDED_CONFIGS.length);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(SELF_SEEDED_CONFIGS.length);

    const seededKeys = values.mock.calls.map((c) => (c[0] as { key: string }).key);
    expect(seededKeys.sort()).toEqual([
      "audience-editor",
      "brand-profile-editor",
      "persona-editor",
    ]);

    for (const call of values.mock.calls) {
      const v = call[0] as { provider: string; model: string; allowedTools: string[] };
      expect(v.provider).toBe("google");
      expect(v.model).toBe("flash-pro");
      expect(Array.isArray(v.allowedTools)).toBe(true);
    }
  });
});
