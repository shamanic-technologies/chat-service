import { describe, it, expect } from "vitest";
import express from "express";
import http from "http";

/**
 * Regression test for PayloadTooLargeError.
 *
 * The default Express body-parser limit is 100kb, which is too small for
 * vision requests that include large system prompts, conversation history,
 * or imageContext fields. This caused 100% of /complete vision calls to fail
 * silently with 413 PayloadTooLargeError.
 *
 * Fix: express.json({ limit: "10mb" }) in src/index.ts.
 */

function createTestApp(limit?: string) {
  const app = express();
  app.use(express.json(limit ? { limit } : {}));
  app.post("/echo", (req, res) => {
    res.json({ size: JSON.stringify(req.body).length });
  });
  return app;
}

function postJSON(
  server: http.Server,
  body: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") return reject(new Error("no address"));
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path: "/echo", method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

function listenOnRandomPort(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

describe("body-parser limit", () => {
  it("rejects >100kb payload with default Express limit", async () => {
    const app = createTestApp(); // default 100kb
    const server = await listenOnRandomPort(app);
    try {
      const largePayload = JSON.stringify({ data: "x".repeat(200_000) });
      const res = await postJSON(server, largePayload);
      expect(res.status).toBe(413);
    } finally {
      server.close();
    }
  });

  it("accepts >100kb payload with 10mb limit (the fix)", async () => {
    const app = createTestApp("10mb");
    const server = await listenOnRandomPort(app);
    try {
      const largePayload = JSON.stringify({ data: "x".repeat(200_000) });
      const res = await postJSON(server, largePayload);
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("accepts 1mb payload with 10mb limit", async () => {
    const app = createTestApp("10mb");
    const server = await listenOnRandomPort(app);
    try {
      const largePayload = JSON.stringify({ data: "x".repeat(1_000_000) });
      const res = await postJSON(server, largePayload);
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
