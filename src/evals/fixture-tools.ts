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
import { CALL_API_TOOL_NAME, DESCRIBE_API_TOOL_NAME, FIND_API_TOOL_NAME, describeApi, findApi, needsYes, operationsForTool, toolsForOperation } from "../agent/catalogue-tools.js";
import { findOperation, getCatalog, matchPath } from "../agent/catalogue.js";
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
    if (name === FIND_API_TOOL_NAME) return { name, result: await findApi(a) };
    if (name === DESCRIBE_API_TOOL_NAME) return { name, result: await describeApi(a) };
    if (name === CALL_API_TOOL_NAME) return { name, result: await replayCallApi(a) };
    const recorded = scenario.fixtures[name];
    if (!recorded) {
      missing.add(name);
      return { name, result: { error: `No data for ${name} in this account right now.` } };
    }
    const i = served.get(name) ?? 0;
    served.set(name, i + 1);
    return { name, result: recorded[Math.min(i, recorded.length - 1)] };
  };

  /**
   * A gateway call in a replay is answered with what the account answered the
   * chat tool doing the same act (COPILOT_TOOL_API_OPS): same source of truth,
   * the chat tool's projection of it. Nothing is sent; an operation needing
   * the person's yes answers its proposal, as in production.
   */
  async function replayCallApi(a: Record<string, unknown>): Promise<unknown> {
    if (typeof a.confirmationToken === "string" && a.confirmationToken.trim()) return { ok: true, status: 200, data: { done: true } };
    const { operations } = await getCatalog();
    const concretePath = typeof a.path === "string" ? a.path.split("?")[0] : null;
    const op =
      findOperation(operations, { operationId: String(a.operationId ?? "") }) ??
      (concretePath ? (matchPath(operations, String(a.method ?? "GET"), concretePath)?.operation ?? null) : null);
    if (!op) {
      const known = operationsForTool(String(a.operationId ?? ""), operations);
      throw new Error(`[run_operation] no operation "${String(a.operationId ?? concretePath)}" in the client API: ${known.length ? `that act is ${known.map((o) => `${o.operationId} (${o.method} ${o.path})`).join(" or ")}` : "use find_operation"}`);
    }
    if (needsYes(op, a.body)) {
      return { yesRequired: true, confirmationToken: `replay-${op.operationId}`, request: { operationId: op.operationId }, instruction: "Nothing ran. Ask the person yes or no first." };
    }
    for (const tool of toolsForOperation(op.method, op.path)) {
      const recorded = scenario.fixtures[tool];
      if (recorded) return { ok: true, status: 200, data: recorded[0] };
    }
    missing.add(`run_operation ${op.method} ${op.path}`);
    return { ok: false, status: 404, error: "No data for this request in this account right now." };
  }

  return { executeTool, uiText: () => choicesText, missing: () => [...missing] };
}
