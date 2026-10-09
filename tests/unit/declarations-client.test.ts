import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StaffRequestInput, StaffRequestResult } from "../../src/lib/staff-requests.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.FEATURES_SERVICE_URL = "http://features.test";
  process.env.FEATURES_SERVICE_API_KEY = "features-key";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

async function load() {
  vi.resetModules();
  return import("../../src/lib/declarations-client.js");
}

const ctx = { orgId: "org-1", userId: "user-1" };
const fetchMock = () => fetch as ReturnType<typeof vi.fn>;
const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
});
const call = (i: number) => {
  const [url, init] = fetchMock().mock.calls[i] as [string, RequestInit];
  return {
    url,
    method: init.method,
    key: (init.headers as Record<string, string>)["x-api-key"],
    body: init.body ? JSON.parse(init.body as string) : null,
  };
};

function fileMock() {
  const filed: StaffRequestInput[] = [];
  const file = vi.fn(async (input: StaffRequestInput): Promise<StaffRequestResult> => {
    filed.push(input);
    return {
      requestId: `req-${filed.length}`,
      duplicate: false,
      requestCount: 1,
      issueUrl: `https://github.com/x/${input.repo}/issues/${filed.length}`,
      issueError: null,
      staffPinged: true,
      telegramSkippedReason: null,
      telegramError: null,
    };
  });
  return { file, filed };
}

describe("declaration reads hit features-service with its service key", () => {
  it.each([
    ["listDeclaredChannels", {}, "/internal/declarations/channels"],
    ["listDeclaredChannels", { slug: "voice-note" }, "/internal/declarations/channels/voice-note"],
    ["listDeclaredLegs", { channelSlug: "voice-note" }, "/internal/declarations/legs?channelSlug=voice-note"],
    ["listTriggerTypes", { triggerId: "no_reply_3d" }, "/internal/declarations/trigger-types/no_reply_3d"],
    ["listDeclaredSalesPaths", { combinationKey: "a|b" }, "/internal/declarations/sales-paths/a%7Cb"],
  ])("%s(%j) → GET %s", async (fn, args, path) => {
    fetchMock().mockResolvedValue(res(200, { ok: 1 }));
    const mod = (await load()) as unknown as Record<string, (a: unknown) => Promise<unknown>>;
    expect(await mod[fn](args)).toEqual({ ok: 1 });
    expect(call(0)).toMatchObject({ url: `http://features.test${path}`, method: "GET", key: "features-key" });
  });

  it("fails loud when the features-service env is missing", async () => {
    delete process.env.FEATURES_SERVICE_API_KEY;
    const { listDeclaredChannels } = await load();
    await expect(listDeclaredChannels({})).rejects.toThrow(/FEATURES_SERVICE_API_KEY not configured/);
  });
});

describe("declare_channel", () => {
  it("creates the channel with the chat's org as requester and files 'publish it'", async () => {
    fetchMock().mockResolvedValue(res(201, { slug: "voice-note", published: false, legs: [] }));
    const { declareChannel } = await load();
    const { file, filed } = fileMock();
    const r = await declareChannel(
      { slug: "voice-note", name: "Voice note", channelType: "outbound", userRequest: "send them a voice note", published: true },
      ctx,
      file,
    );
    const sent = call(0);
    expect(sent).toMatchObject({ url: "http://features.test/internal/declarations/channels", method: "POST" });
    expect(sent.body).toMatchObject({ slug: "voice-note", createdBy: "user-1", requestedByOrgId: "org-1" });
    // the Copilot can never publish: the field is not forwarded
    expect(sent.body).not.toHaveProperty("published");
    expect(sent.body).not.toHaveProperty("userRequest");
    expect(r.status).toBe("declared_on_hold");
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ repo: "features-service", pieceKey: "publish-channel-voice-note", userRequest: "send them a voice note" });
  });
});

