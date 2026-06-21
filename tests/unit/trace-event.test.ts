import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.RUNS_SERVICE_API_KEY = "test-runs-key";
  process.env.RUNS_SERVICE_URL = "https://runs.test.local";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

async function loadModule() {
  vi.resetModules();
  return import("../../src/lib/trace-event.js");
}

const identity = { orgId: "org-uuid-123", userId: "user-uuid-456" };
const tracking = {
  brandId: "brand-1",
  campaignId: "camp-1",
  workflowSlug: "wf-1",
  featureSlug: "ft-1",
  audienceId: "aud-1",
};

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("traceEvent — happy path", () => {
  it("POSTs to /v1/runs/{runId}/events with correct method and URL", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    });

    const { traceEvent } = await loadModule();
    traceEvent("run-1", "stream-start", identity, {});
    await flushAsync();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://runs.test.local/v1/runs/run-1/events");
    expect(init.method).toBe("POST");
  });

  it("body always includes service and event", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    });

    const { traceEvent } = await loadModule();
    traceEvent("run-1", "llm-call-start", identity, {});
    await flushAsync();

    const body = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body.service).toBe("chat-service");
    expect(body.event).toBe("llm-call-start");
  });
});

describe("traceEvent — header forwarding", () => {
  it("forwards identity headers and api key", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    });

    const { traceEvent } = await loadModule();
    traceEvent("run-1", "stream-start", identity, {});
    await flushAsync();

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers["x-api-key"]).toBe("test-runs-key");
    expect(headers["x-org-id"]).toBe("org-uuid-123");
    expect(headers["x-user-id"]).toBe("user-uuid-456");
    expect(headers["x-run-id"]).toBe("run-1");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("forwards tracking headers when provided", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    });

    const { traceEvent } = await loadModule();
    traceEvent("run-1", "stream-start", identity, tracking);
    await flushAsync();

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers["x-brand-id"]).toBe("brand-1");
    expect(headers["x-campaign-id"]).toBe("camp-1");
    expect(headers["x-workflow-slug"]).toBe("wf-1");
    expect(headers["x-feature-slug"]).toBe("ft-1");
    expect(headers["x-audience-id"]).toBe("aud-1");
  });

  it("omits tracking headers that are absent", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    });

    const { traceEvent } = await loadModule();
    traceEvent("run-1", "stream-start", identity, { brandId: "brand-1" });
    await flushAsync();

    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers["x-brand-id"]).toBe("brand-1");
    expect(headers).not.toHaveProperty("x-campaign-id");
    expect(headers).not.toHaveProperty("x-workflow-slug");
    expect(headers).not.toHaveProperty("x-feature-slug");
    expect(headers).not.toHaveProperty("x-audience-id");
  });
});

describe("traceEvent — optional fields", () => {
  it("includes detail, level, and data when provided", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    });

    const { traceEvent } = await loadModule();
    traceEvent("run-1", "llm-call-failed", identity, {}, {
      detail: "timeout",
      level: "error",
      data: { provider: "anthropic", attempt: 2 },
    });
    await flushAsync();

    const body = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body.detail).toBe("timeout");
    expect(body.level).toBe("error");
    expect(body.data).toEqual({ provider: "anthropic", attempt: 2 });
  });

  it("omits detail, level, and data when absent", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    });

    const { traceEvent } = await loadModule();
    traceEvent("run-1", "stream-start", identity, {});
    await flushAsync();

    const body = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body).not.toHaveProperty("detail");
    expect(body).not.toHaveProperty("level");
    expect(body).not.toHaveProperty("data");
  });
});

describe("traceEvent — missing API key", () => {
  it("skips fetch and does not throw when RUNS_SERVICE_API_KEY is unset", async () => {
    delete process.env.RUNS_SERVICE_API_KEY;

    const { traceEvent } = await loadModule();
    expect(() =>
      traceEvent("run-1", "stream-start", identity, tracking),
    ).not.toThrow();
    await flushAsync();

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("traceEvent — error swallowing (fire-and-forget)", () => {
  it("does not throw when fetch rejects", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ECONNREFUSED"),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { traceEvent } = await loadModule();
    expect(() =>
      traceEvent("run-1", "stream-start", identity, {}),
    ).not.toThrow();
    await flushAsync();

    expect(fetch).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not throw on HTTP non-ok response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { traceEvent } = await loadModule();
    expect(() =>
      traceEvent("run-1", "stream-start", identity, {}),
    ).not.toThrow();
    await flushAsync();

    expect(fetch).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
