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
  CHAT_SERVICE_APP_ID,
  VENDOR_OUT_OF_CREDIT_EVENT,
} from "../../src/lib/vendor-credit-alert.js";

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
    process.env.PLATFORM_OWNER_EMAIL = "owner@example.com";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    resetVendorCreditAlerts();
    delete process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
    delete process.env.PLATFORM_OWNER_EMAIL;
  });

  function stubEmailFetch() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  const context = (vendor: VendorId) => ({
    vendor,
    vendorLabel: vendor.toUpperCase(),
    model: "glm-5.3",
    status: 429,
    vendorMessage: "Insufficient balance",
  });

  it("sends one email for a burst of failures from the same vendor", async () => {
    const fetchMock = stubEmailFetch();

    const armed = Array.from({ length: 50 }, () => notifyVendorOutOfCredit(context("zai")));

    expect(armed.filter(Boolean)).toHaveLength(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("posts to the transactional email path, naming the vendor", async () => {
    const fetchMock = stubEmailFetch();

    notifyVendorOutOfCredit({ ...context("zai"), vendorLabel: "Z.ai" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/send$/);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");

    const body = JSON.parse(init.body as string);
    expect(body.appId).toBe(CHAT_SERVICE_APP_ID);
    expect(body.eventType).toBe(VENDOR_OUT_OF_CREDIT_EVENT);
    expect(body.recipientEmail).toBe("owner@example.com");
    expect(body.metadata.vendor).toBe("Z.ai");
    expect(body.metadata.vendorSlug).toBe("zai");
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

  it("stays latched when the email fails to send — one outage must not become two", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(notifyVendorOutOfCredit(context("zai"))).toBe(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(notifyVendorOutOfCredit(context("zai"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not attempt a send when the owner address is not configured", () => {
    delete process.env.PLATFORM_OWNER_EMAIL;
    const fetchMock = stubEmailFetch();

    expect(notifyVendorOutOfCredit(context("zai"))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("completeWithVendor wiring", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetVendorCreditAlerts();
    process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-key";
    process.env.PLATFORM_OWNER_EMAIL = "owner@example.com";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    resetVendorCreditAlerts();
    delete process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
    delete process.env.PLATFORM_OWNER_EMAIL;
  });

  /**
   * One mock serving both the vendor call and the alert email, told apart by
   * URL — the alert must not change the vendor request in any way.
   */
  function stubFetch(vendorResponse: () => Response) {
    const emailCalls: RequestInit[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/send")) {
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
  });

  it("still fails the call, unchanged, while emailing the owner", async () => {
    const { emailCalls } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { code: "1113", message: "Insufficient balance or no resource package. Please recharge." },
          }),
          { status: 429 },
        ),
    );

    await expect(completeWithVendor(options("zai", "glm-5.3"))).rejects.toThrow(VendorProviderError);
    await expect(completeWithVendor(options("zai", "glm-5.3"))).rejects.toThrow(/429 from glm-5.3/);

    await vi.waitFor(() => expect(emailCalls).toHaveLength(1));
    expect(JSON.parse(emailCalls[0].body as string).metadata.vendorSlug).toBe("zai");
  });

  it("sends nothing on a rate-limit 429", async () => {
    const { emailCalls } = stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: "1302", message: "The API request is too frequent." } }),
          { status: 429 },
        ),
    );

    await expect(completeWithVendor(options("zai", "glm-5.3"))).rejects.toThrow(VendorProviderError);
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
