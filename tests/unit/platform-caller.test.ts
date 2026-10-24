import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { readPlatformCaller } from "../../src/lib/platform-parent-run.js";

// COST-SUPPORT-1024: every platform call states whose work it is, the caller's
// run (x-run-id) or the support function it serves (body `support`), never both.

const RUN = "5f0c2a8e-1b3d-4c6e-9f70-a1b2c3d4e5f6";
const req = (headers: Record<string, string>, body: unknown) => ({ headers, body }) as unknown as Request;

describe("readPlatformCaller", () => {
  it("a caller run: parent set, no support, body untouched", () => {
    const r = readPlatformCaller(req({ "x-run-id": RUN }, { message: "hi" }), "/p");
    expect(r).toEqual({ ok: true, parentRunId: RUN, support: undefined, body: { message: "hi" } });
  });

  it("a declared support function: support set, stripped from the body the route validates", () => {
    const support = { kind: "staff_experiment", reason: "probe" };
    const r = readPlatformCaller(req({}, { message: "hi", support }), "/p");
    expect(r).toEqual({ ok: true, parentRunId: undefined, support, body: { message: "hi" } });
  });

  it("neither: refused before any spend, chat-service never guesses whose work it is", () => {
    const r = readPlatformCaller(req({}, { message: "hi" }), "/internal/platform-complete");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.body.error).toContain("/internal/platform-complete");
      expect(r.body.retryable).toBe(false);
    }
  });

  it("both: refused, work for a run is never support", () => {
    const r = readPlatformCaller(req({ "x-run-id": RUN }, { support: { kind: "platform_llm", reason: "x" } }), "/p");
    expect(r.ok).toBe(false);
  });

  it("an unknown function or a missing reason: refused", () => {
    expect(readPlatformCaller(req({}, { support: { kind: "marketing", reason: "x" } }), "/p").ok).toBe(false);
    expect(readPlatformCaller(req({}, { support: { kind: "copilot" } }), "/p").ok).toBe(false);
  });
});
