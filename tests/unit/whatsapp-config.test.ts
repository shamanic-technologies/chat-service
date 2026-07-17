import { describe, it, expect } from "vitest";
import { AVAILABLE_TOOL_NAMES, resolveToolSet } from "../../src/lib/anthropic.js";
import { WHATSAPP_CONFIG } from "../../src/lib/seed-platform-configs.js";

// The WhatsApp "Distribute.you" assistant must let a user operate the whole
// platform end-to-end by chat: create a brand from a URL, launch a campaign, set
// the daily budget, and pause/resume a brand — on top of the existing curation
// tools. These tests pin the funnel tool set into the config so it can't drift.

const FUNNEL_TOOLS = [
  "create_brand_from_url",
  "list_brands",
  "launch_campaign",
  "list_campaigns",
  "stop_campaign",
  "get_daily_budget",
  "set_daily_budget",
  "get_brand_pause",
  "set_brand_pause",
];

describe("whatsapp config — full-funnel tool set", () => {
  it("enables every funnel tool (brand → launch → budget → pause/resume)", () => {
    for (const tool of FUNNEL_TOOLS) {
      expect(WHATSAPP_CONFIG.allowedTools, `whatsapp missing ${tool}`).toContain(tool);
    }
  });

  it("also enables the existing curation + discovery operations", () => {
    for (const tool of [
      "browse_url",
      "list_features",
      "get_feature_inputs",
      "list_workflows",
      "get_brand_profile",
      "list_audiences",
      "suggest_audiences",
      "list_personas",
      "create_persona",
    ]) {
      expect(WHATSAPP_CONFIG.allowedTools, `whatsapp missing ${tool}`).toContain(tool);
    }
  });

  it("every allowedTool resolves to a registered tool", () => {
    for (const tool of WHATSAPP_CONFIG.allowedTools) {
      expect(AVAILABLE_TOOL_NAMES, `unknown tool ${tool}`).toContain(tool);
    }
    const resolved = resolveToolSet([...WHATSAPP_CONFIG.allowedTools]);
    expect(resolved.map((t) => t.name)).toEqual([...WHATSAPP_CONFIG.allowedTools]);
  });

  it("runs on the documented Gemini default (google/flash-pro) so the WhatsApp org is billed like dashboard chat", () => {
    expect(WHATSAPP_CONFIG.key).toBe("whatsapp");
    expect(WHATSAPP_CONFIG.provider).toBe("google");
    expect(WHATSAPP_CONFIG.model).toBe("flash-pro");
  });

  it("names itself Distribute.you and never asks the user to sign in", () => {
    expect(WHATSAPP_CONFIG.systemPrompt).toContain("Distribute.you");
    expect(WHATSAPP_CONFIG.systemPrompt).toMatch(/never ask them to sign in/i);
  });

  it("does not expose fork_workflow (new-dynasty, confirmation-gated) by default", () => {
    expect(WHATSAPP_CONFIG.allowedTools).not.toContain("fork_workflow");
  });
});
