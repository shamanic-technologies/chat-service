import { describe, it, expect } from "vitest";
import { JSON_RESPONSE_SYSTEM_SUFFIX } from "../../src/lib/json-prompt.js";

describe("JSON_RESPONSE_SYSTEM_SUFFIX", () => {
  it("instructs the model to return a plain object, never an array", () => {
    expect(JSON_RESPONSE_SYSTEM_SUFFIX).toContain("single JSON object");
    expect(JSON_RESPONSE_SYSTEM_SUFFIX).toContain("Never wrap the result in an array");
    expect(JSON_RESPONSE_SYSTEM_SUFFIX).not.toContain("or array");
  });
});
