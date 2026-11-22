import { describe, it, expect } from "vitest";
import {
  buildMentionGraph,
  foldAlwaysReadIntoPrompt,
  foldChildrenIntoSkill,
  linksOfOffGraph,
  mentionToken,
  parseMentions,
  reachableSkills,
} from "../../src/lib/skill-mentions.js";
import { readSkillFrom, seedsAsRead, seedsWithChildMentions, skillIndexBlockFrom, SkillNotFoundError } from "../../src/lib/skills.js";
import { convertReferencesToMentions } from "../../src/lib/skill-mentions.js";
import { MERGED_SKILL_SLUGS } from "../../src/lib/skill-seed.js";
import { SEED_SKILLS } from "../../src/lib/skill-seed.js";
import { codeDistryDefinition, mentionableTools } from "../../src/agent/distry-config.js";
import { codePromptOverrides, resolveStoredPrompt } from "../../src/agent/distry-prompt.js";

// DISTRY-SKILL-MENTIONS-1122: skills are linked by @mentions in their text, rooted at Distry's Prompt.
const skill = (slug: string, content: string) => ({ slug, title: `T ${slug}`, description: `D ${slug}`, content });

describe("parsing mentions", () => {
  it("reads @skill and @tool tokens in text order, each once, stopping at punctuation", () => {
    const text = "Use @tool:run_operation, then read @skill:offers. Later @skill:campaigns and @skill:offers again; not @engine:x nor @skill:.";
    expect(parseMentions(text)).toEqual([
      { kind: "tool", ref: "run_operation" },
      { kind: "skill", ref: "offers" },
      { kind: "skill", ref: "campaigns" },
    ]);
    expect(mentionToken("skill", "new-account")).toBe("@skill:new-account");
  });
});

describe("the mention graph", () => {
  const live = [
    skill("a", "Start with @skill:b and @tool:read_skill, then @skill:ghost and @tool:nope."),
    skill("b", "Next: @skill:c. Back to @skill:a."),
    skill("c", "Leaf."),
    skill("island", "Mentions @skill:c but nothing mentions me."),
    skill("orphan-pair-1", "@skill:orphan-pair-2"),
    skill("orphan-pair-2", "@skill:orphan-pair-1"),
  ];
  const prompt = "You are Distry. Read @skill:a first.";
  const graph = buildMentionGraph(prompt, live, ["read_skill"]);

  it("serves each text's mentions in text order, flagged known", () => {
    expect(graph.prompt.mentions).toEqual([{ kind: "skill", ref: "a", known: true }]);
    expect(graph.skills.get("a")!.mentions).toEqual([
      { kind: "skill", ref: "b", known: true },
      { kind: "tool", ref: "read_skill", known: true },
      { kind: "skill", ref: "ghost", known: false },
      { kind: "tool", ref: "nope", known: false },
    ]);
  });

  it("serves who mentions each skill, never-mentioned, and reachable from the Prompt", () => {
    expect(graph.skills.get("a")).toMatchObject({ mentionedBy: { prompt: true, skills: ["b"] }, neverMentioned: false, reachable: true });
    expect(graph.skills.get("c")).toMatchObject({ mentionedBy: { prompt: false, skills: ["b", "island"] }, neverMentioned: false, reachable: true });
    expect(graph.skills.get("island")).toMatchObject({ mentionedBy: { prompt: false, skills: [] }, neverMentioned: true, reachable: false });
    // Mentioned by each other, but no chain from the Prompt: not never-mentioned, still unreachable.
    expect(graph.skills.get("orphan-pair-1")).toMatchObject({ neverMentioned: false, reachable: false });
    expect([...reachableSkills([prompt], live)].sort()).toEqual(["a", "b", "c"]);
  });

  it("a deleted skill's links: who still mentions it, never reachable", () => {
    expect(linksOfOffGraph(skill("ghost", "@skill:a"), prompt, live, [])).toEqual({
      mentions: [{ kind: "skill", ref: "a", known: true }],
      mentionedBy: { prompt: false, skills: ["a"] },
      neverMentioned: false,
      reachable: false,
    });
  });

  it("Engines are not mentionable tools", () => {
    expect(mentionableTools()).toContain("read_skill");
    expect(mentionableTools()).not.toContain("engines");
  });
});

describe("read_skill follows mentions from the Prompt", () => {
  const live = [skill("a", "See @skill:b and @tool:open_page."), skill("b", "B."), skill("hidden", "Nobody mentions me.")];
  const prompt = "Read @skill:a.";

  it("answers a reachable skill with what it mentions", () => {
    expect(readSkillFrom(live, "b", prompt)).toMatchObject({ slug: "b", mentions: [] });
    expect(readSkillFrom(live, "a", prompt).mentions).toEqual([{ skill: "b", title: "T b", description: "D b" }, { tool: "open_page" }]);
  });

  it("never offers a skill no chain from the Prompt reaches", () => {
    expect(() => readSkillFrom(live, "hidden", prompt)).toThrow(SkillNotFoundError);
  });

  it("the skill index lists only what the Prompt mentions", () => {
    const block = skillIndexBlockFrom(prompt, live);
    expect(block).toContain("- `a`: T a. D a");
    expect(block).not.toContain("`b`");
    expect(block).not.toContain("`hidden`");
  });
});

