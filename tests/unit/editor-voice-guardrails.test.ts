import { describe, it, expect } from "vitest";
import { SELF_SEEDED_CONFIGS } from "../../src/lib/seed-platform-configs.js";

// Real user sessions leaked raw plumbing (UUIDs, apolloAudienceId, filter JSON,
// tool errors / 404s, raw count fields) into the prose, fabricated completion
// before any tool succeeded, and invented ids that never came from a tool. All
// three editor prompts now carry a shared voice + ground-truth guardrail block.
// These tests pin that block into every editor prompt so it can't silently drift
// out of one of them.

describe("editor prompt voice + ground-truth guardrails", () => {
  it("forbids surfacing internal plumbing (ids, provider ids, filters, counts)", () => {
    for (const config of SELF_SEEDED_CONFIGS) {
      const p = config.systemPrompt;
      expect(p, `${config.key} missing plumbing ban`).toContain(
        "NEVER surface internal plumbing",
      );
      // Bans the specific leaks observed in the real session.
      expect(p, `${config.key} must ban provider ids`).toMatch(/apolloAudienceId/);
      expect(p, `${config.key} must ban raw filter field names`).toMatch(
        /person_titles|filter field names/,
      );
      expect(p, `${config.key} must ban raw count fields`).toMatch(/apolloCount|apifyCount/);
      // Counts must be human-rounded, filters plain-language.
      expect(p, `${config.key} must require plain-language filters`).toMatch(
        /Translate filters into plain human language/,
      );
      expect(p, `${config.key} must require a rounded human count`).toMatch(
        /single rounded human number/,
      );
    }
  });

  it("forbids leaking tool names, tool errors, and HTTP status / 404s", () => {
    for (const config of SELF_SEEDED_CONFIGS) {
      const p = config.systemPrompt;
      expect(p, `${config.key} must ban tool names / errors`).toMatch(
        /no tool names, no tool errors/,
      );
      expect(p, `${config.key} must ban 404s`).toMatch(/404/);
    }
  });

  it("requires tool-success before claiming an action is done (no fabricated completion)", () => {
    for (const config of SELF_SEEDED_CONFIGS) {
      const p = config.systemPrompt;
      expect(p, `${config.key} missing ground-truth rule`).toContain(
        "Ground truth = the tool result",
      );
      expect(p, `${config.key} must require success before 'done'`).toMatch(
        /Only state an action as done AFTER the corresponding tool call has RETURNED SUCCESS/,
      );
      expect(p, `${config.key} must forbid pre-announcing`).toMatch(
        /Never pre-announce or narrate a step as complete/,
      );
      expect(p, `${config.key} must forbid narrating a failed step as complete`).toMatch(
        /never narrate a failed or still-pending step as if it completed/,
      );
    }
  });

  it("forbids inventing ids and requires reusing only tool-returned ids", () => {
    for (const config of SELF_SEEDED_CONFIGS) {
      const p = config.systemPrompt;
      expect(p, `${config.key} must require tool-returned ids only`).toMatch(
        /Use ONLY entity ids returned verbatim by a prior tool result/,
      );
      expect(p, `${config.key} must forbid guessing ids`).toMatch(
        /NEVER construct, guess, invent, or reuse an id from your own earlier prose/,
      );
      expect(p, `${config.key} must re-list on not-found`).toMatch(
        /re-run the read\/list tool to get the real current id/,
      );
    }
  });
});