describe("declare_leg", () => {
  it("a reactive leg on a coded trigger is created unpublished and files 'publish it'", async () => {
    fetchMock().mockResolvedValue(
      res(201, {
        leg: { legKey: "positive_reply_to_meeting_booked", published: false },
        channel: { slug: "voice-note", published: false },
      }),
    );
    const { declareLeg } = await load();
    const { file, filed } = fileMock();
    const r = await declareLeg(
      { channelSlug: "voice-note", fromStep: "positive_reply", toStep: "meeting_booked", mode: "reactive", triggerId: "positive_reply_received", userRequest: "u" },
      ctx,
      file,
    );
    expect(call(0)).toMatchObject({ url: "http://features.test/internal/declarations/channels/voice-note/legs", method: "POST" });
    expect(call(0).body).toEqual({
      fromStep: "positive_reply",
      toStep: "meeting_booked",
      mode: "reactive",
      triggerId: "positive_reply_received",
      createdBy: "user-1",
      requestedByOrgId: "org-1",
    });
    expect(r.status).toBe("declared_on_hold");
    expect(filed.map((f) => f.pieceKey)).toEqual(["publish-channel-voice-note", "publish-leg-voice-note-positive-reply-to-meeting-booked"]);
  });

  it("a leg on a trigger nothing fires becomes a recorded staff request, not an error", async () => {
    fetchMock()
      .mockResolvedValueOnce(res(409, { error: "nothing fires no_reply_3d today", reason: "trigger_not_fired" }))
      .mockResolvedValueOnce(res(200, { id: "no_reply_3d", kind: "delay", coded: false, params: { afterStep: "lead_found", days: 3 } }));
    const { declareLeg } = await load();
    const { file, filed } = fileMock();
    const r = (await declareLeg(
      { channelSlug: "whatsapp", fromStep: "lead_found", toStep: "positive_reply", mode: "reactive", triggerId: "no_reply_3d", userRequest: "WhatsApp 3 days later if no reply" },
      ctx,
      file,
    )) as { status: string; reason: string; onHold: Array<{ waitingFor: string; staffRequest: StaffRequestResult }> };
    expect(call(1)).toMatchObject({ url: "http://features.test/internal/declarations/trigger-types/no_reply_3d", method: "GET" });
    expect(r.status).toBe("on_hold");
    expect(r.reason).toBe("trigger_not_fired");
    expect(r.onHold[0].waitingFor).toBe("trigger_detector");
    expect(r.onHold[0].staffRequest.requestId).toBe("req-1");
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ repo: "campaign-service", pieceKey: "delay-trigger-detector", kind: "feature" });
  });

  it("any other refusal propagates with its named reason", async () => {
    fetchMock().mockResolvedValue(res(409, { error: "exists", reason: "leg_exists" }));
    const { declareLeg, DeclarationRefusedError } = await load();
    const { file } = fileMock();
    const p = declareLeg({ channelSlug: "c", toStep: "positive_reply", mode: "proactive", userRequest: "u" }, ctx, file);
    await expect(p).rejects.toBeInstanceOf(DeclarationRefusedError);
    await expect(p).rejects.toThrow(/409 leg_exists/);
    expect(file).not.toHaveBeenCalled();
  });

  it("requires the user's words", async () => {
    const { declareLeg } = await load();
    await expect(declareLeg({ channelSlug: "c", toStep: "x", mode: "proactive" }, ctx, fileMock().file)).rejects.toThrow(/userRequest/);
  });
});

describe("declare_trigger_type", () => {
  it("an uncoded trigger files the same detector piece a refused leg files", async () => {
    fetchMock().mockResolvedValue(res(201, { id: "no_reply_3d", kind: "delay", coded: false, params: { afterStep: "lead_found", days: 3 } }));
    const { declareTriggerType } = await load();
    const { file, filed } = fileMock();
    const r = await declareTriggerType(
      { id: "no_reply_3d", label: "No reply after 3 days", description: "d", icon: "clock", kind: "delay", params: { afterStep: "lead_found", days: 3 }, coded: true, userRequest: "u" },
      ctx,
      file,
    );
    expect(call(0).body).not.toHaveProperty("coded");
    expect(call(0).body).toMatchObject({ id: "no_reply_3d", kind: "delay", createdBy: "user-1", requestedByOrgId: "org-1" });
    expect(r.status).toBe("declared_on_hold");
    expect(filed[0].pieceKey).toBe("delay-trigger-detector");
  });
});

describe("declare_sales_path", () => {
  it("files 'publish it' for each leg not visible to clients", async () => {
    fetchMock().mockResolvedValue(
      res(201, {
        combinationKey: "k",
        visibleToClients: false,
        legs: [
          { channelSlug: "cold-email", legKey: "lead_found_to_positive_reply", visibleToClients: true },
          { channelSlug: "voice-note", legKey: "positive_reply_to_paid", visibleToClients: false },
        ],
      }),
    );
    const { declareSalesPath } = await load();
    const { file, filed } = fileMock();
    const legs = [
      { channelSlug: "cold-email", legKey: "lead_found_to_positive_reply" },
      { channelSlug: "voice-note", legKey: "positive_reply_to_paid" },
    ];
    const r = await declareSalesPath({ legs, userRequest: "u" }, ctx, file);
    expect(call(0).body).toEqual({ legs, createdBy: "user-1", requestedByOrgId: "org-1" });
    expect(r.status).toBe("declared_on_hold");
    expect(filed.map((f) => f.pieceKey)).toEqual(["publish-leg-voice-note-positive-reply-to-paid"]);
  });
});

describe("detectorRequest", () => {
  it("an event trigger goes to the fleet service that fires it, keyed on the trigger", async () => {
    const { detectorRequest } = await load();
    const r = detectorRequest({ id: "meeting_booked", kind: "event", firedBy: "crm-service" }, "u", "leg");
    expect(r).toMatchObject({ repo: "crm-service", pieceKey: "fire-meeting-booked-trigger" });
  });

  it("an event trigger fired by an unknown name goes to campaign-service", async () => {
    const { detectorRequest } = await load();
    expect(detectorRequest({ id: "x", kind: "event", firedBy: "calendly" }, "u", "leg").repo).toBe("campaign-service");
  });

  it("poll triggers share one generic piece per kind", async () => {
    const { detectorRequest } = await load();
    expect(detectorRequest({ id: "new_post", kind: "poll" }, "u", "leg").pieceKey).toBe("poll-trigger-detector");
  });
});
