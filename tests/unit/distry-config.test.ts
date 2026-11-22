import { TOOL_REGISTRY } from "../../src/lib/anthropic.js";
import { describe, it, expect } from "vitest";
import {
  codeDistryDefinition,
  validateDistryDefinition,
  availableDistryTools,
  sameDefinition,
  DistryConfigError,
} from "../../src/agent/distry-config.js";
import { SOPHIE_MODEL, SOPHIE_SYSTEM_PROMPT, SOPHIE_TOOLS } from "../../src/agent/sophie.js";
import { filterSkillSet } from "../../src/lib/skills.js";
import { codePromptOverrides } from "../../src/agent/distry-prompt.js";

describe("Distry's definition (DISTRY-PRINCIPAL-1119)", () => {
  it("version 1 = Distry as the code defines it: same prompt, tools, model, every skill", () => {
    const code = codeDistryDefinition();
    expect(code).toEqual({
      systemPrompt: SOPHIE_SYSTEM_PROMPT,
      enabledTools: [...SOPHIE_TOOLS],
      skillSlugs: null,
      provider: SOPHIE_MODEL.provider,
      model: SOPHIE_MODEL.model,
      effort: SOPHIE_MODEL.effort,
      prompt: codePromptOverrides(),
    });
    expect(() => validateDistryDefinition(code, [])).not.toThrow();
  });

  it("the editor can turn on every registry tool and the principal tools (engines included)", () => {
    const names = availableDistryTools().map((t) => t.name);
    for (const t of SOPHIE_TOOLS) expect(names).toContain(t);
    expect(names).toContain("engines");
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

  it("refuses what /chat could not run: an unknown tool, skill or model, a thinking level the model cannot run", () => {
    const code = codeDistryDefinition();
    const bad = (patch: Partial<typeof code>, skills: string[] = []) => () => validateDistryDefinition({ ...code, ...patch }, skills);
    expect(bad({ enabledTools: ["no_such_tool"] })).toThrow(/Unknown tools: no_such_tool/);
    expect(bad({ enabledTools: ["read_skill", "read_skill"] })).toThrow(/twice/);
    expect(bad({ skillSlugs: ["ghost"] }, ["index"])).toThrow(/Unknown skills: ghost/);
    expect(bad({ model: "gpt-9" })).toThrow(/Unknown model/);
    // DISTRY-THINKING-1122: a level is checked against the model's own levels, any provider.
    expect(bad({ provider: "google", model: "flash-pro", effort: "max" })).toThrow(/not at max/);
    expect(() => validateDistryDefinition({ ...code, provider: "google", model: "flash-pro", effort: null }, [])).not.toThrow();
    expect(bad({ systemPrompt: "  " })).toThrow(DistryConfigError);
  });

  it("compares definitions field by field", () => {
    const code = codeDistryDefinition();
    expect(sameDefinition(code, codeDistryDefinition())).toBe(true);
    expect(sameDefinition(code, { ...code, systemPrompt: `${code.systemPrompt}!` })).toBe(false);
  });
});

describe("a skill set keeps each listed skill with its subtree, plus the index and the one voice", () => {
  const tree = [
    { slug: "index", parentSlug: null },
    { slug: "client-comms", parentSlug: "index" },
    { slug: "campaigns", parentSlug: "index" },
    { slug: "staff", parentSlug: "index" },
    { slug: "catalogue", parentSlug: "staff" },
    { slug: "catalogue-steps", parentSlug: "catalogue" },
  ];
  it("null = every skill", () => {
    expect(filterSkillSet(tree, null)).toHaveLength(tree.length);
  });
  it("a set keeps its subtrees only", () => {
    expect(filterSkillSet(tree, ["catalogue"]).map((s) => s.slug)).toEqual(["index", "client-comms", "catalogue", "catalogue-steps"]);
    expect(filterSkillSet(tree, []).map((s) => s.slug)).toEqual(["index", "client-comms"]);
  });
});
