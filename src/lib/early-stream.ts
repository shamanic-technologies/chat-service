import type { Response } from "express";
import type { HeldSse } from "./held-sse.js";

// ---------------------------------------------------------------------------
// The Copilot answers within seconds, even behind a running turn
// (COPILOT-LATENCY-1125, owner 2026-11-25 « Pourquoi il prend plus que 5s pour
// répondre? »).
//
// Prod 2026-11-25: a turn took 4 minutes; the person opened a new chat and asked
// again. That request waited behind the first turn (turn-queue.ts) with ZERO
// bytes sent, because /chat holds its SSE bytes until the turn's first billing
// check (held-sse.ts, for the agent org's HTTP 402). Cloudflare cut it at 100 s
// and the person read Cloudflare's 524 page as the Copilot's answer.
//
// Now, EARLY_OPEN_MS after the request, a turn that has sent nothing opens its
// stream and says what it is doing (a reasoning part the dashboard already
// draws), then a comment line every HEARTBEAT_MS keeps the connection alive.
// Held only for an org an AI agent opened through the API (billing's
// `agent_api` mark): its 402 needs the status line free, so it keeps the hold.
// A request answered with JSON after the stream opened (a refusal) is told as an
// SSE `error` event, the only shape the open stream can still carry.
// ---------------------------------------------------------------------------

/** A request answered (or refused) within this time keeps its plain HTTP status. */
export const EARLY_OPEN_MS = 2_000;
/** Below Cloudflare's 100 s idle cut, with room. */
export const HEARTBEAT_MS = 15_000;

/** What the person reads while the turn has nothing of its own to show yet (a reasoning part). */
export const WAITING_BEHIND_TURN_TEXT = "Answering your previous message first.";
export const READING_ACCOUNT_TEXT = "Reading your account.";

export interface EarlyStreamOptions {
  /** True while this request waits for an earlier turn of the same person. */
  waitingBehindTurn: () => boolean;
  /** True when the org must keep its HTTP 402 (billing's `agent_api` mark): never opened early. */
  keepsHttp402: () => Promise<boolean>;
  openAfterMs?: number;
  heartbeatMs?: number;
}

export interface EarlyStream {
  /** handleChatTurn's hold, so an early open sends what it holds. */
  registerHold(hold: HeldSse): void;
  /** When the first byte left, the first answer text left (ms since the request), for the latency log. */
  timings(): { firstByteMs: number | null; firstTextMs: number | null; openedEarly: boolean };
  stop(): void;
}

const SSE_HEADERS: Array<[string, string]> = [
  ["Content-Type", "text/event-stream"],
  ["Cache-Control", "no-cache"],
  ["Connection", "keep-alive"],
  ["X-Accel-Buffering", "no"],
];

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function startEarlyStream(res: Response, opts: EarlyStreamOptions): EarlyStream {
  const startedAt = Date.now();
  let firstByteMs: number | null = null;
  let firstTextMs: number | null = null;
  let openedEarly = false;
  let hold: HeldSse | null = null;
  let stopped = false;

  // Underneath any hold: sees only bytes that really leave.
  const rawWrite = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    const ms = Date.now() - startedAt;
    if (firstByteMs === null) firstByteMs = ms;
    if (firstTextMs === null && typeof chunk === "string" && chunk.includes('"type":"token"')) firstTextMs = ms;
    return rawWrite(chunk, ...rest);
  }) as Response["write"];

  const live = () => !stopped && !res.destroyed && !res.writableEnded;

  const open = async () => {
    if (!live() || res.headersSent || (hold && hold.isOpen())) return;
    let keeps402 = false;
    try {
      keeps402 = await opts.keepsHttp402();
    } catch (err) {
      // Same choice as the out-of-credits path: unreadable = the in-chat answer.
      console.error("[early-stream] agent org mark unreadable, opening the stream:", err);
    }
    if (keeps402 || !live() || res.headersSent || (hold && hold.isOpen())) return;
    openedEarly = true;
    if (hold) {
      hold.open();
    } else {
      for (const [name, value] of SSE_HEADERS) res.setHeader(name, value);
      res.status(200);
      res.flushHeaders();
      // A JSON answer after this point (a refusal) can only travel as an SSE event now.
      res.json = ((body: unknown) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const message = typeof b.error === "string" ? b.error : typeof b.message === "string" ? b.message : "The request was refused.";
        if (live()) {
          res.write(sse({ type: "error", code: "request_refused", message, status: res.statusCode }));
          res.write(sse("[DONE]"));
          res.end();
        }
        return res;
      }) as Response["json"];
    }
    const text = opts.waitingBehindTurn() ? WAITING_BEHIND_TURN_TEXT : READING_ACCOUNT_TEXT;
    res.write(sse({ type: "thinking_start", status: true }));
    res.write(sse({ type: "thinking_delta", thinking: text, status: true }));
    res.write(sse({ type: "thinking_stop", status: true }));
  };

  const openTimer = setTimeout(() => void open(), opts.openAfterMs ?? EARLY_OPEN_MS);
  const beat = setInterval(() => {
    if (!live()) return;
    if (res.headersSent && (!hold || hold.isOpen())) rawWrite(": keep-alive\n\n");
  }, opts.heartbeatMs ?? HEARTBEAT_MS);

  const stop = () => {
    stopped = true;
    clearTimeout(openTimer);
    clearInterval(beat);
  };
  res.on("close", stop);
  res.on("finish", stop);

  return {
    registerHold: (h) => {
      hold = h;
    },
    timings: () => ({ firstByteMs, firstTextMs, openedEarly }),
    stop,
  };
}
