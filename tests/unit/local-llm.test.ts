import { describe, it, expect, afterEach } from "vitest";
import {
  answerOutcome,
  chatRoundAnswer,
  chatRoundCall,
  completeCall,
  judgmentAnswers,
  judgmentCall,
  localClaudeModelFor,
  localFailureResponse,
  LocalRunnerError,
  resetLocalLlm,
  runLocally,
  startLocalLlm,
  declareLocalLlm,
  isLocalLlmOrg,
} from "../../src/lib/local-llm.js";
import { createMemoryLocalLlmStore, type LocalJobRow } from "../../src/lib/local-llm-store.js";
import { resolveModel } from "../../src/lib/anthropic.js";

const jobWith = (request: unknown): LocalJobRow => ({
  id: "j1",
  orgId: "o",
  kind: "complete",
  route: "/complete",
  runId: null,
  request,
  status: "claimed",
  leaseId: "l",
  pickupDeadlineAt: new Date(),
  answerDeadlineAt: new Date(),
  claimedAt: new Date(),
  completedAt: null,
  result: null,
  error: null,
  model: null,
  usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, notionalCostUsd: null, durationMs: null },
  createdAt: new Date(),
});

afterEach(() => {
  resetLocalLlm();
  delete process.env.LOCAL_LLM_PICKUP_WAIT_MS;
});

describe("local LLM — model choice", () => {
  it("keeps a Claude model, maps any other by its recorded tier, never Haiku 4.5", () => {
    expect(localClaudeModelFor(resolveModel("anthropic", "claude-sonnet"), "anthropic", "claude-sonnet")).toBe("claude-sonnet-5-5");
    expect(localClaudeModelFor(resolveModel("google", "flash-pro"), "google", "flash-pro")).toBe("claude-haiku-5-5");
    expect(localClaudeModelFor({ provider: "anthropic", apiModelId: "claude-haiku-4-5" }, "anthropic", "claude-haiku")).toBe("claude-haiku-5-5");
  });
});

describe("local LLM — work items", () => {
  it("a completion carries the caller's prompt byte-equal, WebSearch only when asked", () => {
    expect(completeCall({ systemPrompt: "S", message: "M", responseSchema: null, jsonMode: false, webSearch: true, model: "m" }))
      .toEqual({ systemPrompt: "S", prompt: "M", jsonSchema: null, model: "m", tools: ["WebSearch"] });
    expect(completeCall({ systemPrompt: undefined, message: "M", responseSchema: undefined, jsonMode: true, webSearch: false, model: "m" }).jsonSchema)
      .toEqual({ type: "object" });
  });

  it("a judgment asks one probability per option and comes back in the judge's answer shapes", () => {
    const questions = {
      u: { type: "noul" as const, instructions: "Urgent?" },
      t: { type: "choice" as const, instructions: "Team?", criteria: { a: "A", b: { what: "B", examples: ["x"] } } },
      s: { type: "score" as const, instructions: "Severity?", criteria: ["low", "mid", "high"] },
    };
    const call = judgmentCall({ ticket: "x" }, questions);
    expect(call.model).toBe("claude-haiku-5-5");
    expect(Object.keys((call.jsonSchema!.properties as Record<string, { properties: object }>).s.properties)).toEqual(["1", "2", "3"]);
    const answers = judgmentAnswers(questions, { u: { yes: 2, no: 2 }, t: { a: 0.2, b: 0.8 }, s: { "1": 0, "2": 0, "3": 1 } });
    expect(answers.u).toEqual({ type: "noul", noul: 0.5 });
    expect(answers.t).toEqual({ type: "choice", choice: "b", confidence: 0.8, probabilities: { a: 0.2, b: 0.8 } });
    expect(answers.s).toMatchObject({ type: "score", score: 3, confidence: 1, legend: { "1": "low", "2": "mid", "3": "high" } });
    expect(() => judgmentAnswers(questions, { u: { yes: 1 } })).toThrow();
  });

  it("a chat round puts the tools and the protocol in the system prompt and reads tool calls back", () => {
    const call = chatRoundCall(
      [
        { role: "system", content: "You are Sophie." },
        { role: "user", content: "Workflows?" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "list_workflows", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: '{"workflows":[]}' },
        { role: "system", content: "Page: home" },
      ],
      [{ name: "list_workflows", description: "Lists workflows", input_schema: { properties: {} } }],
      "claude-haiku-5-5",
    );
    expect(call.systemPrompt.startsWith("You are Sophie.")).toBe(true);
    expect(call.systemPrompt).toContain("### list_workflows");
    expect(call.prompt).toContain("[result of list_workflows]");
    expect(call.prompt).toContain("[context]\nPage: home");
    const step = chatRoundAnswer(
      { jobId: "j", model: "m", text: null, usage: jobWith(null).usage, structured: { text: "", toolCalls: [{ name: "list_workflows", input: { limit: 2 } }] } },
      true,
    );
    expect(step.toolCalls).toEqual([{ name: "list_workflows", input: { limit: 2 } }]);
    expect(chatRoundCall([{ role: "user", content: "hi" }], [], "m").jsonSchema).toBeNull();
  });
});

