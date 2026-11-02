import { describe, expect, it } from "vitest";
import { LabelFileSchema, trueAgreement } from "../../src/evals/labels.js";

describe("trueAgreement", () => {
  const labels = [
    { scenario: "a", replay: 0, true: true },
    { scenario: "a", replay: 1, true: false, unsupported: "Your first emails go out today" },
    { scenario: "b", replay: 0, true: true },
  ];

  it("counts agreement and names each false alarm and each invention let through", () => {
    const got = trueAgreement(
      [
        { scenario: "a", replay: 0, judgedTrue: false },
        { scenario: "a", replay: 1, judgedTrue: true },
        { scenario: "b", replay: 0, judgedTrue: true },
        { scenario: "c", replay: 0, judgedTrue: true },
      ],
      labels,
    );
    expect(got).toEqual({
      labelled: 3,
      agree: 1,
      rate: 1 / 3,
      falseAlarms: [{ scenario: "a", replay: 0 }],
      missed: [{ scenario: "a", replay: 1 }],
    });
  });

  it("fails loud when no judged reply carries a label (wrong run or wrong file)", () => {
    expect(() => trueAgreement([{ scenario: "z", replay: 0, judgedTrue: true }], labels)).toThrow(/no judged reply carries a label/);
  });

  it("a label file names the run it was checked on", () => {
    expect(LabelFileSchema.safeParse({ labels }).success).toBe(false);
    expect(LabelFileSchema.safeParse({ run: "2026-11-02T13:12:00.000Z", labels }).success).toBe(true);
  });
});
