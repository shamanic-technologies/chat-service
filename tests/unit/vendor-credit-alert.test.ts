import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isOutOfCreditRefusal,
  parseVendorRefusal,
  completeWithVendor,
  VendorProviderError,
  VENDOR_IDS,
  type VendorId,
} from "../../src/lib/openai-compatible.js";
import {
  notifyVendorOutOfCredit,
  markVendorServing,
  resetVendorCreditAlerts,
  isVendorCreditAlertLatched,
  ALERT_COOLDOWN_MS,
  PROVIDER_CREDITS_EXHAUSTED_EVENT,
} from "../../src/lib/vendor-credit-alert.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The refusals each vendor actually sends, verbatim from what was observed on
 * 2026-08-15 (DeepSeek's from its documented error codes, read 2026-08-16).
 *
 * The point of the table is the pairing: for every vendor, the out-of-credit
 * refusal AND the refusal that must stay silent. Two of the three overload 429
 * for both, so a classifier keyed on the status alone would score 50% here.
 */
const REFUSALS: Array<{
  vendor: VendorId;
  outOfCredit: { status: number; body: string };
  quiet: Array<{ label: string; status: number; body: string }>;
}> = [
  {
    vendor: "deepseek",
    // https://api-docs.deepseek.com/quick_start/error_codes — 402 Insufficient Balance.
    outOfCredit: {
      status: 402,
      body: JSON.stringify({
        error: {
          message: "Insufficient Balance. You have run out of balance.",
          type: "insufficient_balance",
          code: "invalid_request_error",
        },
      }),
    },
    quiet: [
      {
        label: "rate limit",
        status: 429,
        body: JSON.stringify({
          error: { message: "Rate limit reached. You are sending requests too quickly.", type: "rate_limit_error" },
        }),
      },
      {
        label: "auth failure",
        status: 401,
        body: JSON.stringify({
          error: { message: "Authentication Fails, Your api key: **** is invalid", type: "authentication_error" },
        }),
      },
    ],
  },
  {
    vendor: "zai",
    outOfCredit: {
      status: 429,
      body: JSON.stringify({
        error: { code: "1113", message: "Insufficient balance or no resource package. Please recharge." },
      }),
    },
    quiet: [
      {
        label: "rate limit",
        status: 429,
        body: JSON.stringify({
          error: { code: "1302", message: "The API request is too frequent. Please try again later." },
        }),
      },
      {
        label: "unknown model",
        status: 404,
        body: JSON.stringify({ error: { code: "1211", message: "The model does not exist." } }),
      },
    ],
  },
  {
    vendor: "moonshot",
    outOfCredit: {
      status: 429,
      body: JSON.stringify({
        error: {
          type: "exceeded_current_quota_error",
          message:
            "Your account org-xxxx<xxxx@moonshot.cn> is suspended due to insufficient balance, please recharge",
        },
      }),
    },
    quiet: [
      {
        label: "rate limit",
        status: 429,
        body: JSON.stringify({
          error: { type: "rate_limit_reached_error", message: "Your request exceeded model token limit" },
        }),
      },
      {
        label: "bad request",
        status: 400,
        body: JSON.stringify({
          error: { type: "invalid_request_error", message: "Invalid request: messages must not be empty" },
        }),
      },
    ],
  },
];

describe("out-of-credit classification", () => {
  it("covers every declared vendor — a fourth vendor must land in this table", () => {
    expect(REFUSALS.map((r) => r.vendor).sort()).toEqual([...VENDOR_IDS].sort());
  });

  for (const { vendor, outOfCredit, quiet } of REFUSALS) {
    it(`classifies ${vendor}'s own out-of-credit wording as out of credit`, () => {
      expect(isOutOfCreditRefusal(vendor, outOfCredit.status, outOfCredit.body)).toBe(true);
    });

    for (const q of quiet) {
      it(`does NOT classify ${vendor}'s ${q.label} (${q.status}) as out of credit`, () => {
        expect(isOutOfCreditRefusal(vendor, q.status, q.body)).toBe(false);
      });
    }

    it(`does not read another vendor's out-of-credit signal for ${vendor} by accident`, () => {
      // Each vendor's marker is its own; only the shared prose crosses over,
      // which is fine — it IS the vendor saying the balance is empty.
      expect(isOutOfCreditRefusal(vendor, 200, "")).toBe(false);
    });
  }

  it("degrades to status + prose when the body is not JSON", () => {
    const signal = parseVendorRefusal(502, "<html>Bad Gateway</html>");
    expect(signal.code).toBe("");
    expect(signal.type).toBe("");
    expect(signal.text).toBe("<html>bad gateway</html>");
    expect(isOutOfCreditRefusal("zai", 502, "<html>Bad Gateway</html>")).toBe(false);
  });

  it("reads a code/type placed at the top level, not only under `error`", () => {
    const signal = parseVendorRefusal(429, JSON.stringify({ code: "1113", type: "quota" }));
    expect(signal.code).toBe("1113");
    expect(signal.type).toBe("quota");
  });
});

describe("alert latch", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetVendorCreditAlerts();
    process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-key";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetVendorCreditAlerts();
    delete process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  });

  function stubEmailFetch(status = 200) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status }));
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  const context = (vendor: VendorId) => ({
    vendor,
    vendorLabel: vendor.toUpperCase(),
    model: "glm-5.2",
    status: 429,
    vendorMessage: "Insufficient balance",
    identity: { orgId: "org-1", userId: "user-1", runId: "run-1" },
  });

  it("sends one email for a burst of failures from the same vendor", async () => {
    const fetchMock = stubEmailFetch();

    const armed = Array.from({ length: 50 }, () => notifyVendorOutOfCredit(context("zai")));

    expect(armed.filter(Boolean)).toHaveLength(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("posts the staff event to /platform-send with the org header and no recipient", async () => {
    const fetchMock = stubEmailFetch();

    notifyVendorOutOfCredit({ ...context("zai"), vendorLabel: "Z.ai" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/platform-send$/);

    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-run-id"]).toBe("run-1");

    const body = JSON.parse(init.body as string);
    expect(body.eventType).toBe(PROVIDER_CREDITS_EXHAUSTED_EVENT);
    expect(PROVIDER_CREDITS_EXHAUSTED_EVENT).toBe("provider_credits_exhausted");
    // Staff-bound events refuse a caller-supplied recipient, and the producer
    // fills orgId from the header.
    expect(body.recipientEmail).toBeUndefined();
    expect(body.bccEmails).toBeUndefined();
    expect(body.appId).toBeUndefined();
    expect(body.metadata.orgId).toBeUndefined();
    // provider + reason are required non-empty by the producer.
    expect(body.metadata.provider).toBe("Z.ai");
    expect(String(body.metadata.reason).length).toBeGreaterThan(0);
    expect(body.metadata.detail).toContain("glm-5.2");
    expect(body.metadata.detail).toContain("Insufficient balance");
  });

  it("omits x-user-id and x-run-id when the caller has none", async () => {
    const fetchMock = stubEmailFetch();

    notifyVendorOutOfCredit({ ...context("zai"), identity: { orgId: "org-2" } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers["x-org-id"]).toBe("org-2");
    expect(headers["x-user-id"]).toBeUndefined();
    expect(headers["x-run-id"]).toBeUndefined();
  });

  it("alerts each vendor independently — one latch per vendor", async () => {
    const fetchMock = stubEmailFetch();

    expect(notifyVendorOutOfCredit(context("zai"))).toBe(true);
    expect(notifyVendorOutOfCredit(context("moonshot"))).toBe(true);
    expect(notifyVendorOutOfCredit(context("zai"))).toBe(false);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("re-arms once the vendor serves a call again", async () => {
    const fetchMock = stubEmailFetch();

    expect(notifyVendorOutOfCredit(context("deepseek"))).toBe(true);
    expect(isVendorCreditAlertLatched("deepseek")).toBe(true);

    markVendorServing("deepseek");
    expect(isVendorCreditAlertLatched("deepseek")).toBe(false);

    expect(notifyVendorOutOfCredit(context("deepseek"))).toBe(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("does not re-send after a SUCCESSFUL send, even once the cooldown lapses", async () => {
    vi.useFakeTimers();
    const fetchMock = stubEmailFetch();

    expect(notifyVendorOutOfCredit(context("zai"))).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(ALERT_COOLDOWN_MS * 3);
    expect(notifyVendorOutOfCredit(context("zai"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries after the cooldown when the send FAILED — one rejection must not lose the outage", async () => {
    vi.useFakeTimers();
    // This is the 2026-08-25 shape: the producer rejected the send, and the
    // old latch stayed set, so the whole outage alerted nobody.
    const fetchMock = stubEmailFetch(400);

    expect(notifyVendorOutOfCredit(context("zai"))).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Bounded: within the cooldown a burst still costs exactly one attempt.
    expect(notifyVendorOutOfCredit(context("zai"))).toBe(false);
    await vi.advanceTimersByTimeAsync(ALERT_COOLDOWN_MS - 1);
    expect(notifyVendorOutOfCredit(context("zai"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2);
    expect(notifyVendorOutOfCredit(context("zai"))).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends nothing and says why when the failing call carried no org", async () => {
    const fetchMock = stubEmailFetch();
    const errorSpy = console.error as unknown as ReturnType<typeof vi.fn>;

    // /internal/platform-complete has a platform run and no org. The staff
    // path is org-scoped, so the alert cannot be raised — loudly, never with a
    // fabricated org.
    expect(notifyVendorOutOfCredit({ ...context("zai"), identity: undefined })).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("carried no org");
  });

  it("does not attempt a send when the service api key is not configured", async () => {
    delete process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
    const fetchMock = stubEmailFetch();

    expect(notifyVendorOutOfCredit(context("zai"))).toBe(true);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("no parallel template implementation", () => {
  // PR #396 invented a chat-service-owned event and registered a template for
  // it at boot; both were rejected by the deployed producer and the alert never
  // reached anyone. transactional-email-service owns the staff template. This
  // test fails if either comes back.
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
    });
  }

  const BANNED = [
    ["vendor", "out", "of", "credit"].join("_"),
    "register-email-templates",
    "registerEmailTemplates",
    "/templates",
  ];

  it("carries no chat-service-owned email template or private event name", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const text = readFileSync(file, "utf8");
      for (const banned of BANNED) {
        if (text.includes(banned)) offenders.push(`${file}: ${banned}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("completeWithVendor wiring", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetVendorCreditAlerts();
    process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-key";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    resetVendorCreditAlerts();
    delete process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  });

  /**
   * One mock serving both the vendor call and the alert email, told apart by
   * URL — the alert must not change the vendor request in any way.
   */
  function stubFetch(vendorResponse: () => Response) {
    const emailCalls: RequestInit[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/platform-send")) {
        emailCalls.push(init!);
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return vendorResponse();
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return { fetchMock, emailCalls };
  }

  const options = (vendor: VendorId, model: string) => ({
    vendor,
    apiKey: "vendor-key",
    model,
    message: "hi",
    identity: { orgId: "org-1", userId: "user-1", runId: "run-1" },
  });

  it("still fails the call, unchanged, while alerting staff", async () => {
    const { emailCalls } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { code: "1113", message: "Insufficient balance or no resource package. Please recharge." },
          }),
          { status: 429 },
        ),
    );

    await expect(completeWithVendor(options("zai", "glm-5.2"))).rejects.toThrow(VendorProviderError);
    await expect(completeWithVendor(options("zai", "glm-5.2"))).rejects.toThrow(/429 from glm-5.2/);

    await vi.waitFor(() => expect(emailCalls).toHaveLength(1));
    const body = JSON.parse(emailCalls[0].body as string);
    expect(body.eventType).toBe(PROVIDER_CREDITS_EXHAUSTED_EVENT);
    expect((emailCalls[0].headers as Record<string, string>)["x-org-id"]).toBe("org-1");
  });

  it("never forwards the identity headers to the vendor itself", async () => {
    const { fetchMock } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            id: "x",
            model: "glm-5.2",
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
          { status: 200 },
        ),
    );

    await completeWithVendor(options("zai", "glm-5.2"));

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).toEqual([
      "authorization",
      "content-type",
    ]);
    expect(init.body as string).not.toContain("org-1");
  });

  it("sends nothing on a rate-limit 429", async () => {
    // A plain rate limit is retried (bounded) and then fails loud. It must
    // alert nothing: the balance is fine, the account is simply at capacity,
    // and an email per burst would bury the one that means "top up".
    vi.useFakeTimers();
    const { emailCalls } = stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: "1302", message: "The API request is too frequent." } }),
          { status: 429 },
        ),
    );

    const settled = completeWithVendor(options("zai", "glm-5.2")).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await settled;
    vi.useRealTimers();

    expect(err).toBeInstanceOf(VendorProviderError);
    expect(emailCalls).toHaveLength(0);
    expect(isVendorCreditAlertLatched("zai")).toBe(false);
  });

  it("re-arms after the vendor serves a completion again", async () => {
    let outOfCredit = true;
    const { emailCalls } = stubFetch(() =>
      outOfCredit
        ? new Response(
            JSON.stringify({ error: { message: "Insufficient Balance. You have run out of balance." } }),
            { status: 402 },
          )
        : new Response(
            JSON.stringify({
              id: "x",
              model: "deepseek-v4-flash",
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 2 },
            }),
            { status: 200 },
          ),
    );

    await expect(completeWithVendor(options("deepseek", "deepseek-v4-flash"))).rejects.toThrow();
    await vi.waitFor(() => expect(emailCalls).toHaveLength(1));
    expect(isVendorCreditAlertLatched("deepseek")).toBe(true);

    outOfCredit = false;
    await completeWithVendor(options("deepseek", "deepseek-v4-flash"));
    expect(isVendorCreditAlertLatched("deepseek")).toBe(false);

    outOfCredit = true;
    await expect(completeWithVendor(options("deepseek", "deepseek-v4-flash"))).rejects.toThrow();
    await vi.waitFor(() => expect(emailCalls).toHaveLength(2));
  });
});
