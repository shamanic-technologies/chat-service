import { describe, it, expect } from "vitest";
import { SESSION_NOT_FOUND_EVENT } from "../../src/lib/session-errors.js";

describe("SESSION_NOT_FOUND_EVENT", () => {
  it("uses the error event shape (type=error, code, message), not token", () => {
    expect(SESSION_NOT_FOUND_EVENT.type).toBe("error");
    expect(SESSION_NOT_FOUND_EVENT.code).toBe("session_not_found");
    expect(typeof SESSION_NOT_FOUND_EVENT.message).toBe("string");
    expect(SESSION_NOT_FOUND_EVENT.message.length).toBeGreaterThan(0);
  });
});
