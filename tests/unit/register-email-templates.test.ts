import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerEmailTemplates,
  CHAT_SERVICE_EMAIL_TEMPLATES,
} from "../../src/lib/register-email-templates.js";
import {
  CHAT_SERVICE_APP_ID,
  VENDOR_OUT_OF_CREDIT_EVENT,
} from "../../src/lib/vendor-credit-alert.js";

describe("registerEmailTemplates", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  });

  it("owns exactly the out-of-credit template", () => {
    expect(CHAT_SERVICE_EMAIL_TEMPLATES.map((t) => t.name)).toEqual([VENDOR_OUT_OF_CREDIT_EVENT]);
  });

  it("names the vendor in the subject, from send-time metadata", () => {
    const [template] = CHAT_SERVICE_EMAIL_TEMPLATES;
    expect(template.subject).toContain("{{vendor}}");
    expect(template.htmlBody).toContain("{{vendor}}");
    expect(template.textBody).toContain("{{vendor}}");
  });

  it("upserts under this service's appId", async () => {
    process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ templates: [] }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await registerEmailTemplates();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/templates$/);
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string);
    expect(body.appId).toBe(CHAT_SERVICE_APP_ID);
    expect(body.templates).toHaveLength(1);
  });

  it("skips silently when the API key is absent", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(registerEmailTemplates()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when registration fails — boot must not depend on it", async () => {
    process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-key";
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(registerEmailTemplates()).resolves.toBeUndefined();
  });
});
