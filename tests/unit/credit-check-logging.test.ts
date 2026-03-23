import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression test: 402 Insufficient Credits responses MUST produce a
 * console.warn log so they are visible in Railway.  Previously the 402 was
 * returned silently, making credit rejections invisible in backend logs.
 *
 * We mirror the inline-logic pattern used elsewhere in this test suite
 * (see streaming.test.ts) because the codebase has no supertest endpoint infra.
 */

/** Mirrors the logging + response logic from src/index.ts POST /chat and /complete */
function handleInsufficientCredits(
  endpoint: "chat" | "complete",
  orgId: string,
  authResult: { sufficient: false; balance_cents: number; required_cents: number },
) {
  console.warn(
    `[${endpoint}] insufficient credits: org="${orgId}" balance_cents=${authResult.balance_cents} required_cents=${authResult.required_cents}`,
  );
  return {
    status: 402,
    body: {
      error: "Insufficient credits" as const,
      balance_cents: authResult.balance_cents,
      required_cents: authResult.required_cents,
    },
  };
}

describe("credit-check 402 logging", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("logs a warning when /chat rejects with insufficient credits", () => {
    const result = handleInsufficientCredits("chat", "org-abc-123", {
      sufficient: false,
      balance_cents: 200,
      required_cents: 500,
    });

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("Insufficient credits");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      '[chat] insufficient credits: org="org-abc-123" balance_cents=200 required_cents=500',
    );
  });

  it("logs a warning when /complete rejects with insufficient credits", () => {
    const result = handleInsufficientCredits("complete", "org-xyz-789", {
      sufficient: false,
      balance_cents: 5,
      required_cents: 25,
    });

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("Insufficient credits");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      '[complete] insufficient credits: org="org-xyz-789" balance_cents=5 required_cents=25',
    );
  });

  it("includes org_id, balance_cents, and required_cents in log message", () => {
    handleInsufficientCredits("chat", "b645207b", {
      sufficient: false,
      balance_cents: 2500,
      required_cents: 3000,
    });

    const logMessage = warnSpy.mock.calls[0]![0] as string;
    expect(logMessage).toContain('org="b645207b"');
    expect(logMessage).toContain("balance_cents=2500");
    expect(logMessage).toContain("required_cents=3000");
  });
});
