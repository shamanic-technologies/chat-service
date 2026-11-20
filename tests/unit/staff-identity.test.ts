import { describe, it, expect } from "vitest";
import { STAFF_USERS, isStaffUser } from "../../src/lib/staff-identity.js";

const GMAIL_STAFF = "cfe148ed-e3d8-40a2-8920-f8c040a81934";
const DY_STAFF = "7b417d70-29b5-471b-a8e1-20e75225c0af";
// The attacker's user row (prod 2026-11-20, org 3afacd9a-…) and the internal probe row.
const ATTACKER = "a4651533-7acc-4c6e-be22-3a9b0e037568";
const PROBE = "59b396bb-0000-4000-8000-000000000000";

describe("isStaffUser (SEC-STAFF-EMAIL-1120)", () => {
  it("pins exactly the two staff user rows", () => {
    expect([...STAFF_USERS.entries()].sort()).toEqual([
      [DY_STAFF, "kevin@distribute.you"],
      [GMAIL_STAFF, "kevin.lourd@gmail.com"],
    ].sort());
  });

  it.each([
    [GMAIL_STAFF, "kevin.lourd@gmail.com", true],
    [GMAIL_STAFF, " Kevin.Lourd@gmail.com ", true],
    [DY_STAFF, "kevin@distribute.you", true],
    // A customer-created user carrying the staff address: not staff.
    [ATTACKER, "kevin.lourd@gmail.com", false],
    [PROBE, "kevin.lourd@gmail.com", false],
    [ATTACKER, "kevin@distribute.you", false],
    // The old domain rule is gone: any @distribute.you string grants nothing.
    [ATTACKER, "anyone@distribute.you", false],
    // Plus-addressing no longer matches.
    [GMAIL_STAFF, "kevin.lourd+x@gmail.com", false],
    // A pinned row whose email was changed away from the staff address: not staff.
    [GMAIL_STAFF, "client@acme.com", false],
    [DY_STAFF, "kevin.lourd@gmail.com", false],
    [GMAIL_STAFF, null, false],
    [null, "kevin.lourd@gmail.com", false],
    ["", "kevin@distribute.you", false],
  ])("%s / %s → %s", (userId, email, expected) => expect(isStaffUser(userId, email)).toBe(expected));
});

describe("one staff predicate in src (source guard)", () => {
  it("no email-only staff rule survives anywhere in src", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = new URL("../../src", import.meta.url).pathname;
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p);
    });
    walk(root);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/isStaffEmail|endsWith\(["']@distribute\.you/);
    }
  });
});
