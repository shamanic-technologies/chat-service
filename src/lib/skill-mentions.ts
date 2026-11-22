// ---------------------------------------------------------------------------
// Skills are linked by MENTIONS, not by a stored tree (DISTRY-SKILL-MENTIONS-1122,
// owner 2026-11-22 « dans le texte des skills pouvoir afficher un tag d'une autre
// skill, en mode @<xxx> »; « cet arbre se redessine dynamiquement à chaque fois
// qu'on CRUD des @mentions »).
//
// A text (Distry's Prompt, or a skill) mentions a skill as `@skill:<slug>` and a
// tool as `@tool:<name>`. The slug never changes (a title rename keeps every
// mention). The structure is WHO MENTIONS WHOM, recomputed from the texts on
// every read: nothing else is stored.
//
// ONE text is read on every turn: Distry's Prompt. Distry reaches a skill by
// following mentions from it (the Prompt, then each skill it loads); a skill
// nothing reachable mentions is never offered. Engines are NOT mentionable:
// calling one is a tool, and Distry calls a campaign.
// ---------------------------------------------------------------------------

export type MentionKind = "skill" | "tool";

export interface Mention {
  kind: MentionKind;
  /** The skill's slug or the tool's name. */
  ref: string;
}

// A slug: lowercase words joined by single hyphens; a tool name: lowercase words joined by `_`.
// The trailing class stops before punctuation that ends a sentence (`@skill:offers.`).
const MENTION_RE = /@(skill|tool):([a-z0-9]+(?:[-_][a-z0-9]+)*)/g;

/** The token a text carries for a mention. */
export function mentionToken(kind: MentionKind, ref: string): string {
  return `@${kind}:${ref}`;
}

/** Every mention in a text, in text order, each once (first place it appears). */
export function parseMentions(text: string): Mention[] {
  const seen = new Set<string>();
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: m[1] as MentionKind, ref: m[2]! });
  }
  return out;
}

export function mentionedSkillSlugs(text: string): string[] {
  return parseMentions(text).filter((m) => m.kind === "skill").map((m) => m.ref);
}

/** What the graph needs of a skill. */
export interface MentionNode {
  slug: string;
  content: string;
}

/** A mention as served to the editor: `known` = it names a live skill / a tool Distry can call. */
export interface ServedMention extends Mention {
  known: boolean;
}

export interface SkillLinks {
  /** What this skill's text mentions, in text order (itself excluded). */
  mentions: ServedMention[];
  /** Who mentions it: the Prompt, and the live skills whose text does (sorted). */
  mentionedBy: { prompt: boolean; skills: string[] };
  /** No text mentions it (not the Prompt, no other live skill). Distry never reads it. */
  neverMentioned: boolean;
  /** Distry reaches it by following mentions from the Prompt. */
  reachable: boolean;
}

export interface MentionGraph {
  prompt: { mentions: ServedMention[] };
  /** Per live skill slug. */
  skills: Map<string, SkillLinks>;
}

/**
 * Skills reachable from the root texts by following mentions (the root itself is
 * not a skill). `resolve` maps a mentioned slug to the live slug it reads (a
 * merged slug answers the skill it went into), or null when nothing live answers.
 */
export function reachableSkills(
  rootTexts: readonly string[],
  live: readonly MentionNode[],
  resolve: (slug: string) => string | null = (s) => s,
): Set<string> {
  const bySlug = new Map(live.map((s) => [s.slug, s]));
  const reached = new Set<string>();
  const queue: string[] = [];
  const visit = (text: string) => {
    for (const slug of mentionedSkillSlugs(text)) {
      const target = resolve(slug);
      if (!target || reached.has(target) || !bySlug.has(target)) continue;
      reached.add(target);
      queue.push(target);
    }
  };
  for (const t of rootTexts) visit(t);
  while (queue.length > 0) visit(bySlug.get(queue.shift()!)!.content);
  return reached;
}

/** A text's mentions in text order, each flagged `known` (a live skill, a mentionable tool); `self` is left out. */
export function servedMentions(
  text: string,
  self: string | null,
  live: readonly Pick<MentionNode, "slug">[],
  toolNames: readonly string[],
  resolve: (slug: string) => string | null = (s) => s,
): ServedMention[] {
  const liveSlugs = new Set(live.map((s) => s.slug));
  return parseMentions(text)
    .filter((m) => !(m.kind === "skill" && (m.ref === self || resolve(m.ref) === self)))
    .map((m) => {
      if (m.kind === "tool") return { ...m, known: toolNames.includes(m.ref) };
      const t = resolve(m.ref);
      return { ...m, known: t !== null && liveSlugs.has(t) };
    });
}

