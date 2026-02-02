import { describe, it, expect } from "vitest";

// Inline the function for unit testing (avoids importing the full server)
function extractButtons(text: string): { label: string; value: string }[] {
  const lines = text.trim().split("\n");
  const buttons: { label: string; value: string }[] = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^[-*]\s*\[(.+?)\]\s*$/);
    if (match) {
      buttons.unshift({ label: match[1], value: match[1] });
    } else if (buttons.length > 0) {
      break;
    }
  }

  return buttons;
}

describe("extractButtons", () => {
  it("extracts buttons from markdown list at end of text", () => {
    const text = `Here are some options:
- [Create a campaign]
- [Search for leads]
- [Check my setup]`;

    const buttons = extractButtons(text);
    expect(buttons).toEqual([
      { label: "Create a campaign", value: "Create a campaign" },
      { label: "Search for leads", value: "Search for leads" },
      { label: "Check my setup", value: "Check my setup" },
    ]);
  });

  it("returns empty array when no buttons found", () => {
    const text = "Just a normal response with no buttons.";
    expect(extractButtons(text)).toEqual([]);
  });

  it("only extracts trailing button block", () => {
    const text = `Some text here.
More text.
- [Option A]
- [Option B]`;

    const buttons = extractButtons(text);
    expect(buttons).toEqual([
      { label: "Option A", value: "Option A" },
      { label: "Option B", value: "Option B" },
    ]);
  });

  it("handles asterisk bullets", () => {
    const text = `Pick one:
* [Yes]
* [No]`;

    const buttons = extractButtons(text);
    expect(buttons).toEqual([
      { label: "Yes", value: "Yes" },
      { label: "No", value: "No" },
    ]);
  });

  it("ignores non-button list items", () => {
    const text = `Here is a list:
- Item one
- Item two
- [Only this is a button]`;

    const buttons = extractButtons(text);
    expect(buttons).toEqual([
      { label: "Only this is a button", value: "Only this is a button" },
    ]);
  });
});

// Inline stripButtons for unit testing
function stripButtons(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  const beforeButtons = end;
  while (end > 0 && /^[-*]\s*\[.+?\]\s*$/.test(lines[end - 1])) end--;
  if (end === beforeButtons) return text;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(0, end).join("\n");
}

describe("stripButtons", () => {
  it("strips trailing button lines from text", () => {
    const text = `Here are some options:
- [Create a campaign]
- [Search for leads]`;

    expect(stripButtons(text)).toBe("Here are some options:");
  });

  it("returns original text when no buttons present", () => {
    const text = "Just a normal response.";
    expect(stripButtons(text)).toBe("Just a normal response.");
  });

  it("strips buttons and trailing blank lines", () => {
    const text = "Some text\n\n- [Yes]\n- [No]\n";
    expect(stripButtons(text)).toBe("Some text");
  });

  it("only strips trailing buttons, preserves earlier content", () => {
    const text = "Check [this] link\n- [Button]";
    expect(stripButtons(text)).toBe("Check [this] link");
  });

  it("handles asterisk bullets", () => {
    const text = "Pick one:\n* [Yes]\n* [No]";
    expect(stripButtons(text)).toBe("Pick one:");
  });
});