describe("local LLM — answers", () => {
  it("refuses an answer that names no model, a banned model, or misses its structured value", () => {
    const schemaJob = jobWith({ jsonSchema: { type: "object" } });
    expect(answerOutcome(schemaJob, { ok: true, structured: { a: 1 } }).ok).toBe(false);
    expect(answerOutcome(schemaJob, { ok: true, model: "claude-haiku-4-5-20251001", structured: { a: 1 } }).ok).toBe(false);
    expect(answerOutcome(schemaJob, { ok: true, model: "claude-sonnet-5-5", text: "x" }).ok).toBe(false);
    expect(answerOutcome(schemaJob, { ok: true, model: "claude-sonnet-5-5", structured: { a: 1 } })).toMatchObject({ ok: true, result: { structured: { a: 1 } } });
    expect(answerOutcome(jobWith({ jsonSchema: null }), { ok: false, error: "CLI not signed in" })).toMatchObject({ ok: false, error: "CLI not signed in" });
  });

  it("a runner failure is a named 502, a waiting runner a named 503", async () => {
    process.env.LOCAL_LLM_PICKUP_WAIT_MS = "50";
    const store = createMemoryLocalLlmStore();
    await startLocalLlm(store, { refresh: false });
    await declareLocalLlm("o", true, "u");
    expect(await isLocalLlmOrg("o")).toBe(true);
    const call = completeCall({ systemPrompt: "", message: "m", responseSchema: null, jsonMode: false, webSearch: false, model: "claude-haiku-5-5" });
    const err = await runLocally({ orgId: "o", kind: "complete", route: "/complete", runId: null, call }).catch((e) => e);
    expect(err).toBeInstanceOf(LocalRunnerError);
    expect(localFailureResponse(err).status).toBe(503);

    process.env.LOCAL_LLM_PICKUP_WAIT_MS = "5000";
    const pending = runLocally({ orgId: "o", kind: "complete", route: "/complete", runId: null, call }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    const [claimed] = await store.claim("o", 1, new Date());
    await store.submit(claimed.id, "o", claimed.leaseId!, { ok: false, error: "not signed in", model: null, usage: claimed.usage }, new Date());
    const failed = await pending;
    expect(failed.code).toBe("local_runner_failed");
    expect(localFailureResponse(failed).status).toBe(502);
    await declareLocalLlm("o", false, "u");
    expect(await isLocalLlmOrg("o")).toBe(false);
  });

  it("refuses to ask the runner for Haiku 4.5", async () => {
    await startLocalLlm(createMemoryLocalLlmStore(), { refresh: false });
    await expect(runLocally({ orgId: "o", kind: "complete", route: "/complete", runId: null, call: { systemPrompt: "", prompt: "", jsonSchema: null, model: "claude-haiku-4-5", tools: [] } })).rejects.toThrow(/owner rule/);
  });
});
