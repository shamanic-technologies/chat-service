// ---------------------------------------------------------------------------
// The tools of a replayed turn, answered from the scenario: no account is
// read, nothing is written, sent or started. Skills are answered from the
// definition under test, our public site is read live (public pages), the
// client-UI tools are recorded as what the person would see.
// ---------------------------------------------------------------------------

import type { ToolExecutor } from "../lib/gemini-chat.js";
import { REACH_ELSEWHERE_TOOL_NAME } from "../lib/lead-contact.js";
import { LEAD_ANSWER_TOOL_NAME } from "../lib/lead-turn.js";
import { readOurWebsite } from "../lib/our-website.js";
import { readSkillFrom } from "../lib/skills.js";
import { parseChoicesArgs, parseChoicesIntro, OPEN_PAGE_TOOL_NAME, PRESENT_CHOICES_TOOL_NAME } from "../lib/ui-tools.js";
import { CALL_API_TOOL_NAME, DESCRIBE_API_TOOL_NAME, FIND_API_TOOL_NAME, answerForModel, describeApi, failedCallAnswer, findApi, needsYes, yesProposal, operationsForTool, pathParamsFrom, toolsForOperation } from "../agent/catalogue-tools.js";
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
  /** The gateway acts this replay answered as done ("POST /v1/sales-funnel-campaigns"). */
  const acted = new Set<string>();
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
    // A lead turn's answer ends the turn; what the person receives is read from it.
    if (name === LEAD_ANSWER_TOOL_NAME && scenario.lead) {
      const field = String((scenario.lead.payload as { messageField?: unknown }).messageField ?? "message");
      choicesText = leadAnswerForJudge(a, field);
      return "input_request";
    }
    if (name === REACH_ELSEWHERE_TOOL_NAME) return { name, result: { stated: true, note: "Recorded (replay: nothing written)." } };
    if (name === FIND_API_TOOL_NAME) return { name, result: await findApi(a) };
    if (name === DESCRIBE_API_TOOL_NAME) return { name, result: await describeApi(a) };
    if (name === CALL_API_TOOL_NAME) return { name, result: await replayCallApi(a) };
    const recorded = scenario.fixtures[name];
    if (!recorded) {
      missing.add(name);
      return { name, result: { error: `No data for ${name} in this account right now.` } };
    }
    return { name, result: nextAnswer(name, recorded) };
  };

  /**
   * A recorded gateway answer may say which request it answers (`_when`: query / path values it
   * needs, "the conversation of edgar@..."): the first match is served, else the one with no `_when`.
   * Answers without `_when` are served in the order the real session got them.
   */
  function answerFor(key: string, all: unknown[], asked: Record<string, string>): unknown {
    // The account after an act of this turn (`_after: "POST /v1/..."`): once the replay served that
    // act, its answers replace the ones from before it (a campaign created, then listed).
    const after = (r: unknown) => (r && typeof r === "object" && "_after" in r ? String((r as { _after: unknown })._after) : null);
    const later = all.filter((r) => after(r) !== null && acted.has(after(r)!));
    const recorded = (later.length ? later : all.filter((r) => after(r) === null)).map((r) => {
      if (after(r) === null) return r;
      const { _after, ...rest } = r as Record<string, unknown>;
      return rest;
    });
    const cond = (r: unknown) => (r && typeof r === "object" && "_when" in r ? ((r as { _when: Record<string, unknown> })._when ?? {}) : null);
    if (!recorded.some((r) => cond(r) !== null)) return nextAnswer(key, recorded);
    const hit =
      recorded.find((r) => {
        const c = cond(r);
        return c !== null && Object.entries(c).every(([k, v]) => String(asked[k] ?? "").toLowerCase() === String(v).toLowerCase());
      }) ?? recorded.find((r) => cond(r) === null);
    if (hit === undefined) return { error: "No data for this request in this account right now." };
    if (cond(hit) === null) return hit;
    const { _when, ...rest } = hit as Record<string, unknown>;
    return rest;
  }

  /** The recorded answers of a tool in the order the real session got them (the last one repeats). */
  function nextAnswer(name: string, recorded: unknown[]): unknown {
    const i = served.get(name) ?? 0;
    served.set(name, i + 1);
    return recorded[Math.min(i, recorded.length - 1)];
  }

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
    // The query as production sends it, so the answer names an undocumented filter the same way.
    const query = Object.fromEntries(
      Object.entries((a.query ?? {}) as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
    );
    // A scenario may record the gateway answer itself, keyed "METHOD /path" (an act no chat tool does).
    const direct = `${op.method} ${op.path}`;
    const pathParams: Record<string, unknown> = concretePath && !a.operationId ? pathParamsFrom(op.path, concretePath) : ((a.pathParams ?? {}) as Record<string, unknown>);
    const asked: Record<string, string> = { ...query, ...Object.fromEntries(Object.entries(pathParams).map(([k, v]) => [k, String(v)])) };
    // As production proposes it: the gateway's own words on what the act does.
    if (needsYes(op, a.body)) {
      const path = op.path.replace(/\{([^}]+)\}/g, (_, n: string) => String(pathParams[n] ?? `{${n}}`));
      return yesProposal(op, { operationId: op.operationId, method: op.method, path, query, body: a.body }, `replay-${op.operationId}`);
    }
    for (const key of [direct, ...toolsForOperation(op.method, op.path)]) {
      const recorded = scenario.fixtures[key];
      // Same order as the chat tool: a stop then a re-read sees the stopped list. Cut as production cuts it.
      if (recorded) {
        const answer = answerFor(key, recorded, asked);
        // A recorded refusal (`_status` >= 400: the 503 production got) answers as production answers one.
        const status = answer && typeof answer === "object" && "_status" in answer ? Number((answer as { _status: unknown })._status) : 200;
        if (status >= 400) {
          const { _status, ...error } = answer as Record<string, unknown>;
          return failedCallAnswer(status, error);
        }
        acted.add(key);
        return answerForModel(op, query, status, answer);
      }
    }
    missing.add(`run_operation ${op.method} ${op.path}`);
    return { ok: false, status: 404, error: "No data for this request in this account right now." };
  }

  return { executeTool, uiText: () => choicesText, missing: () => [...missing] };
}

/**
 * What the judge reads of a lead answer: the text the person receives, or, when
 * nothing goes out now, the decision in plain words (never a JSON blob the
 * judge would grade as a message).
 */
export function leadAnswerForJudge(answer: Record<string, unknown>, messageField: string): string {
  const sent = answer[messageField];
  if (typeof sent === "string" && sent.trim()) return sent;
  const words = (k: string) => (typeof answer[k] === "string" && (answer[k] as string).trim() ? (answer[k] as string).trim() : null);
  const reason = words("reason") ?? words("why") ?? words("nextFollowUpWhy");
  const next = words("nextFollowUpAt");
  return ["Nothing sent to them now.", reason ? `Reason: ${reason}` : null, next ? `Next look: ${next}.` : null].filter(Boolean).join(" ");
}
