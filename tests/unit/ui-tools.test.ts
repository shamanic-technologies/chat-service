import { describe, it, expect } from "vitest";
import {
  CLIENT_UI_TOOL_NAMES,
  OPEN_PAGE_TOOL,
  PRESENT_CHOICES_TOOL,
  parseChoicesArgs,
  parseChoicesIntro,
  parseOpenPageArgs,
} from "../../src/lib/ui-tools.js";
import { TOOL_REGISTRY } from "../../src/lib/anthropic.js";
import { sanitizeGeminiSchema } from "../../src/lib/gemini.js";

describe("present_choices — parseChoicesArgs", () => {
  it("keeps every visual kind and sends the label when a card has no value", () => {
    const record = parseChoicesArgs({
      question: "What first?",
      choices: [
        { label: "Answer replies", description: "3 people wrote back", visual: { type: "number", value: "3", unit: "replies" } },
        { label: "Raise budget", value: "Raise my daily budget", visual: { type: "icon", icon: "wallet" } },
        { label: "Acme", visual: { type: "image", imageUrl: "https://logo.clearbit.com/acme.com" } },
        { label: "Spend trend", visual: { type: "chart", series: [1, 2, 4], unit: "$" } },
      ],
    });
    expect(record.question).toBe("What first?");
    expect(record.allowFreeText).toBe(true);
    expect(record.choices.map((c) => c.value)).toEqual([
      "Answer replies",
      "Raise my daily budget",
      "Acme",
      "Spend trend",
    ]);
    expect(record.choices[0].visual).toEqual({ type: "number", value: "3", unit: "replies" });
    expect(record.choices[3].visual).toEqual({ type: "chart", series: [1, 2, 4], unit: "$" });
  });

  it("honours allowFreeText: false", () => {
    const r = parseChoicesArgs({ choices: [{ label: "A" }, { label: "B" }], allowFreeText: false });
    expect(r.allowFreeText).toBe(false);
  });

  it("drops fields that do not belong to the chosen visual type", () => {
    const r = parseChoicesArgs({
      choices: [{ label: "A", visual: { type: "icon", icon: "mail", series: [1, 2] } }, { label: "B" }],
    });
    expect(r.choices[0].visual).toEqual({ type: "icon", icon: "mail" });
  });

  it.each([
    ["a single card", { choices: [{ label: "Only" }] }],
    ["seven cards", { choices: Array.from({ length: 7 }, (_, i) => ({ label: `C${i}` })) }],
    ["a card with no label", { choices: [{ description: "x" }, { label: "B" }] }],
    ["a number visual with no value", { choices: [{ label: "A", visual: { type: "number" } }, { label: "B" }] }],
    ["an image visual that is not a URL", { choices: [{ label: "A", visual: { type: "image", imageUrl: "acme" } }, { label: "B" }] }],
    ["an unknown visual type", { choices: [{ label: "A", visual: { type: "video" } }, { label: "B" }] }],
    ["no choices at all", {}],
  ])("rejects %s (the model gets a tool error and retries)", (_name, args) => {
    expect(() => parseChoicesArgs(args as Record<string, unknown>)).toThrow(/present_choices/);
  });
});

describe("present_choices — required intro text", () => {
  it("returns the trimmed text", () => {
    expect(parseChoicesIntro({ text: "  You have 3 replies.  " })).toBe("You have 3 replies.");
  });
  it.each([[{}], [{ text: "" }], [{ text: "   " }], [{ text: 42 }], [{ text: "x".repeat(1201) }]])("refuses %j", (args) => {
    expect(() => parseChoicesIntro(args as Record<string, unknown>)).toThrow(/present_choices/);
  });
  it("the tool schema requires it", () => {
    expect((PRESENT_CHOICES_TOOL.input_schema as { required: string[] }).required).toEqual(["text", "choices"]);
  });
});

describe("open_page — parseOpenPageArgs", () => {
  it("keeps the page id and the ids the client needs", () => {
    expect(parseOpenPageArgs({ page: "offer-today", brandId: "b1", offerId: "o1", title: "This week" })).toEqual({
      page: "offer-today",
      brandId: "b1",
      offerId: "o1",
      title: "This week",
    });
  });

  it.each([["https://distribute.you/v2"], [""], ["/leading-slash"]])("refuses %s as a page id", (page) => {
    expect(() => parseOpenPageArgs({ page })).toThrow(/open_page/);
  });
});

describe("rich-UI tool registration", () => {
  it("is selectable through allowedTools like every other tool", () => {
    expect(TOOL_REGISTRY.present_choices).toBe(PRESENT_CHOICES_TOOL);
    expect(TOOL_REGISTRY.open_page).toBe(OPEN_PAGE_TOOL);
  });

  it("streams no tool card for the client-UI tools", () => {
    expect([...CLIENT_UI_TOOL_NAMES].sort()).toEqual(["open_page", "present_choices", "request_user_input"]);
  });

  it("survives the Gemini schema sanitizer with its fields intact", () => {
    const { schema, removed } = sanitizeGeminiSchema(PRESENT_CHOICES_TOOL.input_schema as unknown as Record<string, unknown>);
    expect(removed).toEqual([]);
    const params = schema as { properties: { choices: { items: { properties: Record<string, unknown> } } } };
    expect(Object.keys(params.properties.choices.items.properties).sort()).toEqual([
      "description",
      "label",
      "value",
      "visual",
    ]);
  });
});

describe("the text above the cards is an ANSWER, never a working note (prod 2026-10-10)", () => {
  it("the tool contract says so, with a good example", () => {
    const text = (PRESENT_CHOICES_TOOL.input_schema as { properties: { text: { description: string } } }).properties.text.description;
    expect(text).toMatch(/ANSWER to the user/);
    expect(text).toMatch(/Never your own plan or next step/);
    expect(text).toMatch(/Good: 'You have 2 replies waiting/);
    expect(PRESENT_CHOICES_TOOL.description).toMatch(/anything you write beside a tool call is dropped/);
  });

  it("both loops hold text written beside a tool call for a present_choices config", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "../../src/index.ts"), "utf-8");
    expect(src).toContain('const holdTextBesideTools = holdTextBesideToolCallsFor(configKey) || allowedToolNames.includes("present_choices");');
    expect(src).toContain('if (finalMessage.stop_reason !== "tool_use") bufferToken(iterText);');
    expect(src).toContain('holdTextBesideToolCalls: holdTextBesideToolCallsFor(configKey) || allowedToolNames.includes("present_choices"),');
  });
});
