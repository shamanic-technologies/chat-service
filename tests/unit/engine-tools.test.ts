import { describe, it, expect, vi } from "vitest";
import {
  engineToolsFrom,
  engineToolName,
  callEngine,
  listEngines,
  READ_ENGINE_CALL_TOOL_NAME,
  type EngineListing,
  type WorkflowFetch,
} from "../../src/agent/engine-tools.js";
import { isPrincipalToolName } from "../../src/agent/principal-tools.js";

const engines: EngineListing[] = [
  { outcome: "linkedin_post_published", name: "LinkedIn post published", callable: true, reason: null, inputs: [{ units: [], channel: null }] },
  { outcome: "message_written", name: "Message written", callable: true, reason: null, inputs: [{ units: ["lead_found"], channel: "email" }, { units: ["lead_found"], channel: "whatsapp" }] },
  { outcome: "backlink_earned", name: "Backlink earned", callable: false, reason: "No script can run now.", inputs: [] },
];

const target = { orgId: "org-1", userId: "user-1", brandId: "brand-1", runId: "run-1" };

describe("Distry's Engine tools come from the live list (DISTRY-PRINCIPAL-1119)", () => {
  it("one tool per callable Engine, plus the call reader; none for an Engine that cannot run", () => {
    const { tools, outcomeOf } = engineToolsFrom(engines);
    expect(tools.map((t) => t.name)).toEqual(["engine__linkedin_post_published", "engine__message_written", READ_ENGINE_CALL_TOOL_NAME]);
    expect(outcomeOf.get("engine__message_written")).toBe("message_written");
    expect(tools.every((t) => isPrincipalToolName(t.name))).toBe(true);
    const writer = tools[1];
    expect(writer.description).toContain("hand Units of: lead_found, channel email");
    expect((writer.input_schema.properties as Record<string, { enum?: string[] }>).channel.enum).toEqual(["email", "whatsapp"]);
    expect((tools[0].input_schema.properties as Record<string, unknown>).units).toBeUndefined();
  });

  it("no callable Engine = no tool at all", () => {
    expect(engineToolsFrom([engines[2]]).tools).toEqual([]);
  });

  it("tool names are safe for every model API", () => {
    expect(engineToolName("LinkedIn post: published!")).toBe("engine__LinkedIn_post_published_");
    expect(engineToolName("x".repeat(100)).length).toBe(64);
  });

  it("listing fails loud on an unreadable answer", async () => {
    const broken: WorkflowFetch = async () => new Response("down", { status: 502 });
    await expect(listEngines(broken)).rejects.toThrow(/engine list 502/);
  });
});

describe("calling an Engine waits for the Unit", () => {
  it("pick → run → result: the Unit when the call ends in time, under the caller's identity", async () => {
    const seen: Array<{ path: string; headers?: Record<string, string>; body?: string }> = [];
    const fetchImpl: WorkflowFetch = vi.fn(async (path, init) => {
      seen.push({ path, headers: init.headers, body: init.body });
      return new Response(JSON.stringify({ callId: "11111111-1111-1111-1111-111111111111", status: "made", ended: true, unit: { text: "Hello" }, error: null, pick: { dynasty: "post-writer" } }));
    });
    const out = await callEngine("linkedin_post_published", { request: { topic: "AI" } }, target, fetchImpl);
    expect(out).toMatchObject({ status: "made", unit: { text: "Hello" } });
    expect(seen[0].path).toBe("/internal/engines/linkedin_post_published/calls");
    expect(seen[0].headers).toMatchObject({ "x-org-id": "org-1", "x-run-id": "run-1", "x-brand-id": "brand-1" });
    expect(JSON.parse(seen[0].body!)).toMatchObject({ request: { topic: "AI" }, waitSeconds: 60, subject: { service: "chat-service", id: "run-1" } });
  });

  it("a long Engine: 202, then polled until it ends", async () => {
    let n = 0;
    const fetchImpl: WorkflowFetch = async (path) => {
      n++;
      if (path.endsWith("/calls")) return new Response(JSON.stringify({ callId: "11111111-1111-1111-1111-111111111111", status: "running", ended: false }), { status: 202 });
      return new Response(JSON.stringify({ callId: "11111111-1111-1111-1111-111111111111", status: n >= 3 ? "made" : "running", ended: n >= 3, unit: n >= 3 ? { id: "u" } : null }));
    };
    const out = await callEngine("message_written", {}, target, fetchImpl);
    expect(out).toMatchObject({ status: "made", ended: true });
    expect(n).toBe(3);
  });

  it("timeout: still running after the budget answers the callId to read later", async () => {
    const fetchImpl: WorkflowFetch = async () => new Response(JSON.stringify({ callId: "11111111-1111-1111-1111-111111111111", status: "running", ended: false }), { status: 202 });
    const out = await callEngine("message_written", {}, target, fetchImpl, 120);
    expect(out).toMatchObject({ ended: false, callId: "11111111-1111-1111-1111-111111111111" });
    expect(String(out.note)).toContain(READ_ENGINE_CALL_TOOL_NAME);
  });

  it("not callable: no runnable script is said, not thrown", async () => {
    const fetchImpl: WorkflowFetch = async () => new Response(JSON.stringify({ code: "no_runnable_script", error: "no script of Engine x can run" }), { status: 404 });
    expect(await callEngine("x", {}, target, fetchImpl)).toMatchObject({ status: "not_callable" });
  });

  it("a refused call fails loud", async () => {
    const fetchImpl: WorkflowFetch = async () => new Response(JSON.stringify({ error: "boom" }), { status: 502 });
    await expect(callEngine("x", {}, target, fetchImpl)).rejects.toThrow(/502: boom/);
    await expect(callEngine("x", { request: "nope" }, target, fetchImpl)).rejects.toThrow(/request must be an object/);
    await expect(callEngine("x", { subject: { service: "lead-service" } }, target, fetchImpl)).rejects.toThrow(/subject must be/);
  });
});
