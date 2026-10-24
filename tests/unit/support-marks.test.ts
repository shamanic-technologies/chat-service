import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chatTurnSupport,
  COPILOT_SUPPORT,
} from "../../src/lib/support-marks.js";
import { createChannelRootRun } from "../../src/lib/channel-copilot.js";

const PLATFORM_LLM_SUPPORT = { kind: "platform_llm" as const, reason: "test" };

const originalEnv = { ...process.env };

describe("chatTurnSupport", () => {
  it("marks a Copilot turn as copilot", () => {
    expect(chatTurnSupport({ configKey: "copilot", copilotConfigKey: "copilot", proactiveTurnId: undefined })).toEqual(COPILOT_SUPPORT);
    expect(COPILOT_SUPPORT.kind).toBe("copilot");
  });

  it("leaves a proactive turn to the campaign step that asked for it", () => {
    expect(chatTurnSupport({ configKey: "copilot", copilotConfigKey: "copilot", proactiveTurnId: "turn-1" })).toBeUndefined();
  });

  it("leaves every other config to its caller", () => {
    expect(chatTurnSupport({ configKey: "workflow", copilotConfigKey: "copilot", proactiveTurnId: undefined })).toBeUndefined();
    expect(chatTurnSupport({ configKey: null, copilotConfigKey: "copilot", proactiveTurnId: undefined })).toBeUndefined();
  });
});

describe("runs-client support body", () => {
  beforeEach(() => {
    process.env.RUNS_SERVICE_API_KEY = "test-runs-key";
    process.env.RUNS_SERVICE_URL = "https://runs.test.local";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "run-1" }) }));
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  async function load() {
    vi.resetModules();
    return import("../../src/lib/runs-client.js");
  }

  function sentBody(): Record<string, unknown> {
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    return JSON.parse((call[1] as { body: string }).body);
  }

  it("createPlatformRun sends the support mark when stated", async () => {
    const { createPlatformRun } = await load();
    await createPlatformRun({ serviceName: "chat-service", taskName: "platform-complete", support: PLATFORM_LLM_SUPPORT });
    expect(sentBody()).toEqual({ serviceName: "chat-service", taskName: "platform-complete", support: PLATFORM_LLM_SUPPORT });
  });

  it("createPlatformRun sends no support field for a child of a caller run", async () => {
    const { createPlatformRun } = await load();
    const parentRunId = "11111111-1111-4111-8111-111111111111";
    await createPlatformRun({ serviceName: "chat-service", taskName: "platform-complete", parentRunId, support: undefined });
    expect(sentBody()).toEqual({ serviceName: "chat-service", taskName: "platform-complete", parentRunId });
  });

  it("createRun sends the support mark when stated", async () => {
    const { createRun } = await load();
    await createRun(
      { serviceName: "chat-service", taskName: "copilot-nudge", support: COPILOT_SUPPORT },
      { orgId: "o", userId: "u", runId: "r" },
    );
    expect(sentBody()).toEqual({ serviceName: "chat-service", taskName: "copilot-nudge", support: COPILOT_SUPPORT });
  });
});

describe("createChannelRootRun", () => {
  it("creates the WhatsApp Copilot root run marked copilot", async () => {
    process.env.RUNS_SERVICE_API_KEY = "k";
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "root-1" }) });
    expect(await createChannelRootRun({ orgId: "o", userId: "u" }, fetchImpl as unknown as typeof fetch)).toBe("root-1");
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body);
    expect(body.support).toEqual(COPILOT_SUPPORT);
    process.env = { ...originalEnv };
  });
});
