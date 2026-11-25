/**
 * A deploy never cuts a call this process is serving (GLM-FLASH-502-1125, part 2).
 *
 * The box swaps chat-service blue-green (deploy.sh `deploy_blue_green`): the new
 * container starts BESIDE this one, new connections to this container's address are
 * sent to the new one, then this process gets SIGTERM. From then on it:
 *   - keeps LISTENING (a connection that still reaches it is answered, never refused:
 *     callers such as workflow-service do not retry a refused /complete),
 *   - answers every request with `Connection: close`, so callers drop the keep-alive
 *     sockets they pooled to it,
 *   - stops its own background writers (`onDrain`): the new process owns them now,
 *   - exits once no socket is open (Node closes idle keep-alive sockets after
 *     `keepAliveTimeout`), or at `DRAIN_TIMEOUT_MS`, which covers the longest
 *     /complete call (Z.ai reasoning, ~280 s measured).
 *
 * The OLD behaviour (`server.close()` at SIGTERM, 25 s, compose grace 10 s) refused
 * every new connection during the drain and killed every call older than 10 s.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

/** Longest a draining process waits for its calls. compose `stop_grace_period` and deploy.sh `docker stop -t` sit above it. */
export const DRAIN_TIMEOUT_MS = 300_000;
/** A new process waits this long before treating the previous process's unfinished rows as cut: the previous one may still be finishing them. */
export const PREVIOUS_PROCESS_DRAIN_MS = DRAIN_TIMEOUT_MS + 30_000;
const CHECK_EVERY_MS = 250;

export interface DrainTracker {
  /** Requests being answered right now. */
  inFlight(): number;
  /** Sockets open right now (busy or idle keep-alive). */
  openSockets(): number;
  draining(): boolean;
  /** Starts the drain; resolves with why it ended. Idempotent. */
  drain(opts?: { timeoutMs?: number; checkEveryMs?: number }): Promise<"idle" | "timeout">;
}

export function trackServer(server: Server, onDrain: Array<() => void> = []): DrainTracker {
  const sockets = new Set<Socket>();
  let isDraining = false;
  let done: Promise<"idle" | "timeout"> | null = null;

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // Runs before the app's handler: the keep-alive decision must be made before headers go out.
  const answering = new Set<ServerResponse>();
  server.prependListener("request", (_req: IncomingMessage, res: ServerResponse) => {
    answering.add(res);
    const end = () => answering.delete(res);
    res.once("finish", end);
    res.once("close", end);
    if (isDraining) res.shouldKeepAlive = false;
  });

  return {
    inFlight: () => answering.size,
    openSockets: () => sockets.size,
    draining: () => isDraining,
    drain(opts = {}) {
      if (done) return done;
      isDraining = true;
      // A call already being answered closes its socket after its answer, when its headers are still ours to set.
      for (const res of answering) if (!res.headersSent) res.shouldKeepAlive = false;
      for (const stop of onDrain) {
        try { stop(); } catch (err) { console.error("[shutdown] a background writer failed to stop:", err); }
      }
      const timeoutMs = opts.timeoutMs ?? DRAIN_TIMEOUT_MS;
      const started = Date.now();
      done = new Promise((resolve) => {
        const timer = setInterval(() => {
          if (sockets.size === 0) {
            clearInterval(timer);
            resolve("idle");
          } else if (Date.now() - started >= timeoutMs) {
            clearInterval(timer);
            resolve("timeout");
          }
        }, opts.checkEveryMs ?? CHECK_EVERY_MS);
      });
      return done;
    },
  };
}
