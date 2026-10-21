import { describe, expect, it } from "vitest";
import { buildTypeSafeBody, TYPESAFE_IMAGES_HEADER, type TypeSafeQuestion } from "../../src/lib/typesafe.js";
import {
  fromDecisionsAnswers,
  OpenAiDecisionsError,
  OpenAiDecisionsInvalidRequestError,
  toDecisionsInput,
  toDecisionsQuestions,
} from "../../src/lib/openai-decisions.js";
import { judgeActualCostName, judgeErrorResponse, judgeHoldCostName } from "../../src/lib/judges.js";
import { JudgmentsRequestSchema } from "../../src/schemas.js";

const image = { format: "png" as const, base64: "iVBORw0KGgo=", width: 1568, height: 882, sourceWidth: 1920, sourceHeight: 1080 };
const noul: TypeSafeQuestion = {
  type: "noul",
  instructions: "Is there no clearly visible phone number in the header of the homepage above the fold?",
};

describe("buildTypeSafeBody", () => {
  it("text-only: byte-for-byte the pre-image body, no image header", () => {
    const { body, headers } = buildTypeSafeBody({ state: "s", questions: { q: noul } });
    expect(JSON.stringify(body)).toBe(JSON.stringify({ state: "s", model: "jev-1.13.0", questions: { q: noul } }));
    expect(headers).toEqual({});
  });

  it("image only: the reference IS the state, the image travels in assets, header on", () => {
    const { body, headers } = buildTypeSafeBody({ state: undefined, questions: { q: noul }, image });
    const ref = body.state as string;
    expect(ref).toMatch(/^img-[0-9a-f-]{36}$/);
    expect(body.assets).toEqual({ [ref]: { type: "image", format: "png", data_base64: image.base64 } });
    expect(headers).toEqual({ [TYPESAFE_IMAGES_HEADER]: "true" });
  });

  it("image + state: both reach the judge", () => {
    const { body } = buildTypeSafeBody({ state: { domain: "x.com" }, questions: { q: noul }, image });
    const st = body.state as { image: string; context: unknown };
    expect(st.context).toEqual({ domain: "x.com" });
    expect(Object.keys(body.assets as object)).toEqual([st.image]);
  });
});

describe("OpenAI Decisions translation", () => {
  it("maps noul to predicate and choice to choices", () => {
    expect(
      toDecisionsQuestions({
        q: noul,
        c: { type: "choice", instructions: "Which?", criteria: { a: "first", b: { what: "second" } } },
      }),
    ).toEqual([
      { type: "predicate", name: "q", instructions: noul.instructions },
      {
        type: "choice",
        name: "c",
        instructions: "Which?",
        choices: [
          { value: "a", description: "first" },
          { value: "b", description: "second" },
        ],
      },
    ]);
  });

  it("refuses what it cannot translate without rewriting the question", () => {
    expect(() =>
      toDecisionsQuestions({ s: { type: "score", instructions: "How?", criteria: ["low", "high"] } }),
    ).toThrow(OpenAiDecisionsInvalidRequestError);
    expect(() =>
      toDecisionsQuestions({ q: { ...noul, criteria: { true: "yes", false: "no" } } as TypeSafeQuestion }),
    ).toThrow(OpenAiDecisionsInvalidRequestError);
    expect(() =>
      toDecisionsQuestions({
        c: { type: "choice", instructions: "?", criteria: { a: { what: "x", examples: ["e"] }, b: "y" } },
      }),
    ).toThrow(OpenAiDecisionsInvalidRequestError);
  });

  it("sends the image as a data URL after the state text", () => {
    expect(toDecisionsInput({ d: 1 }, image)).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: '{"d":1}' },
          { type: "input_image", image_url: `data:image/png;base64,${image.base64}` },
        ],
      },
    ]);
  });

  it("translates answers back to our dialect (live 2026-10-21 shape)", () => {
    const answers = fromDecisionsAnswers(
      { q: noul, c: { type: "choice", instructions: "?", criteria: { blue: "b", red: "r" } } },
      [
        { type: "predicate", name: "q", probability: 0.48 },
        {
          type: "choice",
          name: "c",
          choice: "blue",
          probabilities: [
            { value: "blue", probability: 1 },
            { value: "red", probability: 0 },
          ],
          confidence: 1,
        },
      ],
    );
    expect(answers).toEqual({
      q: { type: "noul", noul: 0.48 },
      c: { type: "choice", choice: "blue", confidence: 1, probabilities: { blue: 1, red: 0 } },
    });
  });

  it("fails loud on a refusal or a missing answer", () => {
    expect(() => fromDecisionsAnswers({ q: noul }, [{ type: "refusal", name: "q" }])).toThrow(OpenAiDecisionsError);
    expect(() => fromDecisionsAnswers({ q: noul }, [])).toThrow(/missing an answer/);
  });
});

describe("judge cost names", () => {
  it("Jev keeps its one name; Luna switches to the long-context row past 272K", () => {
    expect(judgeHoldCostName("jev")).toBe("typesafe-jev-1.13-tokens-input");
    expect(judgeActualCostName("jev", 999_999)).toBe("typesafe-jev-1.13-tokens-input");
    expect(judgeActualCostName("openai-luna", 272_000)).toBe(judgeHoldCostName("openai-luna"));
    expect(judgeActualCostName("openai-luna", 272_001)).toContain("long-context");
  });

  it("names the judge on a generic failure", () => {
    expect(judgeErrorResponse("openai-luna", new Error("boom"))).toEqual({
      status: 502,
      body: { error: "Judgment failed (OpenAI Decisions). Please try again.", judge: "openai-luna" },
    });
  });
});

describe("JudgmentsRequestSchema — image + judge", () => {
  it("accepts an image without a state", () => {
    expect(
      JudgmentsRequestSchema.safeParse({ image: { url: "https://x.dev/a.png" }, questions: { q: noul } }).success,
    ).toBe(true);
  });
  it("refuses a request with neither state nor image", () => {
    expect(JudgmentsRequestSchema.safeParse({ questions: { q: noul } }).success).toBe(false);
  });
  it("refuses a Jev model beside another judge, and an unknown judge", () => {
    expect(
      JudgmentsRequestSchema.safeParse({ state: "s", questions: { q: noul }, judge: "openai-luna", model: "jev-latest" })
        .success,
    ).toBe(false);
    expect(JudgmentsRequestSchema.safeParse({ state: "s", questions: { q: noul }, judge: "clef" }).success).toBe(false);
  });
});

describe("Cloudflare Clef judges", () => {
  it("sends the System One body with an empty state when only an image is judged, never words of ours", async () => {
    const { buildClefBody } = await import("../../src/lib/cloudflare-clef.js");
    expect(buildClefBody({ model: "clef-flash", state: undefined, questions: { q: noul }, image })).toEqual({
      model: "clef-flash",
      state: "",
      questions: { q: noul },
      images: [{ content_type: "image/png", base64: image.base64 }],
    });
  });

  it("each Clef size has its own cost name", () => {
    expect(judgeHoldCostName("cloudflare-clef")).toBe("cloudflare-clef-tokens-input");
    expect(judgeHoldCostName("cloudflare-clef-flash")).toBe("cloudflare-clef-flash-tokens-input");
    expect(judgeActualCostName("cloudflare-clef-flash", 999_999)).toBe("cloudflare-clef-flash-tokens-input");
  });

  it("names Clef on a failure", () => {
    expect(judgeErrorResponse("cloudflare-clef", new Error("boom")).body).toEqual({
      error: "Judgment failed (Cloudflare Clef). Please try again.",
      judge: "cloudflare-clef",
    });
  });
});
