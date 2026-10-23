import type { Request } from "express";
import { RunsServiceError } from "./runs-client.js";

/**
 * A platform call (`/internal/platform-complete`, `/internal/platform-judgments`)
 * may be made ON BEHALF of a caller's run: the caller sends that run's id in
 * `x-run-id`, and the platform run chat-service opens becomes its child, so the
 * spend rolls into the caller's subtree and reaches the outcome the caller
 * declares (COST-ACCOUNTING-1023). Who pays does not change: the run stays
 * platform-billed. No header = a root platform run, exactly as before.
 *
 * chat-service produces no outcome of its own here and never declares one.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParentRunRead =
  | { ok: true; parentRunId: string | undefined }
  | { ok: false; status: 400; body: { error: string; retryable: false } };

export function readPlatformParentRunId(req: Request): ParentRunRead {
  const raw = req.headers["x-run-id"];
  if (raw === undefined) return { ok: true, parentRunId: undefined };
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    return {
      ok: false,
      status: 400,
      body: { error: "x-run-id must be the UUID of the caller's run (or omitted)", retryable: false },
    };
  }
  return { ok: true, parentRunId: raw };
}

/**
 * The response for a platform run runs-service would not create. A 4xx while a
 * parent was named means runs-service refused THAT parent (unknown run): the
 * caller sent a wrong id, retrying will not help, so it is a 400 carrying
 * runs-service's words. Everything else stays the retryable 502 it always was.
 */
export function platformRunCreateFailure(
  err: unknown,
  parentRunId: string | undefined,
): { status: 400 | 502; body: Record<string, unknown> } {
  if (parentRunId && err instanceof RunsServiceError && err.status >= 400 && err.status < 500) {
    return {
      status: 400,
      body: {
        error: `runs-service refused x-run-id "${parentRunId}" as the parent run`,
        detail: err.body,
        retryable: false,
      },
    };
  }
  return {
    status: 502,
    body: { error: "Service temporarily unavailable (run tracking). Please try again." },
  };
}
