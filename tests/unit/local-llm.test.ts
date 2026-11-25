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
  localCostItems,
  servedLlmsFor,
  LocalRunnerError,
  resetLocalLlm,
  runLocally,
  startLocalLlm,
  declareLocalLlm,
  isLocalLlmOrg,
} from "../../src/lib/local-llm.js";
import { createMemoryLocalLlmStore, type LocalJobRow } from "../../src/lib/local-llm-store.js";
import { resolveModel } from "../../src/lib/anthropic.js";

const USAGE = { inputTokens: 100, outputTokens: 20 };

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
  requestKey: null,
  deliveredAt: null,
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
    expect(answerOutcome(schemaJob, { ok: true, model: "claude-sonnet-5-5", text: "x", usage: USAGE }).ok).toBe(false);
    expect(answerOutcome(schemaJob, { ok: true, model: "claude-sonnet-5-5", structured: { a: 1 }, usage: USAGE })).toMatchObject({ ok: true, result: { structured: { a: 1 } } });
    // LOCAL-CLAUDE-RATING-1116: an answer that cannot be stated under the model that ran is refused.
    expect(answerOutcome(schemaJob, { ok: true, model: "claude-sonnet-5-5", structured: { a: 1 } })).toMatchObject({ ok: false });
    // SOLO-PLAN-1125: a founder's plan may run a Claude model we do not price (claude -p reported `claude-opus-4-6[1m]`): used.
    expect(answerOutcome(schemaJob, { ok: true, model: "claude-opus-4-6[1m]", structured: { a: 1 }, usage: USAGE })).toMatchObject({ ok: true, model: "claude-opus-4-6" });
    expect(answerOutcome(schemaJob, { ok: true, model: "gpt-6", structured: { a: 1 }, usage: USAGE })).toMatchObject({ ok: false, error: expect.stringContaining("not a Claude model") });
    expect(answerOutcome(schemaJob, { ok: true, model: "claude-haiku-4-5", structured: { a: 1 }, usage: USAGE })).toMatchObject({ ok: false });
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
    // SOLO-PLAN-1125: the call stays queued for the runner; the resend below attaches to it.
    expect(localFailureResponse(err).body).toMatchObject({ answerKept: true, retryable: true });
    expect(store.jobs.size).toBe(1);

    process.env.LOCAL_LLM_PICKUP_WAIT_MS = "5000";
    const pending = runLocally({ orgId: "o", kind: "complete", route: "/complete", runId: null, call }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    const [claimed] = await store.claim("o", 1, new Date(), 60_000);
    expect(store.jobs.size).toBe(1);
    await store.submit(claimed.id, "o", claimed.leaseId!, { ok: false, error: "not signed in", model: null, usage: claimed.usage }, new Date());
    const failed = await pending;
    expect(failed.code).toBe("local_runner_failed");
    expect(localFailureResponse(failed).status).toBe(502);
    await declareLocalLlm("o", false, "u");
    expect(await isLocalLlmOrg("o")).toBe(false);
  });

  it("SOLO-PLAN-1125 AC1: a call left unanswered 90 minutes, then answered by the founder's routine, is used by its caller's resend", async () => {
    process.env.LOCAL_LLM_PICKUP_WAIT_MS = "30";
    const store = createMemoryLocalLlmStore();
    await startLocalLlm(store, { refresh: false });
    await declareLocalLlm("o", true, "u");
    const call = completeCall({ systemPrompt: "S", message: "write it", responseSchema: null, jsonMode: false, webSearch: false, model: "claude-haiku-5-5" });
    const first = await runLocally({ orgId: "o", kind: "complete", route: "/complete", runId: "run-1", call }).catch((e) => e);
    expect(first).toMatchObject({ code: "local_runner_waiting", answerKept: true });
    // 90 minutes pass: the job is still claimable (it lives 3 h).
    const [job] = [...store.jobs.values()];
    job.createdAt = new Date(job.createdAt.getTime() - 90 * 60_000);
    job.pickupDeadlineAt = new Date(job.pickupDeadlineAt.getTime() - 90 * 60_000);
    expect(job.status).toBe("pending");
    await store.touchRunner("o", new Date(), { name: "claude-routine", version: null, kind: "routine" });
    const [claimed] = await store.claim("o", 10, new Date(), 30 * 60_000);
    expect(claimed.id).toBe(job.id);
    await store.submit(claimed.id, "o", claimed.leaseId!, { ok: true, result: { text: "the late answer" }, model: "claude-haiku-5-5", usage: { ...claimed.usage, inputTokens: 9, outputTokens: 3 } }, new Date());
    // The caller resends the same call (its run is new): it gets the stored answer at once, no new job.
    const second = await runLocally({ orgId: "o", kind: "complete", route: "/complete", runId: "run-2", call });
    expect(second).toMatchObject({ jobId: job.id, text: "the late answer", model: "claude-haiku-5-5" });
    expect(store.jobs.size).toBe(1);
    // Delivered once: the same call made again later is new work.
    const third = await runLocally({ orgId: "o", kind: "complete", route: "/complete", runId: "run-3", call }).catch((e) => e);
    expect(third).toMatchObject({ code: "local_runner_waiting" });
    expect(store.jobs.size).toBe(2);
  });

  it("SOLO-PLAN-1125: a chat round still ends with its caller (its loop cannot resend)", async () => {
    process.env.LOCAL_LLM_PICKUP_WAIT_MS = "30";
    const store = createMemoryLocalLlmStore();
    await startLocalLlm(store, { refresh: false });
    const call = completeCall({ systemPrompt: "", message: "hi", responseSchema: null, jsonMode: false, webSearch: false, model: "claude-haiku-5-5" });
    const err = await runLocally({ orgId: "o", kind: "chat_round", route: "/chat", runId: null, call }).catch((e) => e);
    expect(err).toMatchObject({ code: "local_runner_waiting", answerKept: false });
    expect([...store.jobs.values()][0].status).toBe("expired");
  });

  it("refuses to ask the runner for Haiku 4.5", async () => {
    await startLocalLlm(createMemoryLocalLlmStore(), { refresh: false });
    await expect(runLocally({ orgId: "o", kind: "complete", route: "/complete", runId: null, call: { systemPrompt: "", prompt: "", jsonSchema: null, model: "claude-haiku-4-5", tools: [] } })).rejects.toThrow(/owner rule/);
  });
});

