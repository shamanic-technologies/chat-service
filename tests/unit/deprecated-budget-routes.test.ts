import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { TOOL_REGISTRY } from "../../src/lib/anthropic.js";

// api-service v0.112.129 deprecated the per-campaign budget routes (Sunset
// 2027-04-12). A campaign's budget is its sales funnel's caps: the Copilot
// reads and writes them with get_funnel_caps / set_funnel_caps / list_campaigns.
const DEPRECATED = [
  /\/campaigns\/daily-budget/,
  /\/campaign-budgets?\b/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("no caller of the deprecated per-campaign budget routes", () => {
  it("no src file names a deprecated route", () => {
    for (const file of sourceFiles(join(__dirname, "../../src"))) {
      const text = readFileSync(file, "utf8");
      for (const re of DEPRECATED) expect(text, `${file} ${re}`).not.toMatch(re);
    }
  });

  it("the budget tools are the funnel caps, the per-campaign ones are gone", () => {
    expect(TOOL_REGISTRY.get_campaign_budgets).toBeUndefined();
    expect(TOOL_REGISTRY.set_campaign_budget).toBeUndefined();
    expect(TOOL_REGISTRY.get_funnel_caps).toBeDefined();
    expect(TOOL_REGISTRY.set_funnel_caps).toBeDefined();
  });
});
