import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  judgeWithTypeSafe,
  TypeSafeError,
  TypeSafeInvalidRequestError,
  TypeSafeModelMismatchError,
  TypeSafeRateLimitError,
  TYPESAFE_DEFAULT_MODEL,
  TYPESAFE_MODELS,
  TYPESAFE_API_MODEL_ID,
  TYPESAFE_PROVIDER,
  type TypeSafeChoiceAnswer,
} from "../../src/lib/typesafe.js";
import { TYPESAFE_INPUT_TOKENS_COST_NAME } from "../../src/lib/cost-names.js";
import {
  JudgmentsRequestSchema,
  JUDGMENT_CHOICE_OPTIONS_MAX,
  JUDGMENT_SCORE_LEVELS_MAX,
} from "../../src/schemas.js";

const CHOICE_BODY = {
  model: "jev-1.13.0",
  answers: {
    department: {
      type: "choice",
      choice: "returns",
      confidence: 1.0,
      probabilities: { shipping: 0.0, returns: 1.0, billing: 0.0 },
    },
  },
  usage: { input_tokens: 330, output_tokens: 34 },
};

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const refused = (status: number, body: string) => ({
  ok: false,
  status,
  text: async () => body,
  headers: new Headers(),
});

describe("judgeWithTypeSafe", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  async function drive<T>(promise: Promise<T>): Promise<T | unknown> {
    const settled = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    return settled;
  }

  it("POSTs the vendor endpoint with bearer auth, the state/questions verbatim, and the PINNED release", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(CHOICE_BODY));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await judgeWithTypeSafe({
      apiKey: "secret-key",
      model: "jev-latest",
      state: "My running shoes arrived in the wrong size.",
      questions: {
        department: {
          type: "choice",
          instructions: "Which team should handle this?",
          criteria: { returns: "Exchanges", shipping: "Delivery", billing: "Charges" },
        },
      },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer secret-key");
    expect(init.headers["Content-Type"]).toBe("application/json");
    // The caller asked for `jev-latest`; the wire carries the release, because
    // the cost name is keyed on the release and an alias moves without notice.
    expect(JSON.parse(init.body)).toEqual({
      state: "My running shoes arrived in the wrong size.",
      model: TYPESAFE_API_MODEL_ID,
      questions: {
        department: {
          type: "choice",
          instructions: "Which team should handle this?",
          criteria: { returns: "Exchanges", shipping: "Delivery", billing: "Charges" },
        },
      },
    });
  });

  // The whole reason this vendor is worth adopting: a consumer must be able to
  // see that the model was hesitating and decline to act.
  it("preserves confidence and the full distribution rather than flattening to the winner", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        ok({
          model: "jev-1.13.0",
          answers: {
            department: {
              type: "choice",
              choice: "returns",
              confidence: 0.41,
              probabilities: { shipping: 0.33, returns: 0.41, billing: 0.26 },
            },
          },
          usage: { input_tokens: 312, output_tokens: 48 },
        }),
      ) as unknown as typeof fetch;

    const result = await judgeWithTypeSafe({
      apiKey: "k",
      model: "jev-latest",
      state: "s",
      questions: {
        department: { type: "choice", instructions: "which?", criteria: { a: "A", b: "B" } },
      },
    });

    const answer = result.answers.department as TypeSafeChoiceAnswer;
    expect(answer.choice).toBe("returns");
    expect(answer.confidence).toBe(0.41);
    expect(answer.probabilities).toEqual({ shipping: 0.33, returns: 0.41, billing: 0.26 });
  });

  it("returns the vendor's own input-token count — the billable quantity is never estimated", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok(CHOICE_BODY)) as unknown as typeof fetch;

    const result = await judgeWithTypeSafe({
      apiKey: "k",
      model: "jev-latest",
      state: "s",
      questions: { department: { type: "noul", instructions: "urgent?" } },
    });

    expect(result.inputTokens).toBe(330);
    expect(result.outputTokens).toBe(34);
  });

  it("throws when usage carries no input-token count rather than guessing a charge", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        ok({
          model: "jev-1.13.0",
          answers: { q: { type: "noul", noul: 0.9 } },
          usage: { output_tokens: 4 },
        }),
      ) as unknown as typeof fetch;

    await expect(
      judgeWithTypeSafe({
        apiKey: "k",
        model: "jev-latest",
        state: "s",
        questions: { q: { type: "noul", instructions: "urgent?" } },
      }),
    ).rejects.toBeInstanceOf(TypeSafeError);
  });

  it("throws when a choice answer arrives without its confidence", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        ok({
          model: "jev-1.13.0",
          answers: { q: { type: "choice", choice: "returns", probabilities: { returns: 1 } } },
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
      ) as unknown as typeof fetch;

    await expect(
      judgeWithTypeSafe({
        apiKey: "k",
        model: "jev-latest",
        state: "s",
        questions: { q: { type: "choice", instructions: "which?", criteria: { a: "A", b: "B" } } },
      }),
    ).rejects.toThrow(/confidence/);
  });

  it("throws when the response is missing an answer the caller asked for", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        ok({
          model: "jev-1.13.0",
          answers: { other: { type: "noul", noul: 0.5 } },
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
      ) as unknown as typeof fetch;

    await expect(
      judgeWithTypeSafe({
        apiKey: "k",
        model: "jev-latest",
        state: "s",
        questions: { q: { type: "noul", instructions: "urgent?" } },
      }),
    ).rejects.toThrow(/missing an answer for question "q"/);
  });

  // The DeepSeek lesson: an alias that quietly starts resolving to another
  // model is a different price under a cost name that no longer describes it.
  it("refuses an answer served by a model this service does not price", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        ok({
          model: "jev-2.0.0",
          answers: { q: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
      ) as unknown as typeof fetch;

    const err = await judgeWithTypeSafe({
      apiKey: "k",
      model: "jev-latest",
      state: "s",
      questions: { q: { type: "noul", instructions: "urgent?" } },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TypeSafeModelMismatchError);
    expect((err as Error).message).toMatch(/jev-2\.0\.0/);
  });

  it("does NOT retry a 422 — the same request shape is refused forever", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(refused(422, '{"error":{"message":"state exceeds 32k tokens"}}'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await drive(
      judgeWithTypeSafe({
        apiKey: "k",
        model: "jev-latest",
        state: "s",
        questions: { q: { type: "noul", instructions: "urgent?" } },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(TypeSafeInvalidRequestError);
    expect((err as TypeSafeInvalidRequestError).vendorMessage).toBe("state exceeds 32k tokens");
  });

  it("retries a 429 and returns the judgment the run had already paid for", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(refused(429, '{"error":{"message":"slow down"}}'))
      .mockResolvedValueOnce(refused(429, '{"error":{"message":"slow down"}}'))
      .mockResolvedValue(ok(CHOICE_BODY));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await drive(
      judgeWithTypeSafe({
        apiKey: "k",
        model: "jev-latest",
        state: "s",
        questions: { department: { type: "noul", instructions: "urgent?" } },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((result as { inputTokens: number }).inputTokens).toBe(330);
  });

  // Never a silent empty answer: a rate limit that outlasts the budget is
  // surfaced with the numbers that make saturation readable.
  it("gives up on a persistent 429 within a bound and stays loud", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(refused(429, '{"error":{"message":"slow down"}}'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await drive(
      judgeWithTypeSafe({
        apiKey: "k",
        model: "jev-latest",
        state: "s",
        questions: { q: { type: "noul", instructions: "urgent?" } },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(err).toBeInstanceOf(TypeSafeRateLimitError);
    expect((err as TypeSafeRateLimitError).attempts).toBe(5);
    expect((err as TypeSafeRateLimitError).waitedMs).toBeGreaterThan(0);
    expect((err as TypeSafeRateLimitError).vendorMessage).toBe("slow down");
  });

  it("backs off a 529 overload the same way, then fails loud", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(refused(529, "overloaded"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await drive(
      judgeWithTypeSafe({
        apiKey: "k",
        model: "jev-latest",
        state: "s",
        questions: { q: { type: "noul", instructions: "urgent?" } },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(err).toBeInstanceOf(TypeSafeError);
    expect(err).not.toBeInstanceOf(TypeSafeRateLimitError);
  });

  it("does NOT retry a 401 — a bad key does not clear by waiting", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(refused(401, "invalid api key"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await drive(
      judgeWithTypeSafe({
        apiKey: "k",
        model: "jev-latest",
        state: "s",
        questions: { q: { type: "noul", instructions: "urgent?" } },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(TypeSafeError);
  });
});

describe("TypeSafe vendor constants", () => {
  it("resolves the key under the fleet's provider slug for this vendor", () => {
    expect(TYPESAFE_PROVIDER).toBe("typesafe");
  });

  it("never lets an alias reach the wire — the pinned release is what gets sent", () => {
    expect(TYPESAFE_API_MODEL_ID).toBe("jev-1.13.0");
    expect(TYPESAFE_INPUT_TOKENS_COST_NAME).toContain("jev-1.13");
  });

  it("defaults to an alias the accepted-model set carries", () => {
    expect(TYPESAFE_MODELS).toContain(TYPESAFE_DEFAULT_MODEL);
  });

  // Output tokens are free at this vendor. A second row "for symmetry" with the
  // LLM vendors would bill customers for something no invoice carries.
  it("declares exactly one cost name, for input tokens", () => {
    expect(TYPESAFE_INPUT_TOKENS_COST_NAME).toMatch(/-tokens-input$/);
    expect(TYPESAFE_INPUT_TOKENS_COST_NAME).not.toMatch(/output/);
  });
});

describe("JudgmentsRequestSchema", () => {
  const noul = { type: "noul" as const, instructions: "Does this convey urgency?" };

  it("accepts the vendor's documented request shape", () => {
    const parsed = JudgmentsRequestSchema.safeParse({
      state: "Help! My payouts have been failing for 3 days.",
      questions: { is_urgent: noul },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a structured state (object or array), not only text", () => {
    expect(
      JudgmentsRequestSchema.safeParse({ state: { subject: "s" }, questions: { q: noul } }).success,
    ).toBe(true);
    expect(
      JudgmentsRequestSchema.safeParse({ state: ["line one", "line two"], questions: { q: noul } })
        .success,
    ).toBe(true);
  });

  it("rejects a request with no questions", () => {
    expect(JudgmentsRequestSchema.safeParse({ state: "s", questions: {} }).success).toBe(false);
  });

  it("refuses a Choice past the vendor's option ceiling before any spend", () => {
    const criteria: Record<string, string> = {};
    for (let i = 0; i <= JUDGMENT_CHOICE_OPTIONS_MAX; i += 1) criteria[`opt${i}`] = `option ${i}`;
    const parsed = JudgmentsRequestSchema.safeParse({
      state: "s",
      questions: { q: { type: "choice", instructions: "which?", criteria } },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a Score outside the vendor's 2-10 level range before any spend", () => {
    expect(
      JudgmentsRequestSchema.safeParse({
        state: "s",
        questions: { q: { type: "score", instructions: "how severe?", criteria: ["only one"] } },
      }).success,
    ).toBe(false);

    const tooMany = Array.from({ length: JUDGMENT_SCORE_LEVELS_MAX + 1 }, (_, i) => `level ${i}`);
    expect(
      JudgmentsRequestSchema.safeParse({
        state: "s",
        questions: { q: { type: "score", instructions: "how severe?", criteria: tooMany } },
      }).success,
    ).toBe(false);
  });

  it("accepts the structured criterion form the vendor documents for ambiguous inputs", () => {
    const parsed = JudgmentsRequestSchema.safeParse({
      state: "s",
      questions: {
        q: {
          type: "score",
          instructions: "how severe?",
          criteria: [
            { what: "Cosmetic", examples: ["a typo"] },
            "Blocking issue; no workaround exists",
          ],
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a model this service does not price", () => {
    expect(
      JudgmentsRequestSchema.safeParse({ state: "s", questions: { q: noul }, model: "jev-2.0.0" })
        .success,
    ).toBe(false);
  });
});
