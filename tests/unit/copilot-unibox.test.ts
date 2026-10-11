import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCopilotTurnBody,
  pushCopilotTurn,
  pushCopilotTurnInBackground,
  type CopilotTurn,
} from "../../src/lib/copilot-unibox.js";

const turn: CopilotTurn = {
  orgId: "org-1",
  userId: "user-1",
  sessionId: "sess-1",
  messages: [
    { messageId: "m-user", role: "user", text: "What is my cost per meeting?", at: new Date("2026-10-11T10:00:00Z") },
    { messageId: "m-ai", role: "assistant", text: "About $42 (estimated).", at: new Date("2026-10-11T10:00:05Z") },
  ],
};

function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ stored: 2, duplicates: 0 }), { status: 200 }));
}

describe("copilot turn -> staff Unibox (crm-service)", () => {
  beforeEach(() => {
    process.env.CRM_SERVICE_URL = "http://crm";
    process.env.CRM_SERVICE_API_KEY = "crm-key";
  });
  afterEach(() => {
    delete process.env.CRM_SERVICE_URL;
    delete process.env.CRM_SERVICE_API_KEY;
  });

  it("builds crm's body: email as the match key, ISO dates, verbatim texts", () => {
    expect(buildCopilotTurnBody(turn, "marie@example.com")).toEqual({
      orgId: "org-1",
      userId: "user-1",
      email: "marie@example.com",
      displayName: null,
      sessionId: "sess-1",
      messages: [
        { messageId: "m-user", role: "user", text: "What is my cost per meeting?", at: "2026-10-11T10:00:00.000Z" },
        { messageId: "m-ai", role: "assistant", text: "About $42 (estimated).", at: "2026-10-11T10:00:05.000Z" },
      ],
    });
  });

  it("drops an empty message (crm refuses text under 1 char)", () => {
    const body = buildCopilotTurnBody({ ...turn, messages: [{ ...turn.messages[0], text: "  " }, turn.messages[1]] }, "a@b.c");
    expect(body.messages.map((m) => m.messageId)).toEqual(["m-ai"]);
  });

  it("POSTs to /internal/copilot/messages with crm's service key", async () => {
    const fetchImpl = okFetch();
    await pushCopilotTurn(turn, { fetchEmail: async () => "marie@example.com", fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://crm/internal/copilot/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("crm-key");
    expect(JSON.parse(init.body as string).email).toBe("marie@example.com");
  });

  it("fails loud on a crm refusal, a missing email, or a missing env", async () => {
    const bad = vi.fn(async () => new Response("not_configured", { status: 503 }));
    await expect(pushCopilotTurn(turn, { fetchEmail: async () => "a@b.c", fetchImpl: bad })).rejects.toThrow("crm-service 503");
    await expect(pushCopilotTurn(turn, { fetchEmail: async () => null, fetchImpl: okFetch() })).rejects.toThrow("no email");
    delete process.env.CRM_SERVICE_URL;
    await expect(pushCopilotTurn(turn, { fetchEmail: async () => "a@b.c", fetchImpl: okFetch() })).rejects.toThrow("not configured");
  });

  it("pushes only Copilot sessions, and logs a failure instead of throwing into the turn", async () => {
    const fetchImpl = okFetch();
    pushCopilotTurnInBackground("press-kit", turn, { fetchEmail: async () => "a@b.c", fetchImpl });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).not.toHaveBeenCalled();

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = vi.fn(async () => new Response("down", { status: 502 }));
    expect(() => pushCopilotTurnInBackground("copilot", turn, { fetchEmail: async () => "a@b.c", fetchImpl: bad })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("the /chat handler pushes after both assistant saves (answer and out-of-credits)", () => {
    const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(src.match(/pushCopilotTurnInBackground\(configKey,/g)?.length).toBe(2);
  });
});
