import { describe, it, expect } from "vitest";
import { SUGGEST_AUDIENCES_TOOL } from "../../src/lib/anthropic.js";
import { AUDIENCE_EDITOR_CONFIG } from "../../src/lib/seed-platform-configs.js";

// A candidate from suggest_audiences is persisted at status `suggested`, and NO
// customer surface renders a `suggested` audience. The model must therefore not
// report a candidate as a created audience — the tool description and the
// audience-editor system prompt are the enforcement surface for that.
describe("suggest_audiences never licenses a 'created' claim", () => {
  const description = SUGGEST_AUDIENCES_TOOL.description ?? "";

  it("states that a suggested candidate is invisible until activated", () => {
    expect(description).toMatch(/invisible/i);
    expect(description).toMatch(/activat/i);
  });

  it("does not claim the candidate is already a created/persisted audience", () => {
    expect(description).not.toMatch(/ALREADY PERSISTED/i);
  });

  it("is mirrored in the audience-editor system prompt", () => {
    expect(AUDIENCE_EDITOR_CONFIG.systemPrompt).toMatch(/invisible/i);
    expect(AUDIENCE_EDITOR_CONFIG.systemPrompt).not.toMatch(/ALREADY SAVED/i);
  });
});
