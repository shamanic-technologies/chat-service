import { describe, expect, it } from "vitest";
import { toWellFormed, toWellFormedDeep } from "../../src/lib/well-formed-text.js";
import { buildTypeSafeBody } from "../../src/lib/typesafe.js";

// JEV-INVALID-UNICODE-1126: brand-service cut a scraped page with `.slice(0, N)`,
// leaving half an emoji; Jev refused 13 judgments in a row for a new client
// with 400 "Request contains invalid Unicode text." (probed live: lone
// surrogates refused, NUL and U+FFFE accepted).
const cut = "Write better 😀".slice(0, 14); // ends on the high half of 😀

describe("toWellFormed", () => {
  it("replaces a lone high or low surrogate with U+FFFD", () => {
    expect(cut.endsWith("\uD83D")).toBe(true);
    expect(toWellFormed(cut)).toBe("Write better �");
    expect(toWellFormed("a\uDE00b")).toBe("a�b");
  });

  it("keeps whole emoji, NUL and other text byte-equal", () => {
    const s = "ok 😀 \u0000 ￾ é 中";
    expect(toWellFormed(s)).toBe(s);
  });

  it("matches String.prototype.toWellFormed", () => {
    for (const s of [cut, "\uDE00\uD83D", "😀😀\uD83D\uD83D", "plain"]) {
      expect(toWellFormed(s)).toBe((s as unknown as { toWellFormed(): string }).toWellFormed());
    }
  });
});

describe("toWellFormedDeep", () => {
  it("fixes every string in nested objects and arrays, keys included", () => {
    expect(toWellFormedDeep({ pages: [cut, { [cut]: 3, ok: true, n: null }] })).toEqual({
      pages: ["Write better �", { "Write better �": 3, ok: true, n: null }],
    });
  });
});

describe("buildTypeSafeBody", () => {
  it("sends Jev well-formed state and questions, so the request is never refused for a cut emoji", () => {
    const { body } = buildTypeSafeBody({
      state: { homepageText: cut },
      questions: { q: { type: "noul", instructions: `Is ${cut} a competitor?` } },
    });
    const wire = JSON.stringify(body);
    expect(wire).not.toMatch(/\\ud83d/i);
    expect(body.state).toEqual({ homepageText: "Write better �" });
  });

  it("leaves a clean text-only body byte-equal", () => {
    const state = { a: "x 😀" };
    const questions = { q: { type: "noul" as const, instructions: "y?" } };
    expect(JSON.stringify(buildTypeSafeBody({ state, questions }).body)).toBe(
      JSON.stringify({ state, model: "jev-1.13.0", questions }),
    );
  });
});
