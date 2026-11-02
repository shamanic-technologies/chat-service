// ---------------------------------------------------------------------------
// The tools of a replayed turn, answered from the scenario: no account is
// read, nothing is written, sent or started. Skills are answered from the
// definition under test, our public site is read live (public pages), the
// client-UI tools are recorded as what the person would see.
// ---------------------------------------------------------------------------

import type { ToolExecutor } from "../lib/gemini-chat.js";
import { readOurWebsite } from "../lib/our-website.js";
import { readSkillFrom } from "../lib/skills.js";
import { parseChoicesArgs, parseChoicesIntro, OPEN_PAGE_TOOL_NAME, PRESENT_CHOICES_TOOL_NAME } from "../lib/ui-tools.js";
import type { AgentDefinition } from "./agent-turn.js";
import type { Scenario } from "./scenario.js";

export interface FixtureExecutor {
  executeTool: ToolExecutor;
  /** Text above the choice cards, when the turn ended on them. */
  uiText: () => string;
  /** Tools the model called that the scenario holds no answer for. */
  missing: () => string[];
}

export function fixtureExecutor(def: AgentDefinition, scenario: Scenario): FixtureExecutor {
  const served = new Map<string, number>();
  const missing = new Set<string>();
  let choicesText = "";

  const executeTool: ToolExecutor = async ({ name, args }) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (name === "read_skill") return { name, result: readSkillFrom(def.skills, a.slug) };
    if (name === "read_our_website") return { name, result: await readOurWebsite(a) };
    if (name === PRESENT_CHOICES_TOOL_NAME) {
      const record = parseChoicesArgs(a);
      choicesText = [parseChoicesIntro(a), ...record.choices.map((c, i) => `${i + 1}. ${c.label}`)].join("\n");
      return "input_request";
    }
    if (name === "request_user_input") {
      choicesText = typeof a.text === "string" ? a.text : "";
      return "input_request";
    }
    if (name === OPEN_PAGE_TOOL_NAME) return { name, result: { opened: true, page: a.page } };
    const recorded = scenario.fixtures[name];
    if (!recorded) {
      missing.add(name);
      return { name, result: { error: `No data for ${name} in this account right now.` } };
    }
    const i = served.get(name) ?? 0;
    served.set(name, i + 1);
    return { name, result: recorded[Math.min(i, recorded.length - 1)] };
  };

  return { executeTool, uiText: () => choicesText, missing: () => [...missing] };
}
