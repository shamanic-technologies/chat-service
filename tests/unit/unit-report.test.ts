// SCRIPT-VALUE-RATING-1113-SOPHIE (owner 2026-11-13): a client telling Sophie that something we
// made is not good becomes ONE report of that Unit, on every surface, through the public gateway
// route. No positive vote, no yes asked, nothing promised.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../src/lib/api-client.js", () => ({ apiServiceFetch: (...a: unknown[]) => fetchMock(...a) }));

const { REPORT_NOT_GOOD_TOOL, REPORT_NOT_GOOD_TOOL_NAME, REPORT_EFFECT, UNIT_REPORT_OPERATION, buildUnitReportBody, reportNotGood, reportSource, storedReportForModel } = await import(
  "../../src/lib/unit-report.js"
);
const { TOOL_REGISTRY } = await import("../../src/lib/anthropic.js");
const { SOPHIE_TOOLS } = await import("../../src/agent/sophie.js");
const { COPILOT_TOOL_API_OPS } = await import("../../src/lib/skill-api-ops.js");
const { isProactiveReadTool } = await import("../../src/lib/copilot-proactive.js");
const { YES_MARKER } = await import("../../src/agent/catalogue-tools.js");

const PARAMS = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const MESSAGE = { outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-9", kind: "reported", note: "way too pushy", unitAt: "2026-11-10T14:05:00Z" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => fetchMock.mockReset());

describe("report_not_good: the tool", () => {
  it("is one of Sophie's tools, in the registry, mapped to the gateway operation", () => {
    expect(SOPHIE_TOOLS).toContain(REPORT_NOT_GOOD_TOOL_NAME);
    expect(TOOL_REGISTRY[REPORT_NOT_GOOD_TOOL_NAME]).toBe(REPORT_NOT_GOOD_TOOL);
    expect(COPILOT_TOOL_API_OPS[REPORT_NOT_GOOD_TOOL_NAME]).toEqual([UNIT_REPORT_OPERATION]);
  });

  it("says what it does, when to use it, and what it does not do", () => {
    const d = REPORT_NOT_GOOD_TOOL.description ?? "";
    for (const w of ["is wrong, off or not what they want", "because they asked", "picked less", "sends nothing to anyone", "rewrites or re-sends nothing", "no question before it", "no positive vote", "message_written", "lead-service", "leadId"]) {
      expect(d, w).toContain(w);
    }
  });

  it("takes only the two kinds of the store: no positive vote can be sent", () => {
    const kind = (REPORT_NOT_GOOD_TOOL.input_schema.properties as Record<string, { enum?: string[] }>).kind;
    expect(kind.enum).toEqual(["edited", "reported"]);
    expect(() => buildUnitReportBody({ ...MESSAGE, kind: "liked" }, "web")).toThrow(/no positive vote/);
  });

  it("the model never states where it was said: the surface does", () => {
    expect(Object.keys(REPORT_NOT_GOOD_TOOL.input_schema.properties as object)).not.toContain("source");
    expect(buildUnitReportBody({ ...MESSAGE, source: "the dashboard" }, "whatsapp").source).toBe("Sophie (WhatsApp)");
    expect(reportSource("web")).toBe("Sophie (web chat)");
    expect(reportSource("telegram")).toBe("Sophie (Telegram)");
    expect(reportSource("email")).toBe("Sophie (email)");
  });

  it("a proactive turn (reads only) never holds it", () => {
    expect(isProactiveReadTool(REPORT_NOT_GOOD_TOOL_NAME)).toBe(false);
  });

  it("carries no yes marker of its own: reporting asks no confirmation", () => {
    expect(JSON.stringify(REPORT_NOT_GOOD_TOOL)).not.toContain(YES_MARKER);
    expect(REPORT_NOT_GOOD_TOOL.description).not.toMatch(/confirmationToken|ask yes or no/);
  });
});

describe("buildUnitReportBody", () => {
  it("names the Unit as the ledger does, with the person's words and the message's date", () => {
    expect(buildUnitReportBody(MESSAGE, "web")).toEqual({
      outcomeKey: "message_written",
      subjectService: "lead-service",
      subjectId: "lead-9",
      kind: "reported",
      source: "Sophie (web chat)",
      note: "way too pushy",
      unitAt: "2026-11-10T14:05:00.000Z",
    });
  });

  it("omits an absent note and date (the subject's standing Unit)", () => {
    const body = buildUnitReportBody({ outcomeKey: "offer_fields_drafted", subjectService: "brand-service", subjectId: "offer-1", kind: "edited", note: "  " }, "web");
    expect(body).toEqual({ outcomeKey: "offer_fields_drafted", subjectService: "brand-service", subjectId: "offer-1", kind: "edited", source: "Sophie (web chat)" });
  });

  it("refuses a Unit it cannot name and a date that is none", () => {
    expect(() => buildUnitReportBody({ ...MESSAGE, subjectId: "" }, "web")).toThrow(/subjectId is required/);
    expect(() => buildUnitReportBody({ ...MESSAGE, outcomeKey: undefined }, "web")).toThrow(/outcomeKey is required/);
    expect(() => buildUnitReportBody({ ...MESSAGE, unitAt: "last Tuesday-ish" }, "web")).toThrow(/unitAt/);
    expect(() => buildUnitReportBody({ ...MESSAGE, note: 3 }, "web")).toThrow(/note must be a string/);
  });
});

describe("reportNotGood", () => {
  it("posts ONE report to the public gateway route, as the person", async () => {
    fetchMock.mockResolvedValue(json(201, { id: "rep-1", ...MESSAGE, source: "Sophie (web chat)", orgId: "org-1", userId: "user-1", reportedAt: "2026-11-13T10:00:00.000Z" }));
    const result = await reportNotGood(MESSAGE, PARAMS, "web");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, method, params, body] = fetchMock.mock.calls[0];
    expect(path).toBe("/v1/features/unit-reports");
    expect(method).toBe("POST");
    expect(params).toBe(PARAMS);
    expect(body).toMatchObject({ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-9", kind: "reported", source: "Sophie (web chat)" });
    expect(result).toEqual({
      reported: true,
      report: { id: "rep-1", outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-9", kind: "reported", unitAt: "2026-11-10T14:05:00Z", reportedAt: "2026-11-13T10:00:00.000Z" },
      effect: REPORT_EFFECT,
    });
  });

  it("what the model reads promises nothing: no rewrite, no re-send, nobody written to", () => {
    const { effect } = storedReportForModel({ id: "rep-1" }) as { effect: string };
    expect(effect).toContain("Nothing was sent to anyone");
    expect(effect).toContain("nothing is rewritten or re-sent");
  });

  it("a refusal answers as every gateway refusal does, and never reads as reported", async () => {
    fetchMock.mockResolvedValue(json(400, { error: "kind must be edited or reported", code: "unit_report_unrecognised" }));
    expect(await reportNotGood(MESSAGE, PARAMS, "web")).toMatchObject({ ok: false, status: 400, meaning: expect.stringContaining("Refused: nothing ran") });
    fetchMock.mockResolvedValue(json(502, { code: "unit_report_unwritable" }));
    expect(await reportNotGood(MESSAGE, PARAMS, "web")).toMatchObject({ ok: false, status: 502, meaning: expect.stringContaining("Failed on our side") });
  });

  it("a malformed report never reaches the gateway", async () => {
    await expect(reportNotGood({ ...MESSAGE, kind: "great" }, PARAMS, "web")).rejects.toThrow(/no positive vote/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