describe("the one-time move from the stored tree", () => {
  const tree = [
    { slug: "index", parentSlug: null, position: 0, content: "# Method\nThe map." },
    { slug: "client-comms", parentSlug: "index", position: 1, content: "# How we talk" },
    { slug: "offers", parentSlug: "index", position: 10, content: "Offers." },
    { slug: "staff", parentSlug: "index", position: 900, content: "Staff. See @skill:catalogue." },
    { slug: "catalogue", parentSlug: "staff", position: 1, content: "Cat." },
    { slug: "legs", parentSlug: "staff", position: 2, content: "Legs." },
  ];

  it("the Prompt carries the index and the voice, and mentions what the index mapped", () => {
    const folded = foldAlwaysReadIntoPrompt("You are Distry.", tree);
    expect(folded).toBe("You are Distry.\n\n# Method\nThe map.\n\n# How we talk\n\n## Skills you can read\n- @skill:offers\n- @skill:staff");
    // Already folded: unchanged.
    expect(foldAlwaysReadIntoPrompt(folded, tree)).toBe(folded);
  });

  it("a skill that had sub-skills mentions the ones it did not mention yet", () => {
    expect(foldChildrenIntoSkill(tree[3]!, tree)).toBe("Staff. See @skill:catalogue.\n\n## Read next\n- @skill:legs");
    expect(foldChildrenIntoSkill(tree[2]!, tree)).toBeNull();
    expect(foldChildrenIntoSkill(tree[0]!, tree)).toBeNull();
  });

  it("the code's Prompt reaches every seed skill the old tree reached (index and voice excepted)", () => {
    const prompt = codeDistryDefinition().systemPrompt;
    const seeds = seedsWithChildMentions(SEED_SKILLS);
    const reached = reachableSkills([prompt], seeds);
    for (const s of SEED_SKILLS) {
      if (s.slug === "index" || s.slug === "client-comms") continue;
      expect(reached.has(s.slug), s.slug).toBe(true);
    }
    // The voice is in the Prompt, its references written as mentions.
    expect(prompt).toContain("# How we talk to a person");
  });
});

describe("a stored skill-index text written for the old placeholders follows the code again", () => {
  it("drops a text whose placeholders the part no longer has", () => {
    const stored = { ...codePromptOverrides(), texts: { "skill-index": "## Skills\n{{indexSkill}}\n{{subSkills}}" } };
    expect(resolveStoredPrompt(stored).texts).toEqual({});
    const fresh = { ...codePromptOverrides(), texts: { "skill-index": "## My skills\n{{skills}}" } };
    expect(resolveStoredPrompt(fresh).texts).toEqual({ "skill-index": "## My skills\n{{skills}}" });
  });
});

describe("old-style references become mention tokens (owner 2026-11-22 « Je ne vois pas de @<> tag stylisé »)", () => {
  const skills = new Set(["client-comms", "campaigns", "gtm-factory", "staff"]);
  const tools = new Set(["request_staff", "run_operation", "read_skill"]);

  it("converts a backticked skill or tool, a bare hyphenated slug and a bare snake_case tool; counts them; idempotent", () => {
    const r = convertReferencesToMentions("Read `client-comms` then `campaigns`; call request_staff and `run_operation`. See gtm-factory.", skills, tools);
    expect(r.text).toBe("Read @skill:client-comms then @skill:campaigns; call @tool:request_staff and @tool:run_operation. See @skill:gtm-factory.");
    expect(r.converted).toBe(5);
    expect(convertReferencesToMentions(r.text, skills, tools)).toEqual({ text: r.text, converted: 0 });
  });

  it("leaves what is not a reference: bare one-word slugs, unknown names, paths, tokens, code blocks, calls in code", () => {
    const text = "staff and campaigns stay. `nope` stays. /v1/run_operation, run_operation_x, `run_operation(x)`, {{request_staff}}, @tool:read_skill.\n```\nrequest_staff\n```";
    expect(convertReferencesToMentions(text, skills, tools)).toEqual({ text, converted: 0 });
  });

  it("the seed as the boot writes it names no live seed skill or tool the old way", () => {
    const seedSlugs = new Set(SEED_SKILLS.map((s) => s.slug).filter((s) => !(s in MERGED_SKILL_SLUGS)));
    const toolSet = new Set(mentionableTools());
    const asRead = seedsAsRead(SEED_SKILLS, [...toolSet]);
    for (const s of asRead) expect(convertReferencesToMentions(s.content, seedSlugs, toolSet).converted, s.slug).toBe(0);
    const before = SEED_SKILLS.reduce((n, s) => n + convertReferencesToMentions(s.content, seedSlugs, toolSet).converted, 0);
    expect(before).toBeGreaterThan(0);
    // The code's Prompt too.
    expect(convertReferencesToMentions(codeDistryDefinition().systemPrompt, seedSlugs, toolSet).converted).toBe(0);
  });
});