describe("LOCAL-CLAUDE-RATING-1116 — a local call states the model that ran", () => {
  it("SOLO-PLAN-1125: an unpriced Claude model that ran is stated under the model the call asked for", () => {
    const items = localCostItems({ jobId: "j9", model: "claude-opus-4-6", costModel: "claude-haiku-5-5", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, notionalCostUsd: null, durationMs: null } });
    expect(items.map((i) => i.costName)).toEqual(["anthropic-haiku-5.5-tokens-input", "anthropic-haiku-5.5-tokens-output"]);
    expect(items.every((i) => i.costSource === "org")).toBe(true);
  });

  const usage = (u: Partial<LocalJobRow["usage"]>): LocalJobRow["usage"] => ({
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, notionalCostUsd: null, durationMs: null, ...u,
  });

  it("names the Claude model's own catalog lines, as the org's own account, idempotent per job", () => {
    const items = localCostItems({ jobId: "j9", model: "claude-sonnet-5-5", usage: usage({ inputTokens: 500, outputTokens: 40, cacheReadTokens: 1000, cacheWriteTokens: 0 }) });
    expect(items).toEqual([
      { costName: "anthropic-sonnet-5.5-tokens-input", quantity: 500, costSource: "org", status: "actual", idempotencyKey: "local-llm:j9:anthropic-sonnet-5.5-tokens-input" },
      { costName: "anthropic-sonnet-5.5-tokens-cached-input", quantity: 1000, costSource: "org", status: "actual", idempotencyKey: "local-llm:j9:anthropic-sonnet-5.5-tokens-cached-input" },
      { costName: "anthropic-sonnet-5.5-tokens-output", quantity: 40, costSource: "org", status: "actual", idempotencyKey: "local-llm:j9:anthropic-sonnet-5.5-tokens-output" },
    ]);
    expect(items.every((i) => i.costSource === "org")).toBe(true);
  });

  it("refuses a model it cannot price and an answer without usage", () => {
    expect(() => localCostItems({ jobId: "j", model: "claude-haiku-4-5", usage: usage({ inputTokens: 1, outputTokens: 1 }) })).toThrow(/not a Claude model/);
    expect(() => localCostItems({ jobId: "j", model: "deepseek-flash", usage: usage({ inputTokens: 1, outputTokens: 1 }) })).toThrow(/not a Claude model/);
    expect(() => localCostItems({ jobId: "j", model: "claude-haiku-5-5", usage: usage({}) })).toThrow(/no token usage/);
  });

  it("served LLMs: a non-local org runs every LLM as stated", () => {
    const rows = servedLlmsFor(["openai/gpt-sol", "deepseek/deepseek-flash", "anthropic/claude-haiku"], false);
    expect(rows.map((r) => r.runsAsStated)).toEqual([true, true, true]);
    expect(rows[1].servedBy).toMatchObject({ llm: "deepseek/deepseek-flash", provider: "deepseek", dynasty: "deepseek-flash" });
  });

  it("served LLMs: a local org runs Claude models as themselves, every other LLM on the Claude model of its tier", () => {
    const rows = servedLlmsFor(["anthropic/claude-opus", "anthropic/claude-haiku", "deepseek/deepseek-flash", "openai/gpt-sol"], true);
    expect(rows[0]).toMatchObject({ runsAsStated: true, servedBy: { llm: "anthropic/claude-opus", modelId: "claude-opus-5-5" } });
    expect(rows[1]).toMatchObject({ runsAsStated: true, servedBy: { modelId: "claude-haiku-5-5" } });
    // The same mapping the calls use (tier is data per alias).
    for (const [i, llm] of [[2, "deepseek/deepseek-flash"], [3, "openai/gpt-sol"]] as const) {
      const [p, m] = llm.split("/");
      const expected = localClaudeModelFor(resolveModel(p as "deepseek", m), p as "deepseek", m);
      expect(rows[i]).toMatchObject({ runsAsStated: false, servedBy: { provider: "anthropic", modelId: expected } });
      expect(rows[i].servedBy!.modelId).not.toMatch(/haiku-4-5/);
    }
  });

  it("WEBSEARCH-PICK-1119: served LLMs say which model takes a web-search or image request", () => {
    const plain = servedLlmsFor(["deepseek/deepseek-flash"], false);
    expect(plain[0]).not.toHaveProperty("acceptsRequest");
    const ws = servedLlmsFor(["deepseek/deepseek-flash", "zai/glm", "anthropic/claude-sonnet", "google/gemini-argon"], false, { webSearch: true });
    expect(ws.map((r) => r.acceptsRequest)).toEqual([false, false, true, true]);
    // A local org's runner (Claude) searches the web for every LLM, but takes no image.
    expect(servedLlmsFor(["deepseek/deepseek-flash"], true, { webSearch: true })[0].acceptsRequest).toBe(true);
    expect(servedLlmsFor(["deepseek/deepseek-flash"], true, { imageUrl: true })[0].acceptsRequest).toBe(false);
  });

  it("served LLMs: an LLM this service does not serve is named, the others still answer", () => {
    const rows = servedLlmsFor(["nope/x", "bad", "anthropic/claude-sonnet"], true);
    expect(rows[0]).toMatchObject({ runsAsStated: null, error: expect.any(String) });
    expect(rows[1]).toMatchObject({ runsAsStated: null, error: expect.stringContaining("provider/model") });
    expect(rows[2].runsAsStated).toBe(true);
  });
});
