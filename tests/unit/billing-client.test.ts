import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.BILLING_SERVICE_API_KEY = "test-billing-key";
  process.env.BILLING_SERVICE_URL = "https://billing.test.local";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

async function loadModule() {
  vi.resetModules();
  return import("../../src/lib/billing-client.js");
}

describe("authorizeCredits", () => {
  it("sends POST with items array and correct headers", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ sufficient: true, balance_cents: 5000, required_cents: 25 }),
    });

    const { authorizeCredits } = await loadModule();
    const result = await authorizeCredits({
      items: [
        { costName: "claude-sonnet-4-6-tokens-input", quantity: 1000 },
        { costName: "claude-sonnet-4-6-tokens-output", quantity: 500 },
      ],
      description: "chat — claude-sonnet-4-6",
      orgId: "org-123",
      userId: "user-456",
      runId: "run-789",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://billing.test.local/v1/credits/authorize",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-API-Key": "test-billing-key",
          "x-org-id": "org-123",
          "x-user-id": "user-456",
          "x-run-id": "run-789",
        }),
        body: JSON.stringify({
          items: [
            { costName: "claude-sonnet-4-6-tokens-input", quantity: 1000 },
            { costName: "claude-sonnet-4-6-tokens-output", quantity: 500 },
          ],
          description: "chat — claude-sonnet-4-6",
        }),
      }),
    );
    expect(result).toEqual({ sufficient: true, balance_cents: 5000, required_cents: 25 });
  });

  it("returns sufficient: false with required_cents when balance is too low", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ sufficient: false, balance_cents: 5, required_cents: 25 }),
    });

    const { authorizeCredits } = await loadModule();
    const result = await authorizeCredits({
      items: [{ costName: "claude-sonnet-4-6-tokens-output", quantity: 16000 }],
      description: "chat — claude-sonnet-4-6",
      orgId: "org-123",
      userId: "user-456",
      runId: "run-789",
    });

    expect(result.sufficient).toBe(false);
    expect(result.balance_cents).toBe(5);
    expect(result.required_cents).toBe(25);
  });

  it("forwards tracking headers when provided", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ sufficient: true, balance_cents: 5000, required_cents: 10 }),
    });

    const { authorizeCredits } = await loadModule();
    await authorizeCredits({
      items: [{ costName: "claude-sonnet-4-6-tokens-input", quantity: 500 }],
      description: "chat — claude-sonnet-4-6",
      orgId: "org-123",
      userId: "user-456",
      runId: "run-789",
      trackingHeaders: {
        "x-campaign-id": "camp-1",
        "x-brand-id": "brand-2",
        "x-workflow-slug": "wf-3",
      },
    });

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = callArgs[1].headers;
    expect(headers["x-campaign-id"]).toBe("camp-1");
    expect(headers["x-brand-id"]).toBe("brand-2");
    expect(headers["x-workflow-slug"]).toBe("wf-3");
  });

  it("throws BillingError with statusCode on HTTP error from billing-service", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const { authorizeCredits, BillingError } = await loadModule();
    try {
      await authorizeCredits({
        items: [{ costName: "claude-sonnet-4-6-tokens-input", quantity: 500 }],
        description: "chat — claude-sonnet-4-6",
        orgId: "org-123",
        userId: "user-456",
        runId: "run-789",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingError);
      expect((err as InstanceType<typeof BillingError>).statusCode).toBe(500);
      expect((err as InstanceType<typeof BillingError>).isClientError).toBe(false);
    }
  });

  it("throws BillingError with isClientError=true on 400 from billing-service", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"error":"x-org-id must be a valid UUID"}'),
    });

    const { authorizeCredits, BillingError } = await loadModule();
    try {
      await authorizeCredits({
        items: [{ costName: "claude-sonnet-4-6-tokens-input", quantity: 500 }],
        description: "chat — claude-sonnet-4-6",
        orgId: "platform",
        userId: "user-456",
        runId: "run-789",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingError);
      expect((err as InstanceType<typeof BillingError>).statusCode).toBe(400);
      expect((err as InstanceType<typeof BillingError>).isClientError).toBe(true);
      expect((err as InstanceType<typeof BillingError>).upstreamBody).toContain("x-org-id must be a valid UUID");
    }
  });

  it("throws on network error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    const { authorizeCredits } = await loadModule();
    await expect(
      authorizeCredits({
        items: [{ costName: "claude-sonnet-4-6-tokens-input", quantity: 500 }],
        description: "chat — claude-sonnet-4-6",
        orgId: "org-123",
        userId: "user-456",
        runId: "run-789",
      }),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("throws when BILLING_SERVICE_API_KEY is not set", async () => {
    delete process.env.BILLING_SERVICE_API_KEY;

    const { authorizeCredits } = await loadModule();
    await expect(
      authorizeCredits({
        items: [{ costName: "claude-sonnet-4-6-tokens-input", quantity: 500 }],
        description: "chat — claude-sonnet-4-6",
        orgId: "org-123",
        userId: "user-456",
        runId: "run-789",
      }),
    ).rejects.toThrow(/BILLING_SERVICE_API_KEY is required/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses default BILLING_SERVICE_URL when not set", async () => {
    delete process.env.BILLING_SERVICE_URL;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ sufficient: true, balance_cents: 1000, required_cents: 10 }),
    });

    const { authorizeCredits } = await loadModule();
    await authorizeCredits({
      items: [{ costName: "claude-sonnet-4-6-tokens-input", quantity: 500 }],
      description: "chat — claude-sonnet-4-6",
      orgId: "org-123",
      userId: "user-456",
      runId: "run-789",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://billing.mcpfactory.org/v1/credits/authorize",
      expect.anything(),
    );
  });
});
