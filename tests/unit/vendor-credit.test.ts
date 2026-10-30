import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isOutOfCreditRefusal,
  parseVendorRefusal,
  completeWithVendor,
  VendorProviderError,
  VendorOutOfCreditError,
  VENDOR_IDS,
  type VendorId,
} from "../../src/lib/openai-compatible.js";
import {
  CREDIT_PROVIDERS,
  FALLBACK_MODELS,
  PROBE_INTERVAL_MS,
  buildVendorCreditRead,
  fallbackModelFor,
  initVendorCredit,
  isOutOfCreditError,
  isProviderOutOfCredit,
  markProviderServing,
  pickServingModel,
  recordOutOfCredit,
  recordReroute,
  resetVendorCredit,
  type VendorCreditStore,
} from "../../src/lib/vendor-credit.js";
import { resolveModel } from "../../src/lib/anthropic.js";
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
  {
    vendor: "openai",
    // Captured VERBATIM from api.openai.com on 2026-09-09, probing gpt-6-astra
    // with the platform key on an account with no credit. Pinned because the
    // adapter classifies on `code`/`type` rather than the shared prose regex —
    // OpenAI's wording ("no credits remaining") matches none of the other
    // three, so a body change here is a change to the only signal we have.
    outOfCredit: {
      status: 429,
      body: JSON.stringify({
        error: {
          message:
            "You have no credits remaining. Add credits to continue using the API at " +
            "https://platform.openai.com/settings/organization/billing/.",
          type: "insufficient_quota",
          param: null,
          code: "credit_balance_exhausted",
        },
      }),
    },
    quiet: [
      {
        label: "rate limit",
        status: 429,
        body: JSON.stringify({
          error: {
            message: "Rate limit reached for gpt-6-astra in organization org-xxxx on requests per min (RPM).",
            type: "requests",
            code: "rate_limit_exceeded",
          },
        }),
      },
      {
        label: "unsupported reasoning effort",
        status: 400,
        body: JSON.stringify({
          error: {
            message: "Unsupported value: 'reasoning_effort' does not support 'none' with this model.",
            type: "invalid_request_error",
            param: "reasoning_effort",
            code: "unsupported_value",
          },
        }),
      },
      {
        label: "auth failure",
        status: 401,
        body: JSON.stringify({
          error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" },
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


// ---------------------------------------------------------------------------
// VENDOR-CREDIT-1030: the refusal is a stored fact, red on Monitoring, and the
// call is rerouted to the declared fallback. Never an email.
// ---------------------------------------------------------------------------

function recordingStore(open: Array<{ provider: "deepseek"; firstSeenAt: Date }> = []) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const store: VendorCreditStore = {
    recordRefusal: async (i) => void calls.push(["refusal", i]),
    recordReroute: async (i) => void calls.push(["reroute", i]),
    closeOutage: async (i) => void calls.push(["close", i]),
    loadOpen: async () => open,
  };
  return { store, calls };
}

describe("completeWithVendor on an empty balance", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  for (const { vendor, outOfCredit } of REFUSALS) {
    it(`throws VendorOutOfCreditError (still a VendorProviderError, one call, no retry) for ${vendor}`, async () => {
      const fetchMock = vi.fn(async () => new Response(outOfCredit.body, { status: outOfCredit.status }));
      global.fetch = fetchMock as unknown as typeof fetch;
      const err = await completeWithVendor({ vendor, apiKey: "k", model: "m", message: "hi" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VendorOutOfCreditError);
      expect(err).toBeInstanceOf(VendorProviderError);
      expect((err as VendorOutOfCreditError).status).toBe(outOfCredit.status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it("a plain rate limit is NOT an empty balance", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: "1302", message: "The API request is too frequent." } }), { status: 429 }),
    ) as unknown as typeof fetch;
    const settled = completeWithVendor({ vendor: "zai", apiKey: "k", model: "glm-5.3", message: "hi" }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await settled;
    vi.useRealTimers();
    expect(err).not.toBeInstanceOf(VendorOutOfCreditError);
  });

  it("sends the vendor nothing but its own auth", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "x", model: "glm-5.3", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
          { status: 200 },
        ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    await completeWithVendor({ vendor: "zai", apiKey: "k", model: "glm-5.3", message: "hi" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase())).toEqual(["authorization", "content-type"]);
  });
});

describe("native SDK empty-balance wording", () => {
  it("reads Anthropic's and Google's own words, nothing adjacent", () => {
    expect(isOutOfCreditError("anthropic", new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'))).toBe(true);
    expect(isOutOfCreditError("google", new Error("429 Your prepayment credits are depleted. Please go to AI Studio."))).toBe(true);
    expect(isOutOfCreditError("anthropic", new Error("429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit"))).toBe(false);
    expect(isOutOfCreditError("google", new Error("429 RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content"))).toBe(false);
    expect(isOutOfCreditError("deepseek", new VendorOutOfCreditError("x", "deepseek", 402, "Insufficient Balance"))).toBe(true);
    expect(isOutOfCreditError("deepseek", new VendorProviderError("[vendor:deepseek] 500 from deepseek-flash"))).toBe(false);
  });
});

describe("declared fallbacks", () => {
  it("deepseek-flash falls back to GLM-5.3 Flash on Z.ai", () => {
    const fb = fallbackModelFor(resolveModel("deepseek", "deepseek-flash"));
    expect(fb?.apiModelId).toBe("glm-5.3-flash");
    expect(fb?.provider).toBe("zai");
    // deepseek-pro is a deprecated synonym of the same model: same detour.
    expect(fallbackModelFor(resolveModel("deepseek", "deepseek-pro"))?.apiModelId).toBe("glm-5.3-flash");
  });

  for (const [apiModelId, fb] of Object.entries(FALLBACK_MODELS)) {
    it(`${apiModelId}: the fallback is another vendor, same tier, never Claude Haiku 4.5`, () => {
      const primary = resolveModel(fb.from, apiModelId);
      const fallback = resolveModel(fb.provider, fb.model);
      expect(fallback.provider).not.toBe(fb.from);
      expect(fallback.capabilityTier).toBe(primary.capabilityTier);
      expect(fallback.apiModelId).not.toMatch(/haiku-4-5/);
    });
  }

  it("a model with no declared fallback has none", () => {
    expect(fallbackModelFor(resolveModel("zai", "glm-flash"))).toBeNull();
  });
});

describe("routing while a provider is out of credit", () => {
  beforeEach(() => {
    resetVendorCredit();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    resetVendorCredit();
    vi.restoreAllMocks();
  });
  const deepseek = () => resolveModel("deepseek", "deepseek-flash");

  it("calls the primary while it serves", () => {
    expect(pickServingModel(deepseek())).toEqual({ resolved: deepseek(), fallbackFrom: null });
  });

  it("reroutes to the fallback once out of credit, then probes the primary once a minute", () => {
    const t0 = Date.UTC(2026, 9, 29, 16, 0, 0);
    recordOutOfCredit({ provider: "deepseek", model: "deepseek-flash", status: 402, message: "Insufficient Balance", at: new Date(t0) });
    expect(isProviderOutOfCredit("deepseek")).toBe(true);
    const during = pickServingModel(deepseek(), t0 + 1_000);
    expect(during.resolved.apiModelId).toBe("glm-5.3-flash");
    expect(during.fallbackFrom?.apiModelId).toBe("deepseek-flash");
    // The probe slot: one call goes to the primary...
    expect(pickServingModel(deepseek(), t0 + PROBE_INTERVAL_MS).resolved.apiModelId).toBe("deepseek-flash");
    // ...and the next ones keep the detour until the next slot.
    expect(pickServingModel(deepseek(), t0 + PROBE_INTERVAL_MS + 1).resolved.apiModelId).toBe("glm-5.3-flash");
  });

  it("returns to the primary as soon as a call on it succeeds", () => {
    recordOutOfCredit({ provider: "deepseek", model: "deepseek-flash", message: "x" });
    markProviderServing("deepseek");
    expect(isProviderOutOfCredit("deepseek")).toBe(false);
    expect(pickServingModel(deepseek()).resolved.apiModelId).toBe("deepseek-flash");
  });

  it("fails loud on the primary when the fallback's vendor is out of credit too", () => {
    recordOutOfCredit({ provider: "deepseek", model: "deepseek-flash", message: "x" });
    recordOutOfCredit({ provider: "zai", model: "glm-5.3-flash", message: "x" });
    expect(pickServingModel(deepseek()).resolved.apiModelId).toBe("deepseek-flash");
  });

  it("stores the refusal, the reroute and the recovery", async () => {
    const { store, calls } = recordingStore();
    await initVendorCredit(store);
    recordOutOfCredit({ provider: "deepseek", model: "deepseek-flash", status: 402, message: "Insufficient Balance" });
    recordReroute("deepseek");
    markProviderServing("deepseek");
    markProviderServing("deepseek"); // already serving: nothing more to store
    await vi.waitFor(() => expect(calls.map((c) => c[0])).toEqual(["refusal", "reroute", "close"]));
    expect(calls[0][1]).toMatchObject({ provider: "deepseek", model: "deepseek-flash" });
  });

  it("a restart mid-outage keeps the detour: open outages reload at boot", async () => {
    const { store } = recordingStore([{ provider: "deepseek", firstSeenAt: new Date("2026-10-29T15:59:46Z") }]);
    await initVendorCredit(store);
    expect(isProviderOutOfCredit("deepseek")).toBe(true);
  });
});

describe("staff read", () => {
  const now = new Date("2026-10-30T10:00:00Z");

  it("serves every provider, the out-of-credit one first and red, with a plain sentence", () => {
    const read = buildVendorCreditRead({
      now,
      days: 3,
      outages: [
        { provider: "deepseek", firstSeenAt: new Date("2026-10-29T15:59:46Z"), lastSeenAt: new Date("2026-10-29T23:10:27Z"), recoveredAt: null, refusedCalls: 3, reroutedCalls: 0 },
        { provider: "zai", firstSeenAt: new Date("2026-10-20T01:00:00Z"), lastSeenAt: new Date("2026-10-20T02:00:00Z"), recoveredAt: new Date("2026-10-20T03:00:00Z"), refusedCalls: 9, reroutedCalls: 0 },
      ],
      dayCounts: [{ day: "2026-10-29", provider: "deepseek", refusedCalls: 2, reroutedCalls: 0 }],
    });
    expect(read.vendors.map((v) => v.provider).sort()).toEqual([...CREDIT_PROVIDERS].sort());
    const ds = read.vendors[0];
    expect(ds).toMatchObject({ provider: "deepseek", outOfCredit: true, since: "2026-10-29T15:59:46.000Z", fallbackModel: "glm-5.3-flash", fallbackLabel: "GLM-5.3 Flash", refusedCalls: 3 });
    expect(ds.sentence).toBe("DeepSeek has no credit since Oct 29, 15:59 UTC. Calls go to GLM-5.3 Flash until a DeepSeek call succeeds.");
    const zai = read.vendors.find((v) => v.provider === "zai")!;
    expect(zai.outOfCredit).toBe(false);
    expect(zai.sentence).toBe("Z.ai serves calls. The last empty balance ended Oct 20, 03:00 UTC.");
    const google = read.vendors.find((v) => v.provider === "google")!;
    expect(google.sentence).toBe("Google Gemini serves calls. No empty balance seen.");
    for (const v of read.vendors) expect(v.sentence).not.toMatch(/[\u2013\u2014]/);
  });

  it("serves every day x provider, red from the first refused day until recovery", () => {
    const read = buildVendorCreditRead({
      now,
      days: 3,
      outages: [{ provider: "deepseek", firstSeenAt: new Date("2026-10-29T15:59:46Z"), lastSeenAt: new Date("2026-10-29T23:10:27Z"), recoveredAt: null, refusedCalls: 3, reroutedCalls: 0 }],
      dayCounts: [{ day: "2026-10-29", provider: "deepseek", refusedCalls: 2, reroutedCalls: 0 }],
    });
    expect(read.days).toHaveLength(3 * CREDIT_PROVIDERS.length);
    const ds = read.days.filter((d) => d.provider === "deepseek");
    expect(ds.map((d) => [d.day, d.outOfCredit, d.refusedCalls])).toEqual([
      ["2026-10-28", false, 0],
      ["2026-10-29", true, 2],
      ["2026-10-30", true, 0],
    ]);
    expect(read.days.filter((d) => d.provider !== "deepseek").every((d) => !d.outOfCredit)).toBe(true);
  });
});

describe("never an email", () => {
  // Owner rule: a monitoring alert is red on dashboard v2 Monitoring, never an
  // email. The out-of-credit staff email (transactional-email `/platform-send`)
  // is gone; this fails if any source file brings an email path back for it.
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
    });
  }

  it("no source file posts an out-of-credit alert to transactional-email", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const text = readFileSync(file, "utf8");
      for (const banned of ["/platform-send", ["provider", "credits", "exhausted"].join("_"), ["vendor", "out", "of", "credit"].join("_")]) {
        if (text.includes(banned)) offenders.push(`${file}: ${banned}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
