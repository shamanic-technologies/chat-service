import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { trackServer, DRAIN_TIMEOUT_MS, PREVIOUS_PROCESS_DRAIN_MS } from "../../src/lib/graceful-drain.js";

// GLM-FLASH-502-1125 part 2: a draining chat-service keeps answering (never refuses),
// finishes its long calls, closes each socket after its answer, then exits.

let server: http.Server | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

function start(handler: http.RequestListener) {
  server = http.createServer(handler);
  const stops: string[] = [];
  const tracker = trackServer(server, [() => stops.push("stopped")]);
  return new Promise<{ port: number; tracker: typeof tracker; stops: string[] }>((resolve) =>
    server!.listen(0, "127.0.0.1", () => resolve({ port: (server!.address() as AddressInfo).port, tracker, stops })),
  );
}

function get(port: number, path: string, agent: http.Agent): Promise<{ status: number; body: string; connection: string | undefined }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, agent }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, connection: res.headers.connection }));
      })
      .on("error", reject);
  });
}

const slowHandler: http.RequestListener = (req, res) => {
  const ms = Number(new URL(req.url ?? "/", "http://x").searchParams.get("ms") ?? 0);
  setTimeout(() => res.end("ok"), ms);
};

describe("graceful drain", () => {
  it("covers the longest /complete call (~280 s) and a new process waits past it", () => {
    expect(DRAIN_TIMEOUT_MS).toBeGreaterThanOrEqual(290_000);
    expect(PREVIOUS_PROCESS_DRAIN_MS).toBeGreaterThan(DRAIN_TIMEOUT_MS);
  });

  it("finishes a call in flight, answers a NEW connection during the drain, then ends idle", async () => {
    const { port, tracker, stops } = await start(slowHandler);
    const agent = new http.Agent({ keepAlive: true });
    const long = get(port, "/?ms=300", agent);
    await new Promise((r) => setTimeout(r, 50));
    expect(tracker.inFlight()).toBe(1);

    const drained = tracker.drain({ checkEveryMs: 10 });
    expect(stops).toEqual(["stopped"]);

    // The old code called server.close() here: this connection was refused.
    const fresh = await get(port, "/?ms=0", new http.Agent({ keepAlive: true }));
    expect(fresh.status).toBe(200);
    expect(fresh.connection).toBe("close");

    const first = await long;
    expect(first.status).toBe(200);
    expect(first.connection).toBe("close");
    expect(await drained).toBe("idle");
    expect(tracker.openSockets()).toBe(0);
    agent.destroy();
  });

  it("keeps the keep-alive answer before the drain", async () => {
    const { port } = await start(slowHandler);
    const agent = new http.Agent({ keepAlive: true });
    const r = await get(port, "/", agent);
    expect(r.connection).toBe("keep-alive");
    agent.destroy();
  });

  it("ends at the timeout while a call is still running", async () => {
    const { port, tracker } = await start(slowHandler);
    const agent = new http.Agent({ keepAlive: true });
    const hung = get(port, "/?ms=5000", agent).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    expect(await tracker.drain({ timeoutMs: 100, checkEveryMs: 10 })).toBe("timeout");
    expect(tracker.inFlight()).toBe(1);
    agent.destroy();
    await hung;
  });

  it("is idempotent", async () => {
    const { tracker, stops } = await start(slowHandler);
    const a = tracker.drain({ checkEveryMs: 10 });
    const b = tracker.drain({ checkEveryMs: 10 });
    expect(a).toBe(b);
    await a;
    expect(stops).toEqual(["stopped"]);
  });
});
