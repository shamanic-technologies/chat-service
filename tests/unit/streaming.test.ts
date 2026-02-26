import { describe, it, expect } from "vitest";

/**
 * Inline the bufferToken logic from src/index.ts for unit testing.
 * This mirrors the actual implementation to verify streaming behavior.
 */
const BUTTON_RE = /^[-*]\s*\[.+?\]\s*$/;

function createBufferToken() {
  const sent: { type: string; content: string }[] = [];
  let fullResponse = "";
  let lineBuf = "";
  let held = "";

  function sendSSE(data: { type: string; content: string }) {
    sent.push(data);
  }

  function bufferToken(chunk: string): void {
    fullResponse += chunk;

    const combined = lineBuf + chunk;
    const parts = combined.split("\n");
    const partial = parts.pop()!;

    for (const line of parts) {
      const fullLine = line + "\n";
      if (BUTTON_RE.test(line.trimEnd())) {
        held += fullLine;
      } else {
        if (held) {
          sendSSE({ type: "token", content: held });
          held = "";
        }
        sendSSE({ type: "token", content: fullLine });
      }
    }

    lineBuf = partial;

    if (lineBuf && !/^[-*]\s*\[/.test(lineBuf)) {
      if (held) {
        sendSSE({ type: "token", content: held });
        held = "";
      }
      sendSSE({ type: "token", content: lineBuf });
      lineBuf = "";
    }
  }

  return { bufferToken, sent, getHeld: () => held, getLineBuf: () => lineBuf, getFullResponse: () => fullResponse };
}

describe("bufferToken streaming", () => {
  it("flushes partial lines immediately without waiting for newline", () => {
    const { bufferToken, sent } = createBufferToken();

    bufferToken("Hello ");
    expect(sent).toEqual([{ type: "token", content: "Hello " }]);

    bufferToken("world!");
    expect(sent).toEqual([
      { type: "token", content: "Hello " },
      { type: "token", content: "world!" },
    ]);
  });

  it("sends complete lines with newline included", () => {
    const { bufferToken, sent } = createBufferToken();

    bufferToken("Hello world!\n");
    expect(sent).toEqual([{ type: "token", content: "Hello world!\n" }]);
  });

  it("handles multi-line chunks correctly", () => {
    const { bufferToken, sent } = createBufferToken();

    bufferToken("Line one\nLine two\nPartial");
    expect(sent).toEqual([
      { type: "token", content: "Line one\n" },
      { type: "token", content: "Line two\n" },
      { type: "token", content: "Partial" },
    ]);
  });

  it("holds back complete button lines", () => {
    const { bufferToken, sent, getHeld } = createBufferToken();

    bufferToken("Choose:\n- [Option A]\n- [Option B]\n");
    expect(sent).toEqual([{ type: "token", content: "Choose:\n" }]);
    expect(getHeld()).toBe("- [Option A]\n- [Option B]\n");
  });

  it("holds partial line that looks like a button start", () => {
    const { bufferToken, sent, getLineBuf } = createBufferToken();

    bufferToken("- [Star");
    // Should be held in lineBuf, not sent
    expect(sent).toEqual([]);
    expect(getLineBuf()).toBe("- [Star");
  });

  it("completes a button line and holds it", () => {
    const { bufferToken, sent, getHeld } = createBufferToken();

    bufferToken("- [Star");
    bufferToken("t campaign]\n");
    expect(sent).toEqual([]);
    expect(getHeld()).toBe("- [Start campaign]\n");
  });

  it("flushes held non-button content when normal text follows", () => {
    const { bufferToken, sent } = createBufferToken();

    bufferToken("- [Option A]\n");
    expect(sent).toEqual([]);

    bufferToken("Regular text\n");
    expect(sent).toEqual([
      { type: "token", content: "- [Option A]\n" },
      { type: "token", content: "Regular text\n" },
    ]);
  });

  it("handles asterisk button syntax", () => {
    const { bufferToken, sent, getHeld } = createBufferToken();

    bufferToken("Pick:\n* [Yes]\n* [No]\n");
    expect(sent).toEqual([{ type: "token", content: "Pick:\n" }]);
    expect(getHeld()).toBe("* [Yes]\n* [No]\n");
  });

  it("streams a realistic multi-chunk response", () => {
    const { bufferToken, sent, getHeld } = createBufferToken();

    // Simulate Gemini sending in chunks (typical behavior)
    bufferToken("I can help ");
    bufferToken("you with that! ");
    bufferToken("Here are your options:\n\n");
    bufferToken("- [Create a campaign]\n");
    bufferToken("- [View stats]\n");

    expect(sent).toEqual([
      { type: "token", content: "I can help " },
      { type: "token", content: "you with that! " },
      { type: "token", content: "Here are your options:\n" },
      { type: "token", content: "\n" },
    ]);
    expect(getHeld()).toBe("- [Create a campaign]\n- [View stats]\n");
  });

  it("accumulates full response regardless of buffering", () => {
    const { bufferToken, getFullResponse } = createBufferToken();

    bufferToken("Hello ");
    bufferToken("world!\n");
    bufferToken("- [Button]\n");

    expect(getFullResponse()).toBe("Hello world!\n- [Button]\n");
  });

  it("handles empty chunks gracefully", () => {
    const { bufferToken, sent } = createBufferToken();

    bufferToken("");
    expect(sent).toEqual([]);

    bufferToken("text");
    expect(sent).toEqual([{ type: "token", content: "text" }]);
  });

  it("does not hold regular lines starting with dash", () => {
    const { bufferToken, sent } = createBufferToken();

    // "- plain item" doesn't match button pattern [...]
    bufferToken("- plain item\n");
    expect(sent).toEqual([{ type: "token", content: "- plain item\n" }]);
  });
});
