import { describe, it, expect } from "vitest";
import { isSessionOwner } from "../../src/lib/session-errors.js";

describe("isSessionOwner", () => {
  const caller = { orgId: "org-1", userId: "user-a" };
  it("owns its own session", () => {
    expect(isSessionOwner({ orgId: "org-1", userId: "user-a" }, caller)).toBe(true);
  });
  it("does not own a teammate's session in the same org", () => {
    expect(isSessionOwner({ orgId: "org-1", userId: "user-b" }, caller)).toBe(false);
  });
  it("does not own another org's session, even with the same user id", () => {
    expect(isSessionOwner({ orgId: "org-2", userId: "user-a" }, caller)).toBe(false);
  });
  it("nobody owns a legacy session with no recorded user", () => {
    expect(isSessionOwner({ orgId: "org-1", userId: null }, caller)).toBe(false);
  });
});
