import { TOOL_REGISTRY } from "../../src/lib/anthropic.js";
import { describe, it, expect } from "vitest";
import {
  codeDistryDefinition,
  validateDistryDefinition,
  availableDistryTools,
  sameDefinition,
  DistryConfigError,
  definitionFromSaveRequest,
} from "../../src/agent/distry-config.js";
import { DistrySaveRequestSchema } from "../../src/schemas.js";
import { SOPHIE_MODEL, SOPHIE_SYSTEM_PROMPT, SOPHIE_TOOLS } from "../../src/agent/sophie.js";
import * as skillsModule from "../../src/lib/skills.js";
import * as distryConfigModule from "../../src/agent/distry-config.js";
import { codePromptOverrides } from "../../src/agent/distry-prompt.js";
import { convertReferencesToMentions, foldAlwaysReadIntoPrompt } from "../../src/lib/skill-mentions.js";
import { MERGED_SKILL_SLUGS, SEED_SKILLS } from "../../src/lib/skill-seed.js";
import { mentionableTools } from "../../src/agent/distry-config.js";

describe("Distry's definition (DISTRY-PRINCIPAL-1119)", () => {
  it("version 1 = Distry as the code defines it: same prompt, tools, model (no skill list)", () => {
    const code = codeDistryDefinition();
    expect(code).toEqual({
      systemPrompt: convertReferencesToMentions(
        foldAlwaysReadIntoPrompt(SOPHIE_SYSTEM_PROMPT, SEED_SKILLS),
        new Set(SEED_SKILLS.map((s) => s.slug).filter((s) => !(s in MERGED_SKILL_SLUGS))),
        new Set(mentionableTools()),
      ).text,
      enabledTools: [...SOPHIE_TOOLS],
      provider: SOPHIE_MODEL.provider,
      model: SOPHIE_MODEL.model,
      effort: SOPHIE_MODEL.effort,
      prompt: codePromptOverrides(),
    });
    expect(() => validateDistryDefinition(code)).not.toThrow();
  });

  it("the editor can turn on every registry tool and the principal tools (the Outcome tools included)", () => {
    const names = availableDistryTools().map((t) => t.name);
    for (const t of SOPHIE_TOOLS) expect(names).toContain(t);
    for (const t of ["find_outcome", "get_units", "ask_engine"]) expect(names).toContain(t);
    expect(names).not.toContain("engines");
    expect(names).toContain("read_company_financials");
    expect(availableDistryTools().find((t) => t.name === "find_stakeholders")?.staffOnly).toBe(true);
    expect(availableDistryTools().find((t) => t.name === "run_operation")?.staffOnly).toBe(false);
  });

  it("serves each tool's whole description, every line, as the model reads it", () => {
    for (const t of Object.values(TOOL_REGISTRY)) {
      expect(availableDistryTools().find((a) => a.name === t.name)?.description).toBe(t.description ?? "");
    }
    const correct = availableDistryTools().find((t) => t.name === "correct_person")!;
    expect(correct.description).toBe(TOOL_REGISTRY.correct_person!.description);
    expect(correct.description.length).toBeGreaterThan(300);
  });

  it("refuses what /chat could not run: an unknown tool or model, a thinking level the model cannot run", () => {
    const code = codeDistryDefinition();
    const bad = (patch: Partial<typeof code>) => () => validateDistryDefinition({ ...code, ...patch });
    expect(bad({ enabledTools: ["no_such_tool"] })).toThrow(/Unknown tools: no_such_tool/);
    expect(bad({ enabledTools: ["read_skill", "read_skill"] })).toThrow(/twice/);
    expect(bad({ model: "gpt-9" })).toThrow(/Unknown model/);
    // DISTRY-THINKING-1122: a level is checked against the model's own levels, any provider.
    expect(bad({ provider: "google", model: "flash-pro", effort: "max" })).toThrow(/not at max/);
    expect(() => validateDistryDefinition({ ...code, provider: "google", model: "flash-pro", effort: null })).not.toThrow();
    expect(bad({ systemPrompt: "  " })).toThrow(DistryConfigError);
  });

  it("compares definitions field by field", () => {
    const code = codeDistryDefinition();
    expect(sameDefinition(code, codeDistryDefinition())).toBe(true);
    expect(sameDefinition(code, { ...code, systemPrompt: `${code.systemPrompt}!` })).toBe(false);
  });
});

describe("no skill pick-list (DISTRY-NO-SKILL-PICKS-1122)", () => {
  it("a definition carries no skill list, and the per-agent skill filter is gone", () => {
    expect("skillSlugs" in codeDistryDefinition()).toBe(false);
    expect("filterSkillSet" in skillsModule).toBe(false);
    expect("distrySkillSet" in distryConfigModule).toBe(false);
  });

  it("a stray old pick-list in a save is stripped: the save parses and saves no list", () => {
    const code = codeDistryDefinition();
    const body = { systemPrompt: code.systemPrompt, enabledTools: code.enabledTools, provider: code.provider, model: code.model, effort: code.effort, editedBy: "kevin@distribute.you" };
    for (const skillSlugs of [["campaigns"], null, []]) {
      const parsed = DistrySaveRequestSchema.safeParse({ ...body, skillSlugs });
      expect(parsed.success).toBe(true);
      const def = definitionFromSaveRequest(parsed.success ? parsed.data : (null as never), code.prompt);
      expect("skillSlugs" in def).toBe(false);
      expect(sameDefinition(def, code)).toBe(true);
    }
    // The new editor sends none.
    expect(DistrySaveRequestSchema.safeParse(body).success).toBe(true);
  });
});
