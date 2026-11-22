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
import { readSkillFrom, seedsWithChildMentions, skillIndexBlockFrom, SkillNotFoundError } from "../../src/lib/skills.js";
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
    expect(prompt).toContain(SEED_SKILLS.find((s) => s.slug === "client-comms")!.content.trim());
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
