import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import express from "express";

/**
 * Tests for the graceful shutdown logic.
 *
 * Rather than spawning the real server (which needs a database), we replicate
 * the shutdown wiring from src/index.ts on a lightweight Express server to
 * verify the behaviour in isolation.
 */

function wireShutdown(server: http.Server, drainTimeoutMs: number) {
  const logs: string[] = [];

  const shutdown = (signal: string) => {
    logs.push(`[shutdown] Received ${signal}, draining connections…`);
    server.close(() => {
      logs.push("[shutdown] All connections closed, exiting.");
    });

    setTimeout(() => {
      logs.push("[shutdown] Drain timeout reached, forcing exit.");
    }, drainTimeoutMs).unref();
  };

  return { shutdown, logs };
}

describe("graceful shutdown", () => {
  let server: http.Server;

  afterEach(() => {
    try {
      server?.close();
    } catch {
      /* already closed */
    }
  });

  it("closes idle server immediately and logs drain message", async () => {
    const app = express();
    app.get("/health", (_req, res) => res.json({ status: "ok" }));

    server = app.listen(0); // random port
    const { shutdown, logs } = wireShutdown(server, 5_000);

    // Trigger shutdown
    shutdown("SIGTERM");

    // Wait a tick for server.close callback
    await new Promise((r) => setTimeout(r, 50));

    expect(logs).toContain("[shutdown] Received SIGTERM, draining connections…");
    expect(logs).toContain("[shutdown] All connections closed, exiting.");
  });

  it("waits for in-flight SSE connections before closing", async () => {
    const app = express();

    // Simulate an SSE endpoint that stays open
    let sseRes: express.Response | null = null;
    app.get("/stream", (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: hello\n\n");
      sseRes = res;
    });

    server = app.listen(0);
    const addr = server.address() as { port: number };
    const { shutdown, logs } = wireShutdown(server, 5_000);

    // Open an SSE connection
    const clientReq = http.get(`http://127.0.0.1:${addr.port}/stream`);
    await new Promise<void>((resolve) => {
      clientReq.on("response", () => resolve());
    });

    // Trigger shutdown — server should NOT close yet because the SSE stream is open
    shutdown("SIGTERM");
    await new Promise((r) => setTimeout(r, 50));

    expect(logs).toContain("[shutdown] Received SIGTERM, draining connections…");
    expect(logs).not.toContain("[shutdown] All connections closed, exiting.");

    // Now close the SSE stream and destroy client socket — server should finish draining
    sseRes!.end();
    clientReq.destroy();
    await new Promise((r) => setTimeout(r, 100));

    expect(logs).toContain("[shutdown] All connections closed, exiting.");
  });

  it("force-exits after drain timeout when connections hang", async () => {
    vi.useFakeTimers();

    const app = express();
    let sseRes: express.Response | null = null;
    app.get("/stream", (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: hello\n\n");
      sseRes = res;
    });

    server = app.listen(0);
    const addr = server.address() as { port: number };
    const { shutdown, logs } = wireShutdown(server, 5_000);

    // Open a hanging SSE connection
    const clientReq = http.get(`http://127.0.0.1:${addr.port}/stream`);
    await vi.advanceTimersByTimeAsync(50);

    // Trigger shutdown
    shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(50);

    expect(logs).toContain("[shutdown] Received SIGTERM, draining connections…");
    expect(logs).not.toContain("[shutdown] All connections closed, exiting.");

    // Advance past drain timeout
    await vi.advanceTimersByTimeAsync(5_000);

    expect(logs).toContain("[shutdown] Drain timeout reached, forcing exit.");

    // Cleanup
    clientReq.destroy();
    sseRes?.end();
    vi.useRealTimers();
  });
});
