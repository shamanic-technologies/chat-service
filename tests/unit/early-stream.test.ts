import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { startEarlyStream, WAITING_BEHIND_TURN_TEXT, READING_ACCOUNT_TEXT } from "../../src/lib/early-stream.js";
import { holdSseUntilOpen } from "../../src/lib/held-sse.js";
import { oneTurnAtATime, turnRunning } from "../../src/lib/turn-queue.js";

// COPILOT-LATENCY-1125 (prod 2026-11-25): a second message waited behind a 4-minute
// turn with zero bytes sent; Cloudflare cut it at 100 s (524). These pin the first
// bytes within seconds, the answer after, and the agent org's HTTP 402 kept.

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

function serve(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    server = app.listen(0, () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
  });
}

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** A /chat-shaped route: queue per person, hold until the "billing check", then answer. */
function chatApp(opts: { turnMs: number; agentOrg?: boolean; refuse402?: boolean }) {
  const app = express();
  app.post("/chat", async (_req, res) => {
    const key = "person:org:user";
    let waiting = turnRunning(key);
    const early = startEarlyStream(res, {
      waitingBehindTurn: () => waiting,
      keepsHttp402: async () => opts.agentOrg === true,
      openAfterMs: 50,
      heartbeatMs: 1_000,
    });
    try {
      await oneTurnAtATime(key, async () => {
        waiting = false;
        if (!res.headersSent) res.setHeader("Content-Type", "text/event-stream");
        const hold = holdSseUntilOpen(res);
        early.registerHold(hold);
        await new Promise((r) => setTimeout(r, opts.turnMs));
        if (opts.refuse402 && !hold.isOpen()) {
          hold.discard();
          res.status(402).json({ error: "Insufficient credits" });
          return;
        }
        hold.open();
        res.write(sse({ type: "token", content: "Here is the answer." }));
        res.write(sse("[DONE]"));
        res.end();
      });
    } finally {
      early.stop();
    }
  });
  return app;
}

async function firstChunk(url: string): Promise<{ status: number; ms: number; first: string; all: Promise<string> }> {
  const t0 = Date.now();
  const res = await fetch(`${url}/chat`, { method: "POST" });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const { value } = await reader.read();
  const ms = Date.now() - t0;
  const first = dec.decode(value);
  const all = (async () => {
    let text = first;
    for (;;) {
      const r = await reader.read();
      if (r.done) return text;
      text += dec.decode(r.value);
    }
  })();
  return { status: res.status, ms, first, all };
}

describe("early stream (COPILOT-LATENCY-1125)", () => {
  it("a second message behind a running turn gets its first bytes at once, then its answer", async () => {
    const url = await serve(chatApp({ turnMs: 800 }));
    const firstTurn = fetch(`${url}/chat`, { method: "POST" }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 20));
    const second = await firstChunk(url);
    expect(second.status).toBe(200);
    expect(second.ms).toBeLessThan(5_000);
    expect(second.ms).toBeLessThan(700); // well before the first turn ends
    expect(second.first + (await second.all)).toContain(WAITING_BEHIND_TURN_TEXT);
    expect(await second.all).toContain("Here is the answer.");
    expect(await firstTurn).toContain("Here is the answer.");
  });

  it("a slow turn with nobody ahead says it is reading the account, before the answer", async () => {
    const url = await serve(chatApp({ turnMs: 400 }));
    const r = await firstChunk(url);
    expect(r.ms).toBeLessThan(350);
    const all = await r.all;
    expect(all).toContain(READING_ACCOUNT_TEXT);
    expect(all.indexOf(READING_ACCOUNT_TEXT)).toBeLessThan(all.indexOf("Here is the answer."));
  });

  it("an agent org keeps its hold, so a refusal for money is still an HTTP 402", async () => {
    const url = await serve(chatApp({ turnMs: 200, agentOrg: true, refuse402: true }));
    const res = await fetch(`${url}/chat`, { method: "POST" });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "Insufficient credits" });
  });

  it("a JSON refusal after the stream opened reaches the client as an SSE error", async () => {
    const app = express();
    app.post("/chat", async (_req, res) => {
      const early = startEarlyStream(res, { waitingBehindTurn: () => true, keepsHttp402: async () => false, openAfterMs: 20 });
      await new Promise((r) => setTimeout(r, 120));
      res.status(404).json({ error: "Session not found" });
      early.stop();
    });
    const url = await serve(app);
    const res = await fetch(`${url}/chat`, { method: "POST" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"code":"request_refused"');
    expect(text).toContain("Session not found");
    expect(text).toContain('data: "[DONE]"');
  });
});
