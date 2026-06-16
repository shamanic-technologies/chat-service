import { describe, it, expect, vi } from "vitest";
import { TOOL_REGISTRY, AVAILABLE_TOOL_NAMES, resolveToolSet } from "../../src/lib/anthropic.js";
import {
  SELF_SEEDED_CONFIGS,
  PERSONA_EDITOR_CONFIG,
  BRAND_PROFILE_EDITOR_CONFIG,
  seedPlatformConfigs,
} from "../../src/lib/seed-platform-configs.js";

const NEW_TOOLS = [
  "list_personas",
  "create_persona",
  "duplicate_persona",
  "set_persona_status",
  "get_brand_profile",
  "save_brand_profile_version",
];

describe("persona / brand-profile tool registry", () => {
  it("registers all six new tools with matching names", () => {
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
});

describe("self-seeded platform configs", () => {
  it("declares both expected keys", () => {
    expect(SELF_SEEDED_CONFIGS.map((c) => c.key).sort()).toEqual([
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
    expect(BRAND_PROFILE_EDITOR_CONFIG.allowedTools).not.toContain("create_persona");
    // No write tool grants a hard-delete capability — none exists.
    const everyTool = [...PERSONA_EDITOR_CONFIG.allowedTools, ...BRAND_PROFILE_EDITOR_CONFIG.allowedTools];
    expect(everyTool.some((t) => /delete|destroy|remove_persona/.test(t))).toBe(false);
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
    expect(seededKeys.sort()).toEqual(["brand-profile-editor", "persona-editor"]);

    for (const call of values.mock.calls) {
      const v = call[0] as { provider: string; model: string; allowedTools: string[] };
      expect(v.provider).toBe("google");
      expect(v.model).toBe("flash-pro");
      expect(Array.isArray(v.allowedTools)).toBe(true);
    }
  });
});
