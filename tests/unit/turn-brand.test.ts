import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  BRAND_SCOPED_TOOL_NAMES,
  BrandChoiceRequired,
  createTurnBrandResolver,
  toOrgBrands,
  withBrandIdArg,
} from "../../src/lib/turn-brand.js";
import { resolveToolSet, TOOL_REGISTRY } from "../../src/lib/anthropic.js";

const REED = { id: "reed", name: "Reed", domain: "reed.example" };
const OTHER = { id: "other", name: "Other", domain: null };

describe("createTurnBrandResolver", () => {
  it("a turn carrying a brand uses it and never reads the org's brands (web unchanged)", async () => {
    const listOrgBrands = vi.fn();
    const r = createTurnBrandResolver({ contextBrandIds: ["ctx"], listOrgBrands });
    await expect(r.require("list_audiences", { brandId: "other" })).resolves.toBe("ctx");
    expect(listOrgBrands).not.toHaveBeenCalled();
  });

  it("several brands in context still fail loud", async () => {
    const r = createTurnBrandResolver({ contextBrandIds: ["a", "b"], listOrgBrands: vi.fn() });
    await expect(r.require("list_audiences")).rejects.toThrow("operates on a single brand, but 2 were provided");
  });

  it("no brand in context, one brand in the org: that brand, read once per turn", async () => {
    const listOrgBrands = vi.fn(async () => [REED]);
    const r = createTurnBrandResolver({ contextBrandIds: [], listOrgBrands });
    await expect(r.require("list_audiences")).resolves.toBe("reed");
    await expect(r.require("suggest_audiences")).resolves.toBe("reed");
    expect(listOrgBrands).toHaveBeenCalledTimes(1);
  });

  it("several brands, none named: BrandChoiceRequired listing them, never a guess", async () => {
    const r = createTurnBrandResolver({ contextBrandIds: [], listOrgBrands: async () => [REED, OTHER] });
    const err = await r.require("list_audiences").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrandChoiceRequired);
    const result = (err as BrandChoiceRequired).toResult();
    expect(result.brandChoiceRequired).toBe(true);
    expect(result.brands).toEqual([REED, OTHER]);
    expect(String(result.instruction)).toContain("call list_audiences again with that brand's id as brandId");
  });

  it("several brands, one named: that brand; a foreign id is refused", async () => {
    const r = createTurnBrandResolver({ contextBrandIds: [], listOrgBrands: async () => [REED, OTHER] });
    await expect(r.require("list_audiences", { brandId: "other" })).resolves.toBe("other");
    await expect(r.require("list_audiences", { brandId: "stranger" })).rejects.toThrow("is not one of this account's brands");
  });

  it("no brand at all: says so in words", async () => {
    const r = createTurnBrandResolver({ contextBrandIds: [], listOrgBrands: async () => [] });
    await expect(r.require("list_audiences")).rejects.toThrow("This account has no brand yet");
  });
});

describe("toOrgBrands", () => {
  it("reads {brands: [...]} and a bare array, fails loud on anything else", () => {
    expect(toOrgBrands({ brands: [{ id: "reed", name: "Reed", domain: "reed.example" }] })).toEqual([REED]);
    expect(toOrgBrands([{ id: "other", name: "Other" }])).toEqual([OTHER]);
    expect(() => toOrgBrands({ error: "x" })).toThrow("without a brands list");
  });
});

describe("brandId argument on brand-scoped tools", () => {
  it("every brand-scoped tool is declared with an optional brandId; others are untouched", () => {
    const names = Object.keys(TOOL_REGISTRY);
    const tools = resolveToolSet(names);
    for (const tool of tools) {
      const props = (tool.input_schema as { properties?: Record<string, unknown>; required?: string[] }).properties ?? {};
      if (BRAND_SCOPED_TOOL_NAMES.includes(tool.name)) {
        expect(props.brandId, tool.name).toBeDefined();
        expect((tool.input_schema as { required?: string[] }).required ?? []).not.toContain("brandId");
      }
    }
    // The registry itself is never mutated.
    expect((TOOL_REGISTRY.list_audiences.input_schema as { properties: Record<string, unknown> }).properties.brandId).toBeUndefined();
    expect(withBrandIdArg(TOOL_REGISTRY.list_brands)).toBe(TOOL_REGISTRY.list_brands);
  });

  it("every tool the dispatcher resolves a single brand for is in BRAND_SCOPED_TOOL_NAMES (no tool left on the old error)", () => {
    const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    const named = [...source.matchAll(/requireSingleBrandId\("([a-z_]+)"/g)].map((m) => m[1]);
    const viaOffer = [...source.matchAll(/call\.name === "([a-z_]+)"\) \{\n(?:.*\n){0,2}?.*requireOffer\(call\.name/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(5);
    expect(viaOffer.length).toBeGreaterThan(3);
    for (const name of [...named, ...viaOffer]) expect(BRAND_SCOPED_TOOL_NAMES, name).toContain(name);
    expect(source).not.toContain("requires a brand — provide context.brandId");
  });
});
