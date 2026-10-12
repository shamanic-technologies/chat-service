import type { Response } from "express";

/**
 * Holds every byte of an SSE response until `open()`, so the status code is
 * still free to change. /chat streams with a 200 the moment the first byte is
 * written; holding until the turn's first billing check lets a refusal for lack
 * of money still answer an HTTP 402 to a caller that reads statuses (an AI
 * agent on the API), while every other turn streams exactly what it streamed
 * before, just from the first check on.
 *
 * - `open()`: send the headers and the held bytes, then write through. Idempotent.
 * - `end()` on the response while held opens it first (every early-return
 *   error path keeps its SSE answer).
 * - `discard()`: drop the held bytes and the SSE headers, give the response
 *   back untouched so the caller can answer JSON with any status.
 */
export interface HeldSse {
  open(): void;
  isOpen(): boolean;
  discard(): void;
}

const SSE_HEADERS = ["Content-Type", "Cache-Control", "Connection", "X-Accel-Buffering"];

export function holdSseUntilOpen(res: Response): HeldSse {
  const write = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => Response;
  const held: unknown[] = [];
  let state: "held" | "open" | "discarded" = "held";

  const restore = () => {
    res.write = write as Response["write"];
    res.end = end as Response["end"];
  };

  const open = () => {
    if (state !== "held") return;
    state = "open";
    restore();
    res.flushHeaders();
    for (const chunk of held) write(chunk);
    held.length = 0;
  };

  res.write = ((chunk: unknown) => {
    held.push(chunk);
    return true;
  }) as Response["write"];
  res.end = ((...args: unknown[]) => {
    open();
    return end(...args);
  }) as Response["end"];

  return {
    open,
    isOpen: () => state === "open",
    discard: () => {
      if (state !== "held") return;
      state = "discarded";
      restore();
      held.length = 0;
      for (const h of SSE_HEADERS) res.removeHeader(h);
    },
  };
}