/**
 * Links of a skill that is NOT live (deleted): what its text mentions, who still
 * mentions it (those mentions lead nowhere until it comes back), never reachable.
 */
export function linksOfOffGraph(
  skill: MentionNode,
  prompt: string,
  live: readonly MentionNode[],
  toolNames: readonly string[],
  resolve: (slug: string) => string | null = (s) => s,
): SkillLinks {
  const cites = (text: string) => mentionedSkillSlugs(text).includes(skill.slug);
  const by = live.filter((o) => o.slug !== skill.slug && cites(o.content)).map((o) => o.slug).sort();
  const fromPrompt = cites(prompt);
  return {
    mentions: servedMentions(skill.content, skill.slug, live, toolNames, resolve),
    mentionedBy: { prompt: fromPrompt, skills: by },
    neverMentioned: !fromPrompt && by.length === 0,
    reachable: false,
  };
}

/**
 * The whole graph the editor shows: the Prompt's mentions, then per live skill
 * its mentions (in text order), who mentions it, never-mentioned and reachable.
 */
export function buildMentionGraph(
  prompt: string,
  live: readonly MentionNode[],
  toolNames: readonly string[],
  resolve: (slug: string) => string | null = (s) => s,
): MentionGraph {
  const served = (text: string, self: string | null) => servedMentions(text, self, live, toolNames, resolve);
  const mentionsOf = (text: string, self: string | null): Set<string> =>
    new Set(
      mentionedSkillSlugs(text)
        .map((s) => resolve(s))
        .filter((s): s is string => s !== null && s !== self),
    );

  const promptTargets = mentionsOf(prompt, null);
  const targetsBySkill = new Map(live.map((s) => [s.slug, mentionsOf(s.content, s.slug)]));
  const reached = reachableSkills([prompt], live, resolve);

  const skills = new Map<string, SkillLinks>();
  for (const s of live) {
    const by = live.filter((o) => o.slug !== s.slug && targetsBySkill.get(o.slug)!.has(s.slug)).map((o) => o.slug).sort();
    const fromPrompt = promptTargets.has(s.slug);
    skills.set(s.slug, {
      mentions: served(s.content, s.slug),
      mentionedBy: { prompt: fromPrompt, skills: by },
      neverMentioned: !fromPrompt && by.length === 0,
      reachable: reached.has(s.slug),
    });
  }
  return { prompt: { mentions: served(prompt, null) }, skills };
}

/** What the fold reads of a skill: its text and where the old stored tree placed it. */
export interface FoldNode {
  slug: string;
  parentSlug: string | null;
  position: number;
  content: string;
}

const INDEX = "index";
const VOICE = "client-comms";

/** `- @skill:<slug>` lines for the given slugs. */
export function mentionLines(slugs: readonly string[]): string {
  return slugs.map((s) => `- ${mentionToken("skill", s)}`).join("\n");
}

function childrenOf(all: readonly FoldNode[], parent: string, skip: ReadonlySet<string>): string[] {
  return all
    .filter((s) => s.parentSlug === parent && !skip.has(s.slug))
    .sort((a, b) => a.position - b.position || a.slug.localeCompare(b.slug))
    .map((s) => s.slug);
}

/**
 * The one-time move from the stored tree to mentions, for the PROMPT: the two
 * skills every turn used to read (`index` = the method and map, `client-comms` =
 * the voice) join the Prompt's text, and the Prompt mentions what `index` mapped.
 * A prompt that already mentions a skill is returned unchanged (already folded).
 */
export function foldAlwaysReadIntoPrompt(prompt: string, all: readonly FoldNode[]): string {
  if (mentionedSkillSlugs(prompt).length > 0) return prompt;
  const index = all.find((s) => s.slug === INDEX);
  const voice = all.find((s) => s.slug === VOICE);
  const children = childrenOf(all, INDEX, new Set([VOICE]));
  const parts = [prompt.trimEnd()];
  if (index) parts.push(index.content.trim());
  if (voice) parts.push(voice.content.trim());
  if (children.length > 0) parts.push(`## Skills you can read\n${mentionLines(children)}`);
  return parts.join("\n\n");
}

/**
 * The same move for a SKILL that had sub-skills in the stored tree: its text
 * gains a mention of each sub-skill it does not mention yet, so Distry still
 * reaches them. Null when nothing is missing. `index` is folded into the Prompt.
 */
export function foldChildrenIntoSkill(skill: FoldNode, all: readonly FoldNode[]): string | null {
  if (skill.slug === INDEX) return null;
  const already = new Set(mentionedSkillSlugs(skill.content));
  const missing = childrenOf(all, skill.slug, new Set()).filter((s) => !already.has(s));
  if (missing.length === 0) return null;
  return `${skill.content.trimEnd()}\n\n## Read next\n${mentionLines(missing)}`;
}
